import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { analyseInputs, createProvider, loadAiConfig } from '@smartdesk/ai-analysis';
import {
  AI_JOB_PATH,
  AI_JOB_SCOPES,
  recordRecommendationCommandV1Schema,
} from '@smartdesk/contracts';
import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { createTicketJobs } from '../src/ticketJobs.js';

const ticketId = '00000000-0000-4000-8000-000000000001';
const jobId = '00000000-0000-4000-8000-000000000002';
const requestId = '00000000-0000-4000-8000-000000000003';
const leaseToken = '00000000-0000-4000-8000-000000000004';
const categoryId = '00000000-0000-4000-8000-000000000005';
const teamId = '00000000-0000-4000-8000-000000000006';
const identity = { schemaVersion: 1, ticketId, jobId, requestId, leaseToken };

test('signs scoped requests and resends only the same completion after a lost response', async (t) => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const calls: string[] = [];
  const completions: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      const operation = req.url?.slice(AI_JOB_PATH.length + 1);
      assert.ok(operation === 'claim' || operation === 'inputs' || operation === 'complete');
      assert.equal(req.method, 'POST');
      const { payload, protectedHeader } = await jwtVerify(
        req.headers.authorization!.slice('Bearer '.length),
        pair.publicKey,
        {
          audience: 'smartdesk-ticket',
          issuer: 'smartdesk-internal',
          subject: 'ai',
          typ: 'smartdesk-service+jwt',
        },
      );
      assert.equal(protectedHeader.kid, 'ai-test');
      assert.equal(payload.scope, AI_JOB_SCOPES[operation]);
      assert.deepEqual(payload.actor, { kind: 'system' });
      calls.push(operation);

      if (operation === 'claim') {
        res.end(JSON.stringify({ ...identity, attempts: 1 }));
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk.toString();
      assert.equal(req.headers['x-request-id'], requestId);
      if (operation === 'inputs') {
        assert.deepEqual(JSON.parse(body), identity);
        res.end(
          JSON.stringify({
            schemaVersion: 1,
            ticket: { title: 'VPN drops', description: 'VPN cannot connect' },
            allowedCategories: [{ id: categoryId, name: 'Network' }],
            allowedTeams: [{ id: teamId, name: 'Network' }],
            articles: [],
            retrieval: { engine: 'postgres', version: 1 },
          }),
        );
        return;
      }
      completions.push(recordRecommendationCommandV1Schema.parse(JSON.parse(body)));
      if (completions.length === 1) req.socket.destroy();
      else res.writeHead(204).end();
    } catch {
      res.writeHead(400).end();
    }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  });
  const jobs = await createTicketJobs({
    origin: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    kid: 'ai-test',
    privateKey: await exportPKCS8(pair.privateKey),
    timeoutMs: 5000,
  });
  const job = await jobs.claim();
  assert.ok(job);
  const provider = createProvider(loadAiConfig({ AI_PROVIDER: 'fake' }));
  const draft = await analyseInputs(provider, await jobs.inputs(job));
  assert.equal(await jobs.complete(job, draft), true);
  assert.deepEqual(calls, ['claim', 'inputs', 'complete', 'complete']);
  assert.deepEqual(completions[0], completions[1]);
  assert.deepEqual(completions[0], {
    ...identity,
    promptVersion: 'v2',
    draft: {
      categoryId,
      teamId,
      priority: draft.priority,
      troubleshooting: draft.troubleshooting,
      confidence: draft.confidence,
      citedArticleIds: [],
      modelVersion: draft.modelVersion,
    },
  });
});
