export interface VoiceTarget {
  connectionId: string
  url: string
  guestId: number
}

interface OwnedGuest {
  id: number
  isDestroyed(): boolean
  getType(): string
  getURL(): string
  hostWebContents: unknown
  session: unknown
  executeJavaScript(source: string): Promise<unknown>
}

export function isOwnedVoiceGuest(
  guest: OwnedGuest | undefined, target: VoiceTarget, host: unknown, partition: unknown
): boolean {
  try {
    const url = new URL(target.url)
    return !!guest && !!host && !!partition && guest.id === target.guestId && !guest.isDestroyed() && guest.getType() === 'webview' &&
      guest.hostWebContents === host && guest.session === partition &&
      ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
      new URL(guest.getURL()).origin === url.origin
  } catch { return false }
}

export async function readOwnedVoiceToken(
  guest: OwnedGuest | undefined, target: VoiceTarget, host: unknown, partition: unknown
): Promise<string> {
  if (!isOwnedVoiceGuest(guest, target, host, partition)) throw new Error('Voice connection is unavailable')
  const token = await guest!.executeJavaScript("localStorage.getItem('token') || ''")
  if (!isOwnedVoiceGuest(guest, target, host, partition)) throw new Error('Voice connection changed')
  if (typeof token !== 'string' || !token || token.length > 16384) {
    throw new Error('Not authenticated. Open the selected connection and sign in before using voice input.')
  }
  return token
}

type VoiceRun = {
  id: number
  target: VoiceTarget
  token: string
  abort: AbortController
  phase: 'recording' | 'transcribing' | 'ready'
  text?: string
}

function sameTarget(left: VoiceTarget, right: VoiceTarget): boolean {
  return left.connectionId === right.connectionId && left.url === right.url && left.guestId === right.guestId
}

/** One audio submission and one delivery, bound to the original guest/account. */
export class VoiceInputSessions {
  private sequence = 0
  private current?: VoiceRun
  private readonly readToken: (target: VoiceTarget) => Promise<string>

  constructor(readToken: (target: VoiceTarget) => Promise<string>) { this.readToken = readToken }

  get id(): number | undefined { return this.current?.id }

  cancel(id?: number): void {
    if (id !== undefined && this.current?.id !== id) return
    this.sequence++
    this.current?.abort.abort(new Error('Voice input cancelled'))
    this.current = undefined
  }

  async begin(target: VoiceTarget): Promise<number> {
    this.cancel()
    const sequence = this.sequence
    const snapshot = { ...target }
    const token = await this.readToken(snapshot)
    if (sequence !== this.sequence) throw new Error('Voice input superseded')
    const id = ++this.sequence
    this.current = { id, target: snapshot, token, abort: new AbortController(), phase: 'recording' }
    return id
  }

  private async validate(id: number, target: VoiceTarget): Promise<VoiceRun> {
    const run = this.current
    if (!run || run.id !== id || !sameTarget(run.target, target)) throw new Error('Voice input connection changed')
    const token = await this.readToken(run.target)
    if (this.current !== run || run.abort.signal.aborted || token !== run.token) {
      throw new Error('Voice input account changed')
    }
    return run
  }

  async claim(id: number, target: VoiceTarget): Promise<{ token: string; signal: AbortSignal; url: string }> {
    const run = this.current
    if (!run || run.id !== id || run.phase !== 'recording') throw new Error('Voice input already submitted or expired')
    // Reserve before awaiting authentication; uncertain submissions are never replayed.
    run.phase = 'transcribing'
    await this.validate(id, target)
    return { token: run.token, signal: run.abort.signal, url: run.target.url }
  }

  finish(id: number, text: unknown): void {
    const run = this.current
    if (!run || run.id !== id || run.phase !== 'transcribing' || run.abort.signal.aborted) {
      throw new Error('Voice input expired')
    }
    if (typeof text !== 'string') throw new Error('Invalid transcription result')
    run.text = text.trim()
    run.phase = 'ready'
  }

  async deliver(id: number, target: VoiceTarget): Promise<{ target: VoiceTarget; text: string }> {
    const run = await this.validate(id, target)
    if (run.phase !== 'ready') throw new Error('Voice transcription is not ready')
    const result = { target: { ...run.target }, text: run.text! }
    this.cancel(id)
    return result
  }
}
