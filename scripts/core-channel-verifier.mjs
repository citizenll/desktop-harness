import { createHash, createPublicKey, verify } from 'node:crypto'

const MAX_CHANNEL_BYTES = 512 * 1024
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u

function requiredBase64Url(value, field, maximum) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    !BASE64URL_PATTERN.test(value)
  ) {
    throw new Error(`${field} is invalid.`)
  }
  return value
}

export function verifyCoreChannelEnvelope(envelope, publicPem) {
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    throw new Error('The Core channel envelope is invalid.')
  }
  const keyId = requiredBase64Url(envelope.keyId, 'Core channel key id', 128)
  const payloadText = requiredBase64Url(
    envelope.payload,
    'Core channel payload',
    Math.ceil(MAX_CHANNEL_BYTES * 4 / 3) + 8
  )
  const signatureText = requiredBase64Url(envelope.signature, 'Core channel signature', 512)
  const publicKey = createPublicKey(publicPem)
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('The embedded Core channel public key is not Ed25519.')
  }
  const publicDer = publicKey.export({ type: 'spki', format: 'der' })
  const expectedKeyId = createHash('sha256').update(publicDer).digest('hex').slice(0, 32)
  if (keyId !== expectedKeyId) throw new Error('The Core channel key is not trusted.')

  const payloadBytes = Buffer.from(payloadText, 'base64url')
  if (payloadBytes.length === 0 || payloadBytes.length > MAX_CHANNEL_BYTES) {
    throw new Error('The Core channel payload size is invalid.')
  }
  if (!verify(null, payloadBytes, publicKey, Buffer.from(signatureText, 'base64url'))) {
    throw new Error('The Core channel signature is invalid.')
  }

  let payload
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'))
  } catch {
    throw new Error('The Core channel payload is not valid JSON.')
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    payload.schemaVersion !== 1 ||
    payload.channel !== 'stable' ||
    !Number.isSafeInteger(payload.generation) ||
    payload.generation < 1 ||
    typeof payload.releaseNotes !== 'string' ||
    payload.releaseNotes.length === 0 ||
    typeof payload.artifacts !== 'object' ||
    payload.artifacts === null ||
    Array.isArray(payload.artifacts)
  ) {
    throw new Error('The Core channel payload is invalid.')
  }
  return payload
}
