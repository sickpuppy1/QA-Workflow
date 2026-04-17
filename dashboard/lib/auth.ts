/**
 * Session management using cookies + DB user lookup.
 * Passwords are stored as bcrypt hashes in MongoDB.
 */
import { cookies } from 'next/headers'
import bcrypt from 'bcryptjs'
import { createUserRecord, findUserByEmail } from './data'
import { verifySessionToken, createSessionToken, Session } from './jwt'

const SESSION_COOKIE = 'wa_session'
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7

function getBearerToken(headers: Headers) {
  const authorization = headers.get('authorization')
  if (!authorization) return null

  const [scheme, token] = authorization.split(' ')
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) {
    return null
  }

  return token.trim()
}

export async function getSession(): Promise<Session | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  if (!token) return null
  try {
    return await verifySessionToken(token)
  } catch {}
  return null
}

export async function getRequestSession(req: { headers: Headers }): Promise<Session | null> {
  const bearerToken = getBearerToken(req.headers)
  if (bearerToken) {
    try {
      return await verifySessionToken(bearerToken)
    } catch {
      return null
    }
  }

  return getSession()
}

export async function checkCredentials(email: string, password: string): Promise<{ userId: string; email: string } | null> {
  const user = await findUserByEmail(email)
  if (!user) return null
  const valid = await bcrypt.compare(password, user.passwordHash)
  return valid ? { userId: user.id, email: user.email } : null
}

export async function createUser(email: string, password: string): Promise<{ userId: string; email: string }> {
  const passwordHash = await bcrypt.hash(password, 12)
  const user = await createUserRecord(email, passwordHash)
  return { userId: user.id, email: user.email }
}

export { createSessionToken, verifySessionToken, SESSION_COOKIE, SESSION_TTL_SECONDS, type Session }
