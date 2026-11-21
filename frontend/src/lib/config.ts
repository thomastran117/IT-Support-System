/**
 * Single source for the API origin. Feature code must use `apiUrl` rather than
 * hardcoding hosts. Configure via NEXT_PUBLIC_API_URL (see .env.example).
 */
export function getApiOrigin(
  // Next inlines process.env.NEXT_PUBLIC_* at build time, so reference it explicitly.
  value: string | undefined = process.env.NEXT_PUBLIC_API_URL,
): string {
  if (!value) {
    throw new Error('NEXT_PUBLIC_API_URL is not set. Copy .env.example to .env.');
  }
  return value.replace(/\/+$/, '');
}

export function apiUrl(path: string, origin: string = getApiOrigin()): string {
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}

const DEFAULT_POLL_MS = 15_000;

/**
 * How often an open ticket checks for updates (NEXT_PUBLIC_TICKET_POLL_MS). Anything below one
 * second or not a number falls back to the default, so a typo cannot hammer the API.
 */
export function pollIntervalMs(value: string | undefined = process.env.NEXT_PUBLIC_TICKET_POLL_MS) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1000 ? n : DEFAULT_POLL_MS;
}
