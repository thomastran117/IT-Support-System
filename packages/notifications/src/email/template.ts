import type { NotificationType } from '@smartdesk/contracts';
import { notificationMessage } from '../messages.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Stable per notification, so a mail system can recognise a repeat of the same message. */
  messageId: string;
}

const SUBJECTS: Record<NotificationType, string> = {
  TICKET_ASSIGNED: 'Your ticket was assigned',
  TICKET_STATUS_CHANGED: 'Your ticket status changed',
  TICKET_RESOLVED: 'Your ticket was resolved',
  TICKET_REOPENED: 'Your ticket was reopened',
  TECHNICIAN_REPLY: 'A technician replied to your ticket',
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** One line of plain text: control characters and line breaks cannot add headers or lines. */
const oneLine = (value: string): string =>
  Array.from(value, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? ' ' : ch;
  })
    .join('')
    .replace(/ {2,}/g, ' ')
    .trim();

export interface EmailInput {
  notificationId: string;
  type: NotificationType;
  ticketId: string;
  ticketTitle: string;
  recipientEmail: string;
  recipientName: string;
  appBaseUrl: string;
}

/**
 * Build the email for one notification. Like the in-app notice it is derived from the type and the
 * ticket only: the wording is fixed, and the only free text is the requester's own ticket title and
 * name. Comment text, resolution summaries, internal notes, AI prompts and credentials are not
 * inputs, so they cannot appear. The subject is fixed per type, which also rules out header injection.
 */
export function buildEmail(input: EmailInput): EmailMessage {
  const message = notificationMessage(input.type);
  const subject = `[SmartDesk] ${SUBJECTS[input.type]}`;
  const link = `${input.appBaseUrl}/employee/tickets/${encodeURIComponent(input.ticketId)}`;
  const title = oneLine(input.ticketTitle);
  const name = oneLine(input.recipientName);

  const text = [
    `Hello ${name},`,
    '',
    message,
    '',
    `Ticket: ${title}`,
    `Tracking ID: ${input.ticketId}`,
    `Open it: ${link}`,
    '',
    'You are receiving this because you submitted this ticket in SmartDesk.',
    '',
  ].join('\n');

  const html = [
    '<!doctype html>',
    '<html><body style="font-family:Arial,Helvetica,sans-serif;color:#0f172a">',
    `<p>Hello ${escapeHtml(name)},</p>`,
    `<p><strong>${escapeHtml(message)}</strong></p>`,
    `<p>Ticket: ${escapeHtml(title)}<br>Tracking ID: ${escapeHtml(input.ticketId)}</p>`,
    `<p><a href="${escapeHtml(link)}">Open the ticket</a></p>`,
    '<p style="color:#475569;font-size:12px">You are receiving this because you submitted this ticket in SmartDesk.</p>',
    '</body></html>',
  ].join('\n');

  return {
    to: input.recipientEmail,
    subject,
    text,
    html,
    messageId: `<${input.notificationId}@smartdesk>`,
  };
}
