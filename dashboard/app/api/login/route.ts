import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, sessionToken, accessCodeConfigured, codeMatches } from '@/lib/auth';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const form = await req.formData();
  const code = String(form.get('code') ?? '');
  const nextParam = String(form.get('next') ?? '/');
  const next = nextParam.startsWith('/') ? nextParam : '/';

  if (!accessCodeConfigured()) {
    return NextResponse.redirect(new URL('/login?error=notconfigured', req.url), { status: 303 });
  }
  if (!codeMatches(code)) {
    const url = new URL('/login?error=1', req.url);
    if (next !== '/') url.searchParams.set('next', next);
    return NextResponse.redirect(url, { status: 303 });
  }

  const res = NextResponse.redirect(new URL(next, req.url), { status: 303 });
  res.cookies.set(SESSION_COOKIE, await sessionToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
