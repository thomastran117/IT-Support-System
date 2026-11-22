'use client';

import { X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { cx } from './cx';

export type ToastTone = 'success' | 'danger' | 'info';

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastApi {
  show(message: string, tone?: ToastTone): void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TONE: Record<ToastTone, string> = {
  success: 'border-emerald-300 bg-emerald-50 text-emerald-950',
  danger: 'border-rose-300 bg-rose-50 text-rose-950',
  info: 'border-blue-300 bg-blue-50 text-blue-950',
};

/** Auto-dismiss delay. Errors stay longer because they usually need reading and acting on. */
const LIFETIME_MS: Record<ToastTone, number> = { success: 5000, info: 5000, danger: 9000 };

/**
 * One live region for transient feedback. Messages are announced politely (errors assertively) and
 * can always be dismissed; nothing here is the only place a result is shown.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const show = useCallback(
    (message: string, tone: ToastTone = 'info') => {
      const id = next.current++;
      setItems((current) => [...current.slice(-3), { id, tone, message }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), LIFETIME_MS[tone]),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => clearTimeout(timer));
  }, []);

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col items-stretch gap-2 sm:inset-x-auto sm:right-4 sm:w-96">
        <div aria-live="polite" className="contents">
          {items.map((item) => (
            <ToastCard key={item.id} item={item} onDismiss={dismiss} />
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  return (
    <div
      role={item.tone === 'danger' ? 'alert' : undefined}
      className={cx(
        'app-toast pointer-events-auto flex items-start gap-3 rounded-xl border p-3 text-sm shadow-lg',
        TONE[item.tone],
      )}
    >
      <p className="min-w-0 flex-1 leading-6">{item.message}</p>
      <button
        type="button"
        aria-label="Dismiss message"
        onClick={() => onDismiss(item.id)}
        className="grid size-8 shrink-0 place-items-center rounded-lg hover:bg-black/5"
      >
        <X aria-hidden="true" size={16} />
      </button>
    </div>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside <ToastProvider>');
  return api;
}
