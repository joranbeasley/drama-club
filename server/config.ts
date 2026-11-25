/** Settings come from the environment (see .env.example). */
export interface Config {
  port: number;
  databaseUrl: string;
  production: boolean;
  /** OAuth client id for "Sign in with Google" (a Web application client). */
  googleClientId?: string;
  /** Lets anyone sign in with just an email, for local development. Never on in production. */
  devLogin: boolean;
  /** Only these emails (lower case) may sign in. Empty: anyone. */
  allowedEmails: string[];
  /** Only emails at these domains may sign in. Empty: anyone. */
  allowedDomains: string[];
  sessionDays: number;
  /** Largest production JSON accepted, e.g. "20mb". Pictures are stored inside it. */
  maxBody: string;
}

const list = (v?: string) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const databaseUrl = env.DATABASE_URL ?? '';
  if (!databaseUrl) throw new Error('DATABASE_URL is not set (see .env.example)');
  const devLogin = env.DEV_LOGIN === '1' && !production;
  const googleClientId = env.GOOGLE_CLIENT_ID || undefined;
  if (!googleClientId && !devLogin) throw new Error('Set GOOGLE_CLIENT_ID (or DEV_LOGIN=1 for local development)');
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl,
    production,
    googleClientId,
    devLogin,
    allowedEmails: list(env.ALLOWED_EMAILS),
    allowedDomains: list(env.ALLOWED_DOMAINS).map((d) => d.replace(/^@/, '')),
    sessionDays: Number(env.SESSION_DAYS ?? 30),
    maxBody: env.MAX_BODY ?? '20mb',
  };
}

export function emailAllowed(cfg: Pick<Config, 'allowedEmails' | 'allowedDomains'>, email: string): boolean {
  const e = email.toLowerCase();
  if (!cfg.allowedEmails.length && !cfg.allowedDomains.length) return true;
  return cfg.allowedEmails.includes(e) || cfg.allowedDomains.includes(e.split('@')[1] ?? '');
}
