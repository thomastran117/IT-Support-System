import {
  TICKET_COMMENT_MAX,
  TICKET_DESCRIPTION_MAX,
  TICKET_TITLE_MAX,
  createCommentSchema,
  createTicketSchema,
} from '@smartdesk/contracts';

export const LIMITS = {
  title: TICKET_TITLE_MAX,
  description: TICKET_DESCRIPTION_MAX,
  reply: TICKET_COMMENT_MAX,
} as const;

export interface TicketValues {
  title: string;
  description: string;
}
export type TicketErrors = Partial<Record<keyof TicketValues, string>>;

const FIELD_NAME: Record<string, string> = {
  title: 'Title',
  description: 'Description',
  body: 'Reply',
};

/** Turn the shared schema's verdict into a sentence a person can act on. */
function message(field: string, code: string, max: number): string {
  const name = FIELD_NAME[field] ?? 'This field';
  return code === 'too_big'
    ? `${name} must be ${max.toLocaleString('en')} characters or fewer.`
    : `Enter a ${name.toLowerCase()}.`;
}

/**
 * Validate with the exact schema the API uses (`createTicketSchema` from the contracts package), so
 * the form can never accept something the server rejects for these rules. An empty result means valid.
 */
export function validateTicket(values: TicketValues): TicketErrors {
  const result = createTicketSchema.safeParse(values);
  if (result.success) return {};
  const errors: TicketErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    if (field === 'title' || field === 'description') {
      errors[field] ??= message(field, issue.code, LIMITS[field]);
    }
  }
  return errors;
}

/** Same for a reply; returns the error text or null. */
export function validateReply(body: string): string | null {
  const result = createCommentSchema.safeParse({ body });
  if (result.success) return null;
  const issue = result.error.issues[0];
  return message('body', issue?.code ?? 'too_small', LIMITS.reply);
}

/**
 * One idempotency key per distinct submission. Retrying the same content (a double click, a flaky
 * connection) reuses the key, so the server returns the first ticket instead of creating a duplicate;
 * changed content is a different submission and gets a new key.
 */
export function createSubmissionKeys(newId: () => string = () => crypto.randomUUID()) {
  let current: { fingerprint: string; key: string } | null = null;
  return {
    keyFor(values: TicketValues): string {
      const fingerprint = JSON.stringify([values.title.trim(), values.description.trim()]);
      if (!current || current.fingerprint !== fingerprint) {
        current = { fingerprint, key: newId() };
      }
      return current.key;
    },
    /** After a successful submission the next one must be a new ticket. */
    reset(): void {
      current = null;
    },
  };
}

/** Draft kept in sessionStorage so a failed submit or an expired session does not lose the text. */
const draftKey = (userId: string) => `smartdesk.ticketDraft.${userId}`;

export function loadDraft(userId: string, storage: Pick<Storage, 'getItem'> | null): TicketValues {
  try {
    const raw = storage?.getItem(draftKey(userId));
    const parsed = raw ? (JSON.parse(raw) as Partial<TicketValues>) : {};
    return {
      title: typeof parsed.title === 'string' ? parsed.title : '',
      description: typeof parsed.description === 'string' ? parsed.description : '',
    };
  } catch {
    return { title: '', description: '' };
  }
}

export function saveDraft(
  userId: string,
  values: TicketValues,
  storage: Pick<Storage, 'setItem' | 'removeItem'> | null,
): void {
  try {
    if (!values.title && !values.description) storage?.removeItem(draftKey(userId));
    else storage?.setItem(draftKey(userId), JSON.stringify(values));
  } catch {
    // Storage can be unavailable (private mode, quota); the form still works without it.
  }
}

export function clearDraft(userId: string, storage: Pick<Storage, 'removeItem'> | null): void {
  try {
    storage?.removeItem(draftKey(userId));
  } catch {
    // ignore
  }
}

export const browserStorage = (): Storage | null => {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
};
