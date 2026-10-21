/**
 * Outgoing mail over SMTP (dev: Mailpit). Letters are plain text in Russian from @agrotrace/i18n (`mail.*`). Sending
 * never blocks or fails the operation that asks for it (spec 8.9: an unavailable SMTP server does not block the main
 * operation): `send` runs after the response path, retries 3 times with exponential back-off, then logs the letter as
 * not delivered (without its body — links in it are secrets).
 */
import nodemailer, { type Transporter } from 'nodemailer';
import type { Logger } from '../logger.js';

export interface Letter {
  to: string;
  subject: string;
  text: string;
  /** For logs (the body is never logged). */
  kind: string;
}

export interface Mailer {
  /** Fire-and-forget; resolves when delivered or given up (tests may await it). */
  send(letter: Letter): Promise<void>;
  /** One delivery attempt, no retries; rejects when the SMTP server refuses or is unreachable (notification delivery). */
  sendOnce(letter: Letter): Promise<void>;
  close(): void;
}

export function createMailer(
  opts: { host: string; port: number; from: string },
  logger: Logger,
  backoffMs = 500,
): Mailer {
  const transport: Transporter = nodemailer.createTransport({
    host: opts.host,
    port: opts.port,
    secure: false,
    ignoreTLS: true,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
  });
  return {
    async sendOnce(letter) {
      await transport.sendMail({
        from: opts.from,
        to: letter.to,
        subject: letter.subject,
        text: letter.text,
      });
    },
    async send(letter) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await transport.sendMail({
            from: opts.from,
            to: letter.to,
            subject: letter.subject,
            text: letter.text,
          });
          return;
        } catch (err) {
          if (attempt === 3) {
            logger.error({ err: (err as Error).message, kind: letter.kind }, 'mail not delivered');
            return;
          }
          await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)));
        }
      }
    },
    close() {
      transport.close();
    },
  };
}
