import type { PrismaClient } from '@smartdesk/db';
import { loadSql } from '../../db/sql.js';
import { CSV_HEADER } from './routingBaseline.js';

interface Row {
  ticket_id: string;
  category: string;
  started_at: Date;
  assigned_at: Date | null;
}

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * Raw assisted-routing observations as CSV in the same shape the manual observations use, so both
 * cohorts are stored as plain files an independent reviewer can recompute from. Read-only.
 */
export async function exportAssistedObservations(
  prisma: PrismaClient,
  window: { start: Date; end: Date },
  opts: { aiAssistedOnly: boolean },
): Promise<{ csv: string; rows: number }> {
  if (!(window.start.getTime() < window.end.getTime())) {
    throw new Error('start must be before end');
  }
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    loadSql('baseline/assisted_routing_observations.sql'),
    window.start,
    window.end,
    opts.aiAssistedOnly,
  );
  const lines = [
    CSV_HEADER.join(','),
    ...rows.map((r) =>
      [
        r.ticket_id,
        csvCell(r.category),
        r.started_at.toISOString(),
        r.assigned_at ? r.assigned_at.toISOString() : '',
        '',
      ].join(','),
    ),
  ];
  return { csv: `${lines.join('\n')}\n`, rows: rows.length };
}
