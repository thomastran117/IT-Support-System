import { proposalSchema, type AiPriority } from './schema.js';

export interface AnalysisTicket {
  title: string;
  description: string;
}
export interface AllowedRef {
  id: string;
  name: string;
}
export interface AnalysisArticle {
  id: string;
  title: string;
  body: string;
}

export interface AnalysisRequest {
  ticket: AnalysisTicket;
  allowedCategories: AllowedRef[];
  allowedTeams: AllowedRef[];
  articles: AnalysisArticle[];
}

/** Advisory recommendation: only ever a draft, never applied to a ticket by this module. */
export interface ValidatedProposal {
  categoryId: string;
  teamId: string;
  priority: AiPriority;
  troubleshooting: string;
  /** Model-reported 0..1; uncalibrated, not a probability. */
  confidence: number | null;
  /** Only IDs present in the supplied `articles`, de-duplicated, in the order the model gave. */
  citedArticleIds: string[];
  /** Provider and model identifier, e.g. `openai:gpt-4o-mini`. */
  modelVersion: string;
}

export interface AIProvider {
  readonly name: string;
  analyse(request: AnalysisRequest): Promise<ValidatedProposal>;
}

export type ProviderErrorKind =
  'disabled' | 'timeout' | 'rate_limited' | 'unavailable' | 'malformed' | 'invalid_reference';

const RETRYABLE: Record<ProviderErrorKind, boolean> = {
  disabled: false,
  timeout: true,
  rate_limited: true,
  unavailable: true,
  malformed: false,
  invalid_reference: false,
};

/**
 * Classified provider failure. The message is a fixed, secret-free description chosen by us;
 * raw provider bodies, request text and API keys are never copied into it.
 */
export class ProviderError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly kind: ProviderErrorKind,
    message?: string,
  ) {
    super(message ?? `AI provider error: ${kind}`);
    this.name = 'ProviderError';
    this.retryable = RETRYABLE[kind];
  }
}

/**
 * Parse and validate model output (a JSON string or an already-parsed value) against the strict
 * schema and the supplied allowlists. Hallucinated category/team/article IDs are rejected rather than
 * dropped or repaired, so nothing unvalidated can reach persistence.
 */
export function validateProposal(
  raw: unknown,
  request: Pick<AnalysisRequest, 'allowedCategories' | 'allowedTeams' | 'articles'>,
  modelVersion: string,
): ValidatedProposal {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ProviderError('malformed', 'AI response was not valid JSON');
    }
  }
  const parsed = proposalSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProviderError('malformed', 'AI response did not match the expected schema');
  }
  const p = parsed.data;
  if (!request.allowedCategories.some((c) => c.id === p.categoryId)) {
    throw new ProviderError('invalid_reference', 'AI proposed a category that is not allowed');
  }
  if (!request.allowedTeams.some((t) => t.id === p.teamId)) {
    throw new ProviderError('invalid_reference', 'AI proposed a team that is not allowed');
  }
  const known = new Set(request.articles.map((a) => a.id));
  const cited = [...new Set(p.citedArticleIds ?? [])];
  if (cited.some((id) => !known.has(id))) {
    throw new ProviderError('invalid_reference', 'AI cited an article that was not retrieved');
  }
  return {
    categoryId: p.categoryId,
    teamId: p.teamId,
    priority: p.priority,
    troubleshooting: p.troubleshooting,
    confidence: p.confidence ?? null,
    citedArticleIds: cited,
    modelVersion,
  };
}
