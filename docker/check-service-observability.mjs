import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const hash = (id) => createHash('sha256').update(id).digest('hex');
const [start, end] = process.argv.slice(2).map(Number);
assert.ok(start > 0 && end > start, 'Expected a bounded measurement window');

const output = readFileSync(0, 'utf8');
for (const privateValue of [
  'SD099_PRIVATE_TICKET_DETAIL',
  'SD099_PRIVATE_BEARER',
  'SD099_PRIVATE_COOKIE',
  'SD099_PRIVATE_QUERY',
  'SD099_FIXTURE_PROVIDER_KEY',
  'SmartDesk-Demo-1!',
  'sd099-create',
  'sd099-review',
  'sd099-ticket-outage',
]) {
  assert.ok(!output.includes(privateValue), 'Private fixture value found in service logs');
}

const records = output
  .split('\n')
  .filter((line) => line.startsWith('{'))
  .map((line) => JSON.parse(line))
  .filter(({ time }) => time >= start && time <= end);
const find = (predicate, description) => {
  const record = records.find(predicate);
  assert.ok(record, description);
  return record;
};
const request = (service, correlationId, status, route) =>
  find(
    (record) =>
      record.event === 'http_request' &&
      record.service === service &&
      record.correlationId === correlationId &&
      record.status === status &&
      (!route || record.route === route),
    `Missing ${service} HTTP ${status} observation`,
  );

const creation = hash('sd099-create');
request('gateway', creation, 201);
request('ticket', creation, 201);
request('identity', creation, 200);
const { ticketId } = find(
  (record) => record.event === 'ticket_created' && record.correlationId === creation,
  'Ticket did not log the committed creation',
);
const { jobId, analysisCorrelationId } = find(
  (record) =>
    record.event === 'analysis_claimed' &&
    record.ticketId === ticketId &&
    record.originCorrelationId === creation,
  'Ticket did not link the durable job to the creation request',
);
assert.match(analysisCorrelationId, /^[a-f0-9]{64}$/);
request('ticket', analysisCorrelationId, 200, '/internal/tickets/analysis-jobs/inputs');
request('ticket', analysisCorrelationId, 204, '/internal/tickets/analysis-jobs/complete');
request('knowledge', analysisCorrelationId, 200);
find(
  (record) =>
    record.service === 'ai' &&
    record.event === 'analysis_job' &&
    record.state === 'COMPLETED' &&
    record.jobId === jobId &&
    record.ticketId === ticketId &&
    record.analysisCorrelationId === analysisCorrelationId,
  'AI did not log the completed job with the same IDs',
);

const review = hash('sd099-review');
request('gateway', review, 200);
request('ticket', review, 200);
const { recommendationId } = find(
  (record) =>
    record.event === 'recommendation_reviewed' &&
    record.ticketId === ticketId &&
    record.correlationId === review,
  'Missing Ticket review observation',
);
const { eventId } = find(
  (record) =>
    record.service === 'notifications' &&
    record.event === 'outbox_delivery' &&
    record.eventType === 'ticket.routed' &&
    record.state === 'COMPLETED' &&
    record.ticketId === ticketId &&
    record.correlationId === review,
  'Notifications did not log the committed review routing event',
);
for (const id of [ticketId, jobId, recommendationId, eventId]) {
  assert.match(id, /^[0-9a-f-]{36}$/);
}

const aiReady = hash('sd099-ai-ready');
request('ai', aiReady, 200, '/health/ready');
request('ticket', aiReady, 200, '/health/ready');
const gatewayOutage = hash('sd099-ticket-outage');
request('gateway', gatewayOutage, 503);
const aiOutage = hash('sd099-ai-outage');
request('ai', aiOutage, 503, '/health/ready');
for (const [service, correlationId, errorKind] of [
  ['gateway', gatewayOutage, 'unreachable'],
  ['ai', aiOutage, 'readiness_failed'],
]) {
  find(
    (record) =>
      record.event === 'dependency_failure' &&
      record.service === service &&
      record.correlationId === correlationId &&
      record.dependency === 'ticket' &&
      record.status === 503 &&
      (record.errorKind === errorKind || (service === 'gateway' && record.errorKind === 'timeout')),
    `${service} did not identify Ticket as the unavailable dependency`,
  );
}

function summarize(samples) {
  assert.ok(samples.length, 'Expected at least one observation');
  const durations = samples.map(({ durationMs }) => durationMs).sort((a, b) => a - b);
  assert.ok(durations.every((duration) => Number.isFinite(duration) && duration >= 0));
  const percentile = (p) => Number(durations[Math.ceil(p * durations.length) - 1].toFixed(2));
  return { count: durations.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
}

const http = {};
for (const service of [
  'gateway',
  'ticket',
  'identity',
  'knowledge',
  'analytics',
  'notifications',
  'ai',
]) {
  const samples = records.filter(
    (record) =>
      record.event === 'http_request' &&
      record.service === service &&
      (service === 'ai' || !record.route.startsWith('/health/')) &&
      !(record.status === 204 && record.route.endsWith('/analysis-jobs/claim')),
  );
  http[service] = {
    ...summarize(samples),
    clientErrors: samples.filter(({ status }) => status >= 400 && status < 500).length,
    serverErrors: samples.filter(({ status }) => status >= 500).length,
  };
}
const completed = (event) =>
  summarize(records.filter((record) => record.event === event && record.state === 'COMPLETED'));
console.log(
  JSON.stringify(
    {
      window: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
      http,
      completedAiAttempts: completed('analysis_job'),
      completedNotificationDeliveries: completed('outbox_delivery'),
      trace: {
        ticketId,
        jobId,
        recommendationId,
        eventId,
        creation,
        analysisCorrelationId,
        review,
      },
    },
    null,
    2,
  ),
);
