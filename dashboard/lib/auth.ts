/**
 * Shared auth helpers for the dashboard login gate. Kept dependency-free and
 * free of Node-only APIs so it works in both the edge middleware and Node route
 * handlers. The session is a deterministic hash of the secret access code, so
 * the cookie never stores the raw code and can't be forged without it.
 */
export const SESSION_COOKIE = 'sentinel_session';

export function accessCodeConfigured(): boolean {
  return Boolean(process.env.DASHBOARD_ACCESS_CODE);
}

export function codeMatches(input: string): boolean {
  const code = process.env.DASHBOARD_ACCESS_CODE ?? '';
  return code.length > 0 && input === code;
}

export async function sessionToken(): Promise<string> {
  const code = process.env.DASHBOARD_ACCESS_CODE ?? '';
  return sha256Hex(`sentinel-session:v1:${code}`);
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
