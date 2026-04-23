import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { verifySessionToken } from './lib/jwt'

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api/auth (auth routes like login/signup)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - icon.svg (icon)
     */
    '/((?!api/auth|_next/static|_next/image|favicon.ico|icon.svg).*)',
  ],
}

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname
  const isApiRoute = path.startsWith('/api/')

  // 1. Whitelist public landing/legal pages
  if (
    path === '/landing' ||
    path === '/uninstall' ||
    path === '/privacy' ||
    path === '/contact'
  ) {
    return NextResponse.next()
  }

  // 2. Identify the user
  const authHeader = request.headers.get('authorization')
  let token = null
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    token = authHeader.split(' ')[1]
  } else {
    token = request.cookies.get('wa_session')?.value
  }

  const session = token ? await verifySessionToken(token) : null

  // 3. Handle Auth & Root behavior
  if (path === '/login') {
    if (session) {
      // Already logged in? Take them to the dashboard.
      return NextResponse.redirect(new URL('/', request.url))
    }
    return NextResponse.next()
  }

  if (path === '/') {
    // Root dashboard handles its own "Landing vs Dashboard" logic in app/page.tsx
    return NextResponse.next()
  }

  // 4. Authenticate all other routes (workflows, settings, etc.)
  if (!session) {
    if (isApiRoute) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    // Deep-links to dashboard should prompt login
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // 5. Body-size guard
  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
  if (
    request.method === 'POST' &&
    path.startsWith('/api/workflows') &&
    !path.startsWith('/api/workflows/')
  ) {
    const contentLength = request.headers.get('content-length')
    if (contentLength !== null && Number(contentLength) > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: 'Payload Too Large' },
        { status: 413 },
      )
    }
  }

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('X-User-Id', session.userId)
  requestHeaders.set('X-User-Email', session.email)

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  })
}
