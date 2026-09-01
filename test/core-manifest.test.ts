import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { CoreChannelPayload, CoreDescriptor } from '../src/shared/core-update'
import {
  corePublicKeyId,
  verifySignedCoreChannel
} from '../src/main/core/core-manifest'

const compatibility = {
  platform: 'win32' as const,
  arch: 'x64',
  runnerAbi: '127'
}

function descriptor(generation = 2): CoreDescriptor {
  return {
    schemaVersion: 1,
    generation,
    coreId: `dsh-core-g${generation}-win32-x64`,
    dshVersion: '0.1.1-rc.1',
    patchsetHash: 'a'.repeat(64),
    desktopProtocol: 1,
    runnerVersion: 'v22.23.2',
    runnerAbi: '127',
    dataSchema: 1,
    platform: 'win32',
    arch: 'x64'
  }
}

function signedChannel(options: {
  core?: CoreDescriptor
  now?: number
  archiveUrl?: string
} = {}) {
  const pair = generateKeyPairSync('ed25519')
  const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const now = options.now ?? Date.UTC(2026, 7, 31)
  const core = options.core ?? descriptor()
  const fileName = `dsh-core-g${core.generation}-${core.platform}-${core.arch}.tar.gz`
  const payload: CoreChannelPayload = {
    schemaVersion: 1,
    channel: 'stable',
    generation: core.generation,
    publishedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    releaseNotes: 'Core update',
    artifacts: {
      [`${core.platform}-${core.arch}`]: {
        core,
        archive: {
          format: 'tar.gz',
          fileName,
          size: 128,
          sha256: 'b'.repeat(64),
          url:
            options.archiveUrl ??
            `https://github.com/citizenll/desktop-harness/releases/download/core-g${core.generation}/${fileName}`
        }
      }
    }
  }
  const bytes = Buffer.from(JSON.stringify(payload))
  return {
    now,
    publicPem,
    envelope: {
      keyId: corePublicKeyId(publicPem),
      payload: bytes.toString('base64url'),
      signature: sign(null, bytes, pair.privateKey).toString('base64url')
    }
  }
}

describe('signed Core channel', () => {
  it('verifies an authorized compatible artifact before exposing it', () => {
    const fixture = signedChannel()
    const verified = verifySignedCoreChannel(
      fixture.envelope,
      fixture.publicPem,
      compatibility,
      fixture.now
    )
    expect(verified.artifact?.core.generation).toBe(2)
  })

  it('rejects any payload modified after signing', () => {
    const fixture = signedChannel()
    const payload = Buffer.from(fixture.envelope.payload, 'base64url')
    payload[0] = (payload[0] ?? 0) ^ 1
    expect(() =>
      verifySignedCoreChannel(
        { ...fixture.envelope, payload: payload.toString('base64url') },
        fixture.publicPem,
        compatibility,
        fixture.now
      )
    ).toThrow('signature is invalid')
  })

  it('rejects expired channels and incompatible Runner ABIs', () => {
    const expired = signedChannel()
    expect(() =>
      verifySignedCoreChannel(
        expired.envelope,
        expired.publicPem,
        compatibility,
        expired.now + 120_000
      )
    ).toThrow('expired')

    const incompatible = signedChannel({ core: { ...descriptor(), runnerAbi: '999' } })
    expect(() =>
      verifySignedCoreChannel(
        incompatible.envelope,
        incompatible.publicPem,
        compatibility,
        incompatible.now
      )
    ).toThrow('does not match')
  })

  it('rejects mutable or foreign artifact locations', () => {
    const fixture = signedChannel({
      archiveUrl: 'https://example.com/dsh-core-g2-win32-x64.tar.gz'
    })
    expect(() =>
      verifySignedCoreChannel(
        fixture.envelope,
        fixture.publicPem,
        compatibility,
        fixture.now
      )
    ).toThrow('trusted release namespace')
  })

  it('binds the immutable Core id to generation and target', () => {
    const fixture = signedChannel({
      core: { ...descriptor(), coreId: 'dsh-core-g2-linux-x64' }
    })
    expect(() =>
      verifySignedCoreChannel(
        fixture.envelope,
        fixture.publicPem,
        compatibility,
        fixture.now
      )
    ).toThrow('core.coreId must be dsh-core-g2-win32-x64')
  })
})
