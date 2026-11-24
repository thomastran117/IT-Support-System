import type { AnalysisInputs } from './analysis.js';

export const RETRIEVAL_LIMIT = 5;
const MAX_QUERY_TERMS = 12;
const MAX_TERM_CHARS = 200;

const STOP_WORDS = new Set(
  (
    'about above after again also been before being cannot could does doing done from have here into just like ' +
    'more most much need only other over please same should since some still such than that their them then there ' +
    'these they this those through under until upon very want were what when where which while will with would your ' +
    'help issue problem ticket working works the and for are not but can has you any all its our get got'
  ).split(' '),
);

/** Keep distinctive terms from the redacted ticket. Title terms survive the query cap first. */
export function buildRetrievalTerms(title: string, description: string): string[] {
  const terms = new Set<string>();
  for (const word of `${title} ${description}`.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []) {
    if (STOP_WORDS.has(word) || word.startsWith('redacted')) continue;
    terms.add(word.slice(0, MAX_TERM_CHARS));
    if (terms.size >= MAX_QUERY_TERMS) break;
  }
  return [...terms];
}

export type KnowledgeRetrieval = Pick<AnalysisInputs, 'articles' | 'retrieval'>;
export type KnowledgeReader = (
  terms: string[],
  requestId?: string,
) => Promise<KnowledgeRetrieval | undefined>;

export const emptyKnowledge = (): KnowledgeRetrieval => ({
  articles: [],
  retrieval: { engine: 'none', version: 1 },
});

export async function retrieveKnowledge(
  read: KnowledgeReader,
  ticket: AnalysisInputs['ticket'],
  requestId?: string,
): Promise<KnowledgeRetrieval> {
  const terms = buildRetrievalTerms(ticket.title, ticket.description);
  return (await read(terms, requestId)) ?? emptyKnowledge();
}
