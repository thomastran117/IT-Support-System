import {
  ProviderError,
  validateProposal,
  type AIProvider,
  type AnalysisRequest,
  type ValidatedProposal,
} from '../provider.js';

export type FakeScript = (request: AnalysisRequest) => unknown;

/**
 * Deterministic provider for CI and local development. By default it proposes the first allowed
 * category/team with MEDIUM priority and cites the first retrieved article. A `script` can return any
 * raw value (or a `ProviderError` to throw) to exercise validation and failure paths; its output goes
 * through the same `validateProposal` as a live provider's.
 */
export function createFakeProvider(
  script?: FakeScript,
  modelVersion = 'fake:deterministic-v1',
): AIProvider {
  return {
    name: 'fake',
    async analyse(request: AnalysisRequest): Promise<ValidatedProposal> {
      const raw = script
        ? script(request)
        : {
            categoryId: request.allowedCategories[0]?.id,
            teamId: request.allowedTeams[0]?.id,
            priority: 'MEDIUM',
            troubleshooting: 'Fake provider: follow the standard triage checklist.',
            confidence: 0.5,
            citedArticleIds: request.articles.slice(0, 1).map((a) => a.id),
          };
      if (raw instanceof ProviderError) throw raw;
      return validateProposal(raw, request, modelVersion);
    },
  };
}
