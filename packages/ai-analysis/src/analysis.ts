import {
  ProviderError,
  type AIProvider,
  type AnalysisRequest,
  type ValidatedProposal,
} from './provider.js';

export interface AnalysisRetrieval {
  engine: 'opensearch' | 'postgres' | 'none';
  version: number;
}

/** The source supplies only redacted text and allowlisted active/published references. */
export interface AnalysisInputs extends AnalysisRequest {
  retrieval: AnalysisRetrieval;
}

export interface AnalysisDraft extends ValidatedProposal {
  retrievedArticleIds: string[];
  retrieval: AnalysisRetrieval;
}

export async function analyseInputs(
  provider: AIProvider,
  inputs: AnalysisInputs,
): Promise<AnalysisDraft> {
  const { ticket, allowedCategories, allowedTeams, articles, retrieval } = inputs;
  if (!allowedCategories.length || !allowedTeams.length) {
    throw new ProviderError('invalid_reference', 'No active category or team to recommend');
  }
  const proposal = await provider.analyse({ ticket, allowedCategories, allowedTeams, articles });
  const retrieved = articles.map((article) => article.id);
  const allowed = new Set(retrieved);
  if (
    !allowedCategories.some((category) => category.id === proposal.categoryId) ||
    !allowedTeams.some((team) => team.id === proposal.teamId) ||
    proposal.citedArticleIds.some((id) => !allowed.has(id))
  ) {
    throw new ProviderError('invalid_reference', 'AI output referenced an unknown record');
  }
  // Preserve the retrieval ranking when the model cites articles in a different order.
  const cited = new Set(proposal.citedArticleIds);
  return {
    ...proposal,
    citedArticleIds: retrieved.filter((id) => cited.has(id)),
    retrievedArticleIds: retrieved,
    retrieval,
  };
}
