import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'

const TEST_USER_ID = '00000000-0000-4000-8000-000000000001' as AnonymousUserId
const IMAGE_REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 3,
  width: 1,
  height: 1
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // The request body is the behavior under test; chunks only need draining.
  }
}

describe('DeepSeek vision release train', () => {
  it('advertises the vision model and sends durable images as data URLs', async () => {
    let requestBody: unknown
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8')
      })
      request.on('end', () => {
        requestBody = JSON.parse(body)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const event of [
          '{"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}',
          '{"choices":[{"delta":{"content":"ok"}}]}',
          '{"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
          '[DONE]'
        ]) {
          response.write(`data: ${event}\n\n`)
        }
        response.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

    try {
      const address = server.address() as AddressInfo
      const readImage = vi.fn(async () => ({
        ref: IMAGE_REF,
        data: Uint8Array.of(1, 2, 3)
      }))
      const adapter = new DeepSeekAdapter({
        options: () => resolveAdapterOptions({ baseURL: `http://127.0.0.1:${address.port}` }),
        resolveApiKey: async () => 'test-key',
        resolveUserId: () => TEST_USER_ID,
        resolveAttachments: () => ({ readImage }) as unknown as AttachmentStore
      })

      await expect(adapter.listModels('deepseek-official')).resolves.toContainEqual(
        expect.objectContaining({
          id: 'deepseek-v4-flash-vision-exp',
          inputModalities: ['text', 'image']
        })
      )

      await drain(
        adapter.stream({
          provider: 'deepseek-official',
          model: 'deepseek-v4-flash-vision-exp',
          messages: [
            createUserMessage({
              content: [
                { type: 'text', text: 'describe ' },
                { type: 'image', attachment: IMAGE_REF }
              ],
              source: { kind: 'plugin', plugin: 'dsh-desktop-test' }
            })
          ]
        })
      )

      expect(readImage).toHaveBeenCalledOnce()
      expect(requestBody).toMatchObject({
        model: 'deepseek-v4-flash-vision-exp',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe ' },
              {
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,AQID' }
              }
            ]
          }
        ]
      })
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })
})
