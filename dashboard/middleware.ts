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

  if (path === '/' || path === '/login' || path === '/landing' || path === '/uninstall') {
    return NextResponse.next()
  }

  // Get token
  const authHeader = request.headers.get('authorization')
  let token = null
  
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    token = authHeader.split(' ')[1]
  } else {
    token = request.cookies.get('wa_session')?.value
  }

  // Verify
  if (!token) {
    if (isApiRoute) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return NextResponse.redirect(new URL('/', request.url))
  }

  const session = await verifySessionToken(token)
  if (!session) {
    if (isApiRoute) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return NextResponse.redirect(new URL('/', request.url))
  }

  // ---------------------------------------------------------------------------
  // Body-size guard (Edge layer — cheapest rejection point).
  // Reject POST requests to /api/workflows before they reach the Node.js
  // runtime.  An attacker sending a giant payload is stopped here, so the V8
  // heap inside the lambda is never touched.
  // ---------------------------------------------------------------------------
  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 // 10 MB
  if (
    request.method === 'POST' &&
    path.startsWith('/api/workflows') &&
    !path.startsWith('/api/workflows/')  // exclude nested sub-routes if any
  ) {
    const contentLength = request.headers.get('content-length')
    if (contentLength !== null && Number(contentLength) > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: 'Payload Too Large — maximum upload size is 10 MB' },
        { status: 413 },
      )
    }
  }

  // Success — write identity onto the *forwarded request*, not the response.
  // Using NextResponse.next({ request: { headers } }) is the only way to
  // mutate headers that downstream API routes will actually see.  Setting
  // headers on the NextResponse object itself only affects the browser
  // response, leaving the original (potentially spoofed) request headers
  // intact.  See: https://nextjs.org/docs/app/building-your-application/routing/middleware#setting-headers
  const requestHeaders = new Headers(request.headers)
  // Overwrite any attacker-supplied values with the server-verified ones.
  requestHeaders.set('X-User-Id', session.userId)
  requestHeaders.set('X-User-Email', session.email)

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  })
}

