import { ARTICLES, CATEGORIES } from '../../src/db/seed/fixtures.js';
import {
  evaluationArticles,
  searchEvaluationQueries,
} from '../../test/fixtures/searchEvaluation.js';

interface Query {
  q: string;
  categoryId?: string | undefined;
  relevant: readonly string[];
  group: 'sd-085' | 'paraphrase';
}

const inherited = searchEvaluationQueries.filter(({ collection }) => collection === 'knowledge');

export const hybridQueries: readonly Query[] = [
  ...inherited.map(({ q, filters, relevant }) => ({
    q,
    categoryId: filters?.categoryId,
    relevant,
    group: 'sd-085' as const,
  })),
  { q: 'secure tunnel repeatedly cuts out', relevant: [ARTICLES.vpn], group: 'paraphrase' },
  { q: 'stuck pages are blocking other jobs', relevant: [ARTICLES.printer], group: 'paraphrase' },
  {
    q: 'cannot sign in after forgetting my credentials',
    relevant: [ARTICLES.password],
    group: 'paraphrase',
  },
  {
    q: 'reactivate an expired application seat',
    relevant: [ARTICLES.software],
    group: 'paraphrase',
  },
  {
    q: 'second screen blinks when plugged into the hub',
    relevant: [evaluationArticles.hardware],
    group: 'paraphrase',
  },
  {
    q: 'wired connection goes down, should I replace the cable',
    relevant: [evaluationArticles.ethernet],
    group: 'paraphrase',
  },
  {
    q: 'portable computer will not reconnect after it sleeps',
    relevant: [evaluationArticles.wireless],
    group: 'paraphrase',
  },
  {
    q: 'tunnel negotiation fails because of an expired credential',
    categoryId: CATEGORIES.network,
    relevant: [evaluationArticles.network, ARTICLES.vpn],
    group: 'paraphrase',
  },
];
