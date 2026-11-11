type UUIDContext = { uuid?: { v4(): string } }
let frontendUuid: (() => string) | undefined

export function bindFrontendUuid(context: object): () => void {
  const uuid = (context as UUIDContext).uuid
  const generate = uuid ? () => uuid.v4() : undefined
  frontendUuid = generate
  return () => { if (frontendUuid === generate) frontendUuid = undefined }
}

export function uuid(): string {
  return frontendUuid?.() ?? localUuid()
}

// Older hosts and standalone model tests can still generate IDs synchronously.
export function localUuid(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export async function backendUuid(api: object): Promise<string> {
  const uuid = (api as { uuid?: { v4(): Promise<string> } }).uuid
  return uuid ? await uuid.v4() : localUuid()
}
