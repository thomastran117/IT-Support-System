import { loadTicketEnv } from './config/ticketEnv.js';
import { startHttpServer } from './httpServer.js';

await startHttpServer(loadTicketEnv(), 'ticket');
