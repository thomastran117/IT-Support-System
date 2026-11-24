import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import type { EmailConfig } from './config.js';
import type { EmailMessage } from './template.js';

export interface EmailTransport {
  /** Resolves once the server accepted the message; rejects with an {@link EmailError}. */
  send(message: EmailMessage): Promise<void>;
}

/** A failed send reduced to a reason code. The server's text is never kept, because it can echo addresses. */
export class EmailError extends Error {
  constructor(
    public readonly kind: string,
    public readonly retryable: boolean,
  ) {
    super(kind);
    this.name = 'EmailError';
  }
}

interface SmtpFailure {
  code?: string;
  responseCode?: number;
  response?: string;
}

/**
 * Map an SMTP/network failure to a reason code and whether retrying can help. Temporary (4xx) and
 * network failures retry; a rejected login or recipient will not get better by waiting. Gmail's
 * daily sending limit (5.4.5) is a 550 but does clear, so it retries.
 */
export function classifySmtpError(err: unknown): { kind: string; retryable: boolean } {
  if (err instanceof EmailError) return { kind: err.kind, retryable: err.retryable };
  const e = (err ?? {}) as SmtpFailure;
  const code = e.responseCode ?? 0;
  if (e.code === 'EAUTH' || code === 535 || code === 534 || code === 530) {
    return { kind: 'auth_failed', retryable: false };
  }
  if (code >= 500 && /5\.4\.5|5\.7\.0/.test(e.response ?? '')) {
    return { kind: 'rate_limited', retryable: true };
  }
  if (e.code === 'EENVELOPE' || (code >= 500 && code < 600)) {
    return { kind: 'rejected', retryable: false };
  }
  if (code >= 400 && code < 500) return { kind: 'temporary', retryable: true };
  if (e.code === 'ETIMEDOUT' || e.code === 'ESOCKET' || e.code === 'ECONNECTION') {
    return { kind: 'unavailable', retryable: true };
  }
  if (e.code === 'ECONNRESET' || e.code === 'EDNS' || e.code === 'ECONNREFUSED') {
    return { kind: 'unavailable', retryable: true };
  }
  return { kind: 'internal', retryable: true };
}

/**
 * Connection options. The defaults are Gmail's: port 587 where the connection MUST upgrade with
 * STARTTLS (`requireTLS`), or implicit TLS on 465. Credentials come from the environment only.
 * Nodemailer's own logging is off so it can never print the login or message content.
 */
export function smtpOptions(config: EmailConfig): SMTPTransport.Options {
  return {
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure,
    auth: { user: config.user, pass: config.password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    logger: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

export function createSmtpTransport(
  config: EmailConfig,
  factory: typeof nodemailer.createTransport = nodemailer.createTransport,
): EmailTransport {
  const smtp = factory(smtpOptions(config));
  return {
    async send(message) {
      try {
        await smtp.sendMail({
          from: config.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
          messageId: message.messageId,
        });
      } catch (err) {
        const { kind, retryable } = classifySmtpError(err);
        throw new EmailError(kind, retryable);
      }
    },
  };
}

/** `null` when email is off: the worker then starts no email loop and nothing is ever sent. */
export function createEmailTransport(config: EmailConfig): EmailTransport | null {
  return config.transport === 'smtp' ? createSmtpTransport(config) : null;
}

/** In-memory capture for tests and local runs. Never talks to the network. */
export interface SinkTransport extends EmailTransport {
  readonly sent: EmailMessage[];
  /** While set, every send fails with this error. */
  failWith: EmailError | null;
}

export function createSinkTransport(): SinkTransport {
  const sink: SinkTransport = {
    sent: [],
    failWith: null,
    async send(message) {
      if (sink.failWith) throw sink.failWith;
      sink.sent.push(message);
    },
  };
  return sink;
}
