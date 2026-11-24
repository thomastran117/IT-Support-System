import {
  adminKnowledgeRoutes as adminRoutes,
  knowledgeRoutes as readerRoutes,
} from '@smartdesk/knowledge';
import type { PrismaClient } from '@smartdesk/db';
import type { FastifyPluginAsync } from 'fastify';
import type { SearchClient } from '../search/client.js';
import { createKnowledgeService } from './service.js';

export const knowledgeRoutes =
  (prisma: PrismaClient, searchClient?: SearchClient): FastifyPluginAsync =>
  async (app) => {
    await app.register(
      readerRoutes(createKnowledgeService(prisma, searchClient), app.authGuards.requireRole),
    );
  };

export const adminKnowledgeRoutes =
  (prisma: PrismaClient): FastifyPluginAsync =>
  async (app) => {
    await app.register(adminRoutes(createKnowledgeService(prisma), app.authGuards.requireRole));
  };
