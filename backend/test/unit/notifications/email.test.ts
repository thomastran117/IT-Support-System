import { describe, expect, it, vi } from 'vitest';
import { NOTIFICATION_TYPES } from '@smartdesk/contracts';
import { loadEnv, type EmailConfig } from '../../../src/config/env.js';
import { buildEmail } from '@smartdesk/notifications';
import {
  EmailError,
  classifySmtpError,
  createEmailTransport,
  createSinkTransport,
  createSmtpTransport,
  smtpOptions,
} from '@smartdesk/notifications';

const smtpEnv = {
  EMAIL_TRANSPORT: 'smtp',
  SMTP_USER: 'desk@example.com',
  SMTP_PASSWORD: 'app-pass',
};
const input = {
  notificationId: '00000000-0000-4000-8000-000000000001',
  type: 'TICKET_RESOLVED' as const,
  ticketId: '00000000-0000-4000-8000-000000000002',
  ticketTitle: 'Printer <b>broken</b>\r\nBcc: attacker@evil.test',
  recipientEmail: 'erin@example.com',
  recipientName: 'Erin "E" <Employee>',
  appBaseUrl: 'https://help.example.com',
};

describe('email config', () => {
  it('is off by default, so nothing can be sent without opting in', () => {
    const { email } = loadEnv({});
    expect(email.transport).toBe('none');
    expect(createEmailTransport(email)).toBeNull();
  });

  it('defaults to Gmail with STARTTLS on port 587', () => {
    const { email } = loadEnv(smtpEnv);
    expect(email).toMatchObject({
      transport: 'smtp',
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      from: 'desk@example.com',
    });
    expect(smtpOptions(email)).toMatchObject({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: 'desk@example.com', pass: 'app-pass' },
      logger: false,
    });
  });

  it('uses implicit TLS on port 465', () => {
    const { email } = loadEnv({ ...smtpEnv, SMTP_PORT: '465' });
    expect(email.secure).toBe(true);
    expect(smtpOptions(email)).toMatchObject({ secure: true, requireTLS: false });
  });

  it('needs credentials and a sane link origin when enabled', () => {
    expect(() => loadEnv({ EMAIL_TRANSPORT: 'smtp' })).toThrow(/SMTP_USER and SMTP_PASSWORD/);
    expect(() => loadEnv({ ...smtpEnv, APP_BASE_URL: 'javascript:alert(1)' })).toThrow(
      /APP_BASE_URL/,
    );
    expect(() => loadEnv({ EMAIL_TRANSPORT: 'carrier-pigeon' })).toThrow(/EMAIL_TRANSPORT/);
    expect(() => loadEnv({ ...smtpEnv, EMAIL_JOB_MAX_ATTEMPTS: '0' })).toThrow(
      /EMAIL_JOB_MAX_ATTEMPTS/,
    );
  });

  it('builds links from APP_BASE_URL, then FRONTEND_ORIGIN, without a trailing slash', () => {
    expect(loadEnv({ ...smtpEnv, APP_BASE_URL: 'https://a.example/' }).email.appBaseUrl).toBe(
      'https://a.example',
    );
    expect(loadEnv({ ...smtpEnv, FRONTEND_ORIGIN: 'https://b.example' }).email.appBaseUrl).toBe(
      'https://b.example',
    );
  });
});

describe('buildEmail', () => {
  it('has a fixed subject and wording per type and links to the employee ticket page', () => {
    for (const type of NOTIFICATION_TYPES) {
      const m = buildEmail({ ...input, type });
      expect(m.subject).toMatch(/^\[SmartDesk\] [A-Za-z ]+$/);
      expect(m.subject).not.toContain('Printer');
    }
    const m = buildEmail(input);
    expect(m.to).toBe('erin@example.com');
    expect(m.messageId).toBe(`<${input.notificationId}@smartdesk>`);
    expect(m.text).toContain(`https://help.example.com/employee/tickets/${input.ticketId}`);
    expect(m.html).toContain(`href="https://help.example.com/employee/tickets/${input.ticketId}"`);
  });

  it('escapes HTML and flattens line breaks in user-supplied text', () => {
    const m = buildEmail(input);
    expect(m.html).not.toContain('<b>');
    expect(m.html).toContain('Printer &lt;b&gt;broken&lt;/b&gt;');
    expect(m.html).toContain('Erin &quot;E&quot; &lt;Employee&gt;');
    expect(m.text).not.toMatch(/\r|\nBcc:/);
    expect(m.subject).not.toMatch(/[\r\n]/);
  });
});

describe('classifySmtpError', () => {
  it('retries temporary and network failures', () => {
    expect(classifySmtpError({ responseCode: 451 })).toEqual({
      kind: 'temporary',
      retryable: true,
    });
    expect(classifySmtpError({ code: 'ETIMEDOUT' })).toEqual({
      kind: 'unavailable',
      retryable: true,
    });
    expect(classifySmtpError({ code: 'ECONNREFUSED' }).retryable).toBe(true);
    expect(classifySmtpError(new Error('boom'))).toEqual({ kind: 'internal', retryable: true });
  });

  it('does not retry a bad login or a rejected recipient', () => {
    expect(classifySmtpError({ code: 'EAUTH', responseCode: 535 })).toEqual({
      kind: 'auth_failed',
      retryable: false,
    });
    expect(classifySmtpError({ responseCode: 550, response: '550 5.1.1 no such user' })).toEqual({
      kind: 'rejected',
      retryable: false,
    });
  });

  it("retries Gmail's daily sending limit", () => {
    expect(
      classifySmtpError({
        responseCode: 550,
        response: '550 5.4.5 Daily user sending limit exceeded',
      }),
    ).toEqual({ kind: 'rate_limited', retryable: true });
  });
});

describe('transports', () => {
  const config = loadEnv(smtpEnv).email as EmailConfig;

  it('smtp: sends through nodemailer and reduces a failure to a reason code', async () => {
    const sendMail = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        Object.assign(new Error('535 Username and Password not accepted for erin@example.com'), {
          code: 'EAUTH',
          responseCode: 535,
        }),
      );
    const transport = createSmtpTransport(config, (() => ({ sendMail })) as never);
    const message = buildEmail(input);
    await transport.send(message);
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'desk@example.com', to: 'erin@example.com' }),
    );

    const err = await transport.send(message).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailError);
    expect(err).toMatchObject({ kind: 'auth_failed', retryable: false, message: 'auth_failed' });
    // The server's text (which can echo addresses) is not kept.
    expect(String((err as Error).message)).not.toContain('erin@example.com');
  });

  it('sink: captures messages and can simulate an outage', async () => {
    const sink = createSinkTransport();
    await sink.send(buildEmail(input));
    expect(sink.sent).toHaveLength(1);
    sink.failWith = new EmailError('unavailable', true);
    await expect(sink.send(buildEmail(input))).rejects.toBeInstanceOf(EmailError);
    expect(sink.sent).toHaveLength(1);
  });
});
