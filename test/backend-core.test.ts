import { describe, expect, test } from 'bun:test'
import type { AssembleRequestDTO, AssembleResultDTO } from 'lumiverse-spindle-types'
import { WorkshopPreviewCoordinator, type WorkshopAssemblyHost } from '../src/backend-core.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function request(requestId: string) {
  return {
    type: 'workshop:assemble' as const,
    requestId,
    chatId: 'chat-1',
    blocks: [],
    promptVariables: {},
  }
}

const result: AssembleResultDTO = { messages: [], breakdown: [] }

describe('WorkshopPreviewCoordinator', () => {
  test('newest preview aborts the older request and suppresses its stale result', async () => {
    const first = deferred<AssembleResultDTO>()
    const second = deferred<AssembleResultDTO>()
    const signals: AbortSignal[] = []
    const sent: unknown[] = []
    let call = 0
    const host: WorkshopAssemblyHost = {
      assemble(input: AssembleRequestDTO) {
        signals.push(input.signal!)
        call += 1
        return call === 1 ? first.promise : second.promise
      },
      sendToFrontend(payload) { sent.push(payload) },
    }
    const coordinator = new WorkshopPreviewCoordinator(host)

    const firstRun = coordinator.handle(request('one'), 'user')
    const secondRun = coordinator.handle(request('two'), 'user')
    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)

    first.resolve(result)
    second.resolve(result)
    await Promise.all([firstRun, secondRun])

    expect(sent).toEqual([{ type: 'workshop:assembly-result', requestId: 'two', result }])
  })

  test('explicit cancellation aborts the matching preview and emits nothing', async () => {
    const pending = deferred<AssembleResultDTO>()
    let signal: AbortSignal | undefined
    const sent: unknown[] = []
    const host: WorkshopAssemblyHost = {
      assemble(input) {
        signal = input.signal
        return pending.promise
      },
      sendToFrontend(payload) { sent.push(payload) },
    }
    const coordinator = new WorkshopPreviewCoordinator(host)

    const run = coordinator.handle(request('one'), 'user')
    await coordinator.handle({ type: 'workshop:cancel-preview', requestId: 'one' }, 'user')
    expect(signal?.aborted).toBe(true)

    pending.resolve(result)
    await run
    expect(sent).toEqual([])
  })

  test('ignores cancellation for an obsolete request id', async () => {
    const pending = deferred<AssembleResultDTO>()
    let signal: AbortSignal | undefined
    const sent: unknown[] = []
    const host: WorkshopAssemblyHost = {
      assemble(input) {
        signal = input.signal
        return pending.promise
      },
      sendToFrontend(payload) { sent.push(payload) },
    }
    const coordinator = new WorkshopPreviewCoordinator(host)

    const run = coordinator.handle(request('current'), 'user')
    await coordinator.handle({ type: 'workshop:cancel-preview', requestId: 'old' }, 'user')
    expect(signal?.aborted).toBe(false)

    pending.resolve(result)
    await run
    expect(sent).toEqual([{ type: 'workshop:assembly-result', requestId: 'current', result }])
  })

  test('routes only current failures to the frontend', async () => {
    const sent: unknown[] = []
    const host: WorkshopAssemblyHost = {
      async assemble() { throw new Error('assembly exploded') },
      sendToFrontend(payload) { sent.push(payload) },
    }
    const coordinator = new WorkshopPreviewCoordinator(host)

    await coordinator.handle(request('bad'), 'user')

    expect(sent).toEqual([{
      type: 'workshop:assembly-error',
      requestId: 'bad',
      error: 'assembly exploded',
    }])
  })

  test('dispose aborts all in-flight user previews without cross-user leakage', async () => {
    const pendingA = deferred<AssembleResultDTO>()
    const pendingB = deferred<AssembleResultDTO>()
    const signals: AbortSignal[] = []
    let call = 0
    const host: WorkshopAssemblyHost = {
      assemble(input) {
        signals.push(input.signal!)
        call += 1
        return call === 1 ? pendingA.promise : pendingB.promise
      },
      sendToFrontend() {},
    }
    const coordinator = new WorkshopPreviewCoordinator(host)

    const a = coordinator.handle(request('a'), 'user-a')
    const b = coordinator.handle(request('b'), 'user-b')
    coordinator.dispose()

    expect(signals.every((signal) => signal.aborted)).toBe(true)
    pendingA.resolve(result)
    pendingB.resolve(result)
    await Promise.all([a, b])
  })
})
