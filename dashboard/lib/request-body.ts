import { NextRequest } from 'next/server'

export class RequestBodyLimitError extends Error {}
export class RequestBodyParseError extends Error {}

export async function readJsonBodyWithLimit<T>(
  req: NextRequest,
  limitBytes: number
): Promise<T> {
  const reader = req.body?.getReader()
  if (!reader) {
    throw new RequestBodyParseError('Request body is empty.')
  }

  const chunks: Uint8Array[] = []
  let totalBytes = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue

    totalBytes += value.byteLength
    if (totalBytes > limitBytes) {
      throw new RequestBodyLimitError('Payload Too Large')
    }

    chunks.push(value)
  }

  const merged = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }

  const text = new TextDecoder().decode(merged)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new RequestBodyParseError('Invalid JSON body.')
  }
}
