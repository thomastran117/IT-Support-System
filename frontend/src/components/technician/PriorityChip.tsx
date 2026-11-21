import type { TicketPriority } from '@smartdesk/contracts';
import { PRIORITY_LABEL } from '@/lib/tickets/format';

const CHIP: Record<TicketPriority, string> = {
  CRITICAL: 'border-red-600 bg-red-50 text-red-900',
  HIGH: 'border-orange-500 bg-orange-50 text-orange-900',
  MEDIUM: 'border-amber-400 bg-amber-50 text-amber-900',
  LOW: 'border-slate-400 bg-slate-100 text-slate-800',
  UNSET: 'border-dashed border-slate-400 bg-white text-slate-700',
};

/** The priority is always spelled out; colour and border style only reinforce it. */
export function PriorityChip({ priority }: { priority: TicketPriority }) {
  return (
    <span
      className={`inline-block rounded border px-2 py-0.5 text-xs font-semibold ${CHIP[priority]}`}
    >
      {PRIORITY_LABEL[priority]}
    </span>
  );
}
