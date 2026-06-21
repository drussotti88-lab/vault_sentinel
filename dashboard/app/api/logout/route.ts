import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const res = NextResponse.redirect(new URL('/login', req.url), { status: 303 });
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  return res;
}
