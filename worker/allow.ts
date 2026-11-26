/** Who may sign in: comma-separated emails and domains. Both empty: anyone. */
export interface AllowLists {
  ALLOWED_EMAILS?: string;
  ALLOWED_DOMAINS?: string;
}

const list = (v?: string) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);

export function emailAllowed(env: AllowLists, email: string): boolean {
  const emails = list(env.ALLOWED_EMAILS);
  const domains = list(env.ALLOWED_DOMAINS);
  if (!emails.length && !domains.length) return true;
  const e = email.toLowerCase();
  return emails.includes(e) || domains.includes(e.split('@')[1] ?? '');
}
