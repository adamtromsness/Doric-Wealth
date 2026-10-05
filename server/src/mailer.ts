// Outgoing email over SMTP (see config.smtpHost / mailFrom). Plain-text only: it's
// used for password reset links. Tests capture mail with setMailSenderForTests
// instead of sending it.
import nodemailer from 'nodemailer';
import { config } from './config.js';

export interface Mail { to: string; subject: string; text: string }
type Sender = (mail: Mail) => Promise<void>;

let testSender: Sender | null = null;
export function setMailSenderForTests(fn: Sender | null): void { testSender = fn; }

export function mailConfigured(): boolean {
  return Boolean(testSender || (config.smtpHost && config.mailFrom));
}

export async function sendMail(mail: Mail): Promise<void> {
  if (testSender) return testSender(mail);
  if (!config.smtpHost || !config.mailFrom) throw new Error('Email is not configured (SMTP_HOST and MAIL_FROM).');
  const transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465, // implicit TLS; 587 upgrades with STARTTLS
    requireTLS: config.smtpPort !== 465,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
  });
  await transport.sendMail({ from: config.mailFrom, to: mail.to, subject: mail.subject, text: mail.text });
}
