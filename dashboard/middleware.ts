import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, sessionToken, accessCodeConfigured } from '@/lib/auth';

/**
 * Gate the whole dashboard behind the access code. Fails closed: if no code is
 * configured, nobody gets in (the login page explains how to set it). The login
 * page and its API routes are the only public paths.
 */
export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  if (pathname === '/login' || pathname.startsWith('/api/login') || pathname.startsWith('/api/logout')) {
    return NextResponse.next();
  }

  if (accessCodeConfigured()) {
    const cookie = req.cookies.get(SESSION_COOKIE)?.value;
    if (cookie && cookie === (await sessionToken())) return NextResponse.next();
  }

  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  if (pathname !== '/') url.searchParams.set('next', pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
