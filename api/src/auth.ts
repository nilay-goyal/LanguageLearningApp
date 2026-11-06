// Who is calling. Testers send their invite code; the server keeps only its hash.

export interface Tester {
  /** First 16 characters of the code's hash. What events and reports are filed under. */
  id: string;
  /** Daily spending limit in USD, or null for the development token. */
  cap: number | null;
  label: string | null;
  dev: boolean;
}

export interface AuthEnv {
  CLIENT_TOKEN?: string;
  DB: D1Database;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Invite codes are read without regard to case, spaces or dashes. */
export function normaliseCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Compares without stopping at the first difference. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export async function authenticate(request: Request, env: AuthEnv): Promise<Tester | null> {
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;

  if (env.CLIENT_TOKEN && sameText(token, env.CLIENT_TOKEN)) return { id: 'dev', cap: null, label: 'dev', dev: true };

  const hash = await sha256Hex(normaliseCode(token));
  const row = await env.DB.prepare('SELECT label, daily_cap_usd FROM testers WHERE code_hash = ? AND revoked = 0')
    .bind(hash)
    .first<{ label: string | null; daily_cap_usd: number }>();
  if (!row) return null;
  return { id: hash.slice(0, 16), cap: row.daily_cap_usd, label: row.label, dev: false };
}
