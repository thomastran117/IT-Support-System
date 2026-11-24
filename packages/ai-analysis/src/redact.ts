/**
 * Best-effort removal of secrets and personal identifiers from free text before it leaves the
 * system for an AI provider (and before it could reach any log).
 *
 * LIMITS (also documented in docs/architecture.md): this is pattern based. It catches common,
 * well-formed shapes (emails, URL credentials, bearer/JWT/API-key style tokens, `password: x`
 * style assignments, long hex/base64 blobs, card-like and SSN-like digit runs, private-key
 * blocks). It cannot recognise names, addresses, free-form passphrases or secrets written in prose.
 * The requester's identity is never sent at all (only title and description are), which is the
 * stronger control; redaction is defence in depth for what users type into the text.
 */
const RULES: [RegExp, string][] = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    '[REDACTED_KEY]',
  ],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi, '[REDACTED_URL_CREDENTIALS]@'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED_TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '[REDACTED_TOKEN]'],
  [/\b(?:sk|pk|rk|ghp|gho|xox[abprs]|AKIA|AIza)[-_A-Za-z0-9]{12,}/g, '[REDACTED_TOKEN]'],
  [
    /\b(password|passwd|pwd|passcode|secret|api[ _-]?key|token|pin)\b(\s*(?:is|are|=|:)\s*)("[^"\n]*"|'[^'\n]*'|\S+)/gi,
    '$1$2[REDACTED]',
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '[REDACTED_EMAIL]'],
  [/\b(?:\d[ -]?){13,19}\b/g, '[REDACTED_NUMBER]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED_NUMBER]'],
  [/\b[A-Fa-f0-9]{32,}\b/g, '[REDACTED_TOKEN]'],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '[REDACTED_TOKEN]'],
];

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function redactText(text: string): string {
  let out = text.replace(CONTROL_CHARS, '');
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return out;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}
