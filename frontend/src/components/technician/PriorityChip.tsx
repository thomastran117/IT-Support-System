import type { TicketPriority } from '@smartdesk/contracts';
import { PRIORITY_LABEL } from '@/lib/tickets/format';

const CHIP: Record<TicketPriority, string> = {
  CRITICAL: 'border-rose-200 bg-rose-50 text-rose-800',
  HIGH: 'border-orange-200 bg-orange-50 text-orange-800',
  MEDIUM: 'border-amber-200 bg-amber-50 text-amber-800',
  LOW: 'border-slate-200 bg-slate-100 text-slate-700',
  UNSET: 'border-dashed border-slate-300 bg-white text-slate-600',
};

/** The priority is always spelled out; colour and border style only reinforce it. */
export function PriorityChip({ priority }: { priority: TicketPriority }) {
  return (
    <span
      className={`inline-flex min-h-6 items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${CHIP[priority]}`}
    >
      {PRIORITY_LABEL[priority]}
    </span>
  );
}
