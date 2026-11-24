import { z } from 'zod';

/** Priorities the model may propose. `UNSET` is the "not yet triaged" state and is never an AI prediction. */
export const AI_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type AiPriority = (typeof AI_PRIORITIES)[number];

export const MAX_TROUBLESHOOTING_CHARS = 4000;
export const MAX_CITED_ARTICLES = 5;

/**
 * Strict shape the model must return. Extra keys are rejected. IDs are only checked for UUID shape
 * here; membership in the active category/team/article allowlists is enforced by `validateProposal`.
 * `confidence` is the model's self-reported 0..1 score (ai_recommendations.confidence): it is
 * uncalibrated and must never be presented as a probability.
 */
export const proposalSchema = z
  .object({
    categoryId: z.uuid(),
    teamId: z.uuid(),
    priority: z.enum(AI_PRIORITIES),
    troubleshooting: z.string().trim().min(1).max(MAX_TROUBLESHOOTING_CHARS),
    confidence: z.number().min(0).max(1).nullish(),
    citedArticleIds: z.array(z.uuid()).max(MAX_CITED_ARTICLES).nullish(),
  })
  .strict();

export type RawProposal = z.infer<typeof proposalSchema>;

/** JSON Schema sent to providers that support structured output (kept in sync with `proposalSchema`). */
export const proposalJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'categoryId',
    'teamId',
    'priority',
    'troubleshooting',
    'confidence',
    'citedArticleIds',
  ],
  properties: {
    categoryId: { type: 'string' },
    teamId: { type: 'string' },
    priority: { type: 'string', enum: [...AI_PRIORITIES] },
    troubleshooting: { type: 'string' },
    confidence: { type: ['number', 'null'] },
    citedArticleIds: { type: 'array', items: { type: 'string' } },
  },
} as const;
