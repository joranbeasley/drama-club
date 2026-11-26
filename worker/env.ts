export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GOOGLE_CLIENT_ID?: string;
  ALLOWED_EMAILS?: string;
  ALLOWED_DOMAINS?: string;
  SESSION_DAYS?: string;
  /** "1": sign in with just an email. Set only in .dev.vars, for `wrangler dev`. */
  DEV_LOGIN?: string;
}
