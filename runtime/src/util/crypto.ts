import {
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

export function hmacHex(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex')
}

export function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

export function base64url(buf: Buffer): string {
  return buf.toString('base64url')
}

/** 键序稳定的 JSON 序列化——确认票据 argsHash、缓存摘要都依赖它（§4.6/§7.1）。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

/** AES-256-GCM 信封：iv.tag.ciphertext（均 base64url）。 */
export class Box {
  private readonly key: Buffer

  constructor(keyB64: string) {
    const key = Buffer.from(keyB64, 'base64')
    if (key.length !== 32) throw new Error('ENCRYPTION_KEY must decode to 32 bytes')
    this.key = key
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `${base64url(iv)}.${base64url(tag)}.${base64url(ct)}`
  }

  decrypt(payload: string): string {
    const [ivB, tagB, ctB] = payload.split('.')
    if (!ivB || !tagB || !ctB) throw new Error('malformed ciphertext envelope')
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB, 'base64url'))
    decipher.setAuthTag(Buffer.from(tagB, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64url')), decipher.final()]).toString('utf8')
  }
}
