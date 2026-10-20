/**
 * Mail the backend sent, read from Mailpit's HTTP API (the SMTP sink of the dev stack). The contract fixes what an
 * email carries (R82: links `${PUBLIC_BASE_URL}/password/reset/{token}` and `${PUBLIC_BASE_URL}/invite/{token}`), so
 * a test may follow the link from the letter exactly as a user would.
 */
const MAILPIT_URL = (process.env.MAILPIT_URL ?? 'http://mailpit:8025').replace(/\/$/, '');

export interface Mail {
  id: string;
  subject: string;
  to: string[];
  from: string;
  text: string;
}

interface SearchResult {
  messages: { ID: string; Subject: string; To: { Address: string }[]; Created: string }[];
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${MAILPIT_URL}${path}`);
  if (!res.ok) throw new Error(`mailpit ${path}: ${res.status}`);
  return (await res.json()) as T;
}

/** Every message to `address` (newest first). */
export async function mailsTo(address: string): Promise<Mail[]> {
  const found = await getJson<SearchResult>(`/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`);
  const out: Mail[] = [];
  for (const m of found.messages) {
    const full = await getJson<{
      ID: string;
      Subject: string;
      Text: string;
      From: { Address: string };
      To: { Address: string }[];
    }>(`/api/v1/message/${m.ID}`);
    out.push({
      id: full.ID,
      subject: full.Subject,
      to: full.To.map((t) => t.Address.toLowerCase()),
      from: full.From.Address,
      text: full.Text,
    });
  }
  return out;
}

/** Polls until `count` messages to `address` have arrived (mail is sent after the response), newest first. */
export async function waitForMails(address: string, count = 1, timeoutMs = 10000): Promise<Mail[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const mails = await mailsTo(address);
    if (mails.length >= count) return mails;
    if (Date.now() > deadline)
      throw new Error(`expected ${count} mail(s) to ${address}, got ${mails.length}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** The single link of `kind` in a letter: `{PUBLIC_BASE_URL}/password/reset/{token}` or `/invite/{token}`. */
export function linkToken(mail: Mail, kind: 'password/reset' | 'invite'): { url: string; token: string } {
  const re = new RegExp(`(https?://\\S+?/${kind}/([A-Za-z0-9_-]+))(?=\\s|$)`, 'g');
  const found = [...mail.text.matchAll(re)];
  if (found.length !== 1)
    throw new Error(`expected one ${kind} link in "${mail.subject}", found ${found.length}`);
  return { url: found[0]![1]!, token: found[0]![2]! };
}
