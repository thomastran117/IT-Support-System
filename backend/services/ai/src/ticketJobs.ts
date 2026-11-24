import {
  classifyAnalysisFailure,
  PROMPT_VERSION,
  ProviderError,
  type AnalysisDraft,
  type AnalysisFailureKind,
} from '@smartdesk/ai-analysis';
import {
  AI_JOB_PATH,
  AI_JOB_SCOPES,
  analysisInputsV1Schema,
  analysisJobClaimV1Schema,
  recordRecommendationCommandV1Schema,
  type AnalysisJobIdentityV1,
} from '@smartdesk/contracts';
import { importPKCS8, SignJWT } from 'jose';

type Operation = keyof typeof AI_JOB_SCOPES;
type Lease = {
  id: string;
  ticketId: string;
  requestId: string;
  attempts: number;
  leaseToken: string;
};

const identityOf = (job: Lease): AnalysisJobIdentityV1 => ({
  schemaVersion: 1,
  jobId: job.id,
  ticketId: job.ticketId,
  requestId: job.requestId,
  leaseToken: job.leaseToken,
});

class TicketJobError extends Error {
  constructor(readonly kind: AnalysisFailureKind) {
    super('Ticket API could not process an analysis command');
  }
}

export const classifyTicketJobError = (error: unknown) =>
  classifyAnalysisFailure(
    error instanceof TicketJobError || error instanceof ProviderError ? error.kind : 'internal',
  );

export async function createTicketJobs(opts: {
  origin: URL;
  kid: string;
  privateKey: string;
  timeoutMs: number;
}) {
  let key: Awaited<ReturnType<typeof importPKCS8>>;
  try {
    key = await importPKCS8(opts.privateKey, 'ES256');
  } catch {
    throw new Error('AI_SERVICE_PRIVATE_KEY must contain a P-256 PKCS#8 private key');
  }

  async function call<T extends AnalysisJobIdentityV1>(operation: Operation, body?: T) {
    const token = await new SignJWT({ scope: AI_JOB_SCOPES[operation], actor: { kind: 'system' } })
      .setProtectedHeader({ alg: 'ES256', typ: 'smartdesk-service+jwt', kid: opts.kid })
      .setIssuer('smartdesk-internal')
      .setAudience('smartdesk-ticket')
      .setSubject('ai')
      .setIssuedAt()
      .setExpirationTime('30s')
      .sign(key);
    let response: Response;
    try {
      response = await fetch(new URL(`${AI_JOB_PATH}/${operation}`, opts.origin), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json', 'x-request-id': body.requestId } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch {
      throw new TicketJobError('unavailable');
    }
    if (response.ok || response.status === 409) return response;
    await response.body?.cancel();
    if (response.status >= 500 || response.status === 429) throw new TicketJobError('unavailable');
    if (response.status === 422) throw new TicketJobError('invalid_reference');
    if (response.status === 404 && operation === 'inputs')
      throw new TicketJobError('ticket_missing');
    throw new Error('Ticket API rejected an analysis command');
  }

  return {
    async claim(): Promise<Lease | null> {
      const response = await call('claim');
      if (response.status === 204) return null;
      const parsed = analysisJobClaimV1Schema.parse(await response.json());
      return {
        id: parsed.jobId,
        ticketId: parsed.ticketId,
        requestId: parsed.requestId,
        leaseToken: parsed.leaseToken,
        attempts: parsed.attempts,
      };
    },
    async inputs(job: Lease) {
      const response = await call('inputs', identityOf(job));
      if (response.status === 409) {
        await response.body?.cancel();
        throw new Error('Analysis lease lost');
      }
      return analysisInputsV1Schema.parse(await response.json());
    },
    async complete(job: Lease, result: AnalysisDraft): Promise<boolean> {
      const {
        categoryId,
        teamId,
        priority,
        troubleshooting,
        confidence,
        modelVersion,
        citedArticleIds,
      } = result;
      const command = recordRecommendationCommandV1Schema.parse({
        ...identityOf(job),
        promptVersion: PROMPT_VERSION,
        draft: {
          categoryId,
          teamId,
          priority,
          troubleshooting,
          confidence,
          modelVersion,
          citedArticleIds,
        },
      });
      // A timed-out response can hide a successful commit. Retry the same command and lease.
      const response = await call('complete', command).catch((error: unknown) => {
        if (!(error instanceof TicketJobError) || error.kind !== 'unavailable') throw error;
        return call('complete', command);
      });
      if (response.status === 204) return true;
      await response.body?.cancel();
      if (response.status === 409) return false;
      throw new Error('Invalid completion response');
    },
    async fail(
      job: Lease,
      error: { kind: AnalysisFailureKind },
    ): Promise<'QUEUED' | 'FAILED' | null> {
      const response = await call('fail', { ...identityOf(job), kind: error.kind });
      if (response.status === 409) {
        await response.body?.cancel();
        return null;
      }
      const result = (await response.json()) as { state?: string } | null;
      if (result?.state === 'QUEUED' || result?.state === 'FAILED') return result.state;
      throw new Error('Invalid analysis failure response');
    },
  };
}
