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

  // Success 
  const response = NextResponse.next()
  response.headers.set('X-User-Id', session.userId)
  response.headers.set('X-User-Email', session.email)
  
  return response
}
