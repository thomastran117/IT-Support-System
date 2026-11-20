export { closePrisma, getPrisma, initPrisma } from './client.js';
export { DbError, isRetryable, mapDbError, type DbErrorCode } from './errors.js';
export { lockRow, withTransaction, type Db, type TransactionOptions } from './transaction.js';
export {
  ALLOWED_TRANSITIONS,
  addComment,
  approveRouting,
  createTicket,
  submitTicket,
  reviewRecommendation,
  transitionTicket,
} from './services/ticketService.js';
