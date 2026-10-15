import { describe, test, expect, spyOn } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { InMemoryEventStore } from './server'
import { startTestServer } from './test-context'

// The SDK event store: boundedness/eviction/replay semantics, plus the wiring that clears it when a
// session closes. Split out of server.test.ts: the semantics are pure store behaviour, and the one
// case that needs a server only needs it to open and close a session.

// Event ids are addressed individually, so a replay answers two questions at once: whether the
// anchor is still in the store (a named stream id) and which events follow it (the ids sent).
async function replayIds(store: InMemoryEventStore, anchor: string) {
  const ids: string[] = []
  const streamId = await store.replayEventsAfter(anchor, { send: async (eventId) => { ids.push(eventId) } })
  return { streamId, ids }
}

describe('event store pruning on session close (#767)', () => {
  // "InMemoryEventStore implements SDK EventStore" needs no test of its own: the declaration is
  // checked by tsc, and store/replay/eviction behaviour is asserted in the bounded event store
  // suite below. What was untested is the wiring that clears the store when a session closes.
  test('event store entries are cleared when session closes', async () => {
    const { InMemoryEventStore } = await import('./server')
    const realStoreEvent = InMemoryEventStore.prototype.storeEvent
    const realClear = InMemoryEventStore.prototype.clear
    const stores: InMemoryEventStore[] = []
    const storedIds: string[] = []
    let clearCalls = 0
    const storeSpy = spyOn(InMemoryEventStore.prototype, 'storeEvent').mockImplementation(
      async function (this: InMemoryEventStore, streamId: string, message: Parameters<InMemoryEventStore['storeEvent']>[1]) {
        if (!stores.includes(this)) stores.push(this)
        const eventId = await realStoreEvent.call(this, streamId, message)
        storedIds.push(eventId)
        return eventId
      }
    )
    const clearSpy = spyOn(InMemoryEventStore.prototype, 'clear').mockImplementation(function (this: InMemoryEventStore) {
      clearCalls++
      realClear.call(this)
    })

    const srv = startTestServer()
    const port = srv.port

    try {
      const client = new Client({ name: 'event-agent', version: '1.0.0' })
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
      await client.connect(transport)

      // Make an MCP call to populate the event store
      const result = await client.callTool({ name: 'list_tasks', arguments: { project: 'test' } })
      expect(result).toBeDefined()

      const store = stores[0]
      const anchor = storedIds[0]
      expect(store).toBeDefined()
      expect(anchor).toBeDefined()

      // While the session is live the anchor is in the store: the stream is named and its tail is
      // replayed. Only a store that really held the event can go on to fail the check below.
      const live = await replayIds(store, anchor)
      expect(live.streamId).not.toBe('')
      expect(live.ids.length).toBeGreaterThan(0)

      // Closing a session is a DELETE on it; client.close() only drops the client socket.
      await transport.terminateSession()

      const afterClose = await replayIds(store, anchor)
      expect(afterClose.streamId).toBe('')
      expect(afterClose.ids).toEqual([])
      expect(clearCalls).toBe(1)
    } finally {
      storeSpy.mockRestore()
      clearSpy.mockRestore()
      srv.stop()
    }
  })
})

describe('bounded event store (#812)', () => {
  // Rounds needed to cover the same-millisecond burst case, and the ceiling on attempts
  // to find them: a burst only exercises id tie-breaking when it does not cross a
  // millisecond boundary, so bursts that do are retried instead of counted.
  const SAME_MS_BURSTS = 200
  const MAX_BURST_ATTEMPTS = SAME_MS_BURSTS * 20

  async function replayFrom(store: InMemoryEventStore, id: string) {
    const ids: string[] = []
    const methods: string[] = []
    const streamId = await store.replayEventsAfter(id, {
      send: async (eid, message) => {
        ids.push(eid)
        methods.push((message as { method: string }).method)
      }
    })
    return { streamId, ids, methods }
  }

  test('InMemoryEventStore evicts oldest events when exceeding MAX_EVENT_STORE_EVENTS', async () => {
    const { InMemoryEventStore, MAX_EVENT_STORE_EVENTS } = await import('./server')
    const store = new InMemoryEventStore()
    const overflow = 100

    // Fill beyond the event limit
    const ids: string[] = []
    for (let i = 0; i < MAX_EVENT_STORE_EVENTS + overflow; i++) {
      ids.push(await store.storeEvent('test-stream', { jsonrpc: '2.0', id: i, method: `m${i}`, params: {} }))
    }

    // Ids address individual events, so a collision would silently drop one.
    expect(new Set(ids).size).toBe(ids.length)

    // events is private, so boundedness is observed through replay behaviour.
    // The oldest ids are gone: an evicted anchor replays nothing.
    const evicted = await replayFrom(store, ids[overflow - 1])
    expect(evicted.streamId).toBe('')
    expect(evicted.ids).toEqual([])

    // An id the store never issued behaves like an evicted one.
    expect((await replayFrom(store, 'never-stored')).streamId).toBe('')

    // The retained window is exactly MAX_EVENT_STORE_EVENTS - 1 events after the
    // first surviving anchor, in insertion order.
    const retained = await replayFrom(store, ids[overflow])
    expect(retained.streamId).toBe('test-stream')
    expect(retained.ids).toEqual(ids.slice(overflow + 1))
    expect(retained.ids.length).toBe(MAX_EVENT_STORE_EVENTS - 1)
  })

  test('InMemoryEventStore replay returns empty string for evicted event id', async () => {
    const { InMemoryEventStore } = await import('./server')
    const store = new InMemoryEventStore()

    // Fill beyond limit
    const ids: string[] = []
    for (let i = 0; i < 1100; i++) {
      const id = await store.storeEvent('stream-a', { jsonrpc: '2.0', id: i, method: 'test', params: {} })
      ids.push(id)
    }

    // Oldest events should be evicted, so first few ids no longer exist
    const sent: Array<{ id: string; msg: any }> = []
    const resultStreamId = await store.replayEventsAfter(ids[0], {
      send: async (eid, msg) => { sent.push({ id: eid, msg }) }
    })
    // Should return empty since the oldest event was evicted
    expect(resultStreamId).toBe('')
    expect(sent.length).toBe(0)
  })

  test('InMemoryEventStore replay works for events within the window', async () => {
    const { InMemoryEventStore } = await import('./server')
    const store = new InMemoryEventStore()

    // Add events and track their IDs
    const id1 = await store.storeEvent('stream-b', { jsonrpc: '2.0', id: 1, method: 'a', params: {} })
    const _id2 = await store.storeEvent('stream-b', { jsonrpc: '2.0', id: 2, method: 'b', params: {} })
    const _id3 = await store.storeEvent('stream-b', { jsonrpc: '2.0', id: 3, method: 'c', params: {} })

    const sent: Array<{ id: string; method: string }> = []
    const resultStreamId = await store.replayEventsAfter(id1, {
      send: async (eid, msg) => {
        sent.push({ id: eid, method: (msg as any).method })
      }
    })
    expect(resultStreamId).toBe('stream-b')
    // Should have sent at least one event after id1
    expect(sent.length).toBeGreaterThanOrEqual(1)
    expect(sent.some(s => s.method === 'b')).toBe(true)
    expect(sent.some(s => s.method === 'c')).toBe(true)
  })

  test('replayEventsAfter delivers the whole same-millisecond burst tail in insertion order (#812 regression)', async () => {
    const { InMemoryEventStore } = await import('./server')
    // The regression (dropped tail) only appears when several events of one stream
    // share a millisecond, so the ids stop being ordered by their timestamp prefix.
    // One burst is not enough: whether it lands inside a single millisecond, and
    // whether the id suffix then sorts in insertion order, are both random. Running
    // many bursts makes detection deterministic instead of occasional.
    const tailSize = 4
    let checked = 0
    let attempts = 0
    while (checked < SAME_MS_BURSTS && attempts < MAX_BURST_ATTEMPTS) {
      attempts++
      const store = new InMemoryEventStore()
      const streamId = `stream-${attempts}`
      const ids: string[] = []
      const methods: string[] = []
      const startedAt = Date.now()
      for (let i = 0; i <= tailSize; i++) {
        const method = `m${i}`
        methods.push(method)
        ids.push(await store.storeEvent(streamId, { jsonrpc: '2.0', id: i, method, params: {} }))
      }
      const endedAt = Date.now()
      if (startedAt !== endedAt) continue // burst crossed a millisecond: does not exercise the tie-break

      checked++
      const tail = await replayFrom(store, ids[0])
      // Whole tail, insertion order, and the stream id the anchor belongs to.
      // A dropped or reordered event fails here; the older assertions could not
      // detect a tail that lost its last event.
      expect({ streamId: tail.streamId, ids: tail.ids, methods: tail.methods }).toEqual({
        streamId,
        ids: ids.slice(1),
        methods: methods.slice(1)
      })
    }
    expect(checked).toBe(SAME_MS_BURSTS)
  })

  test('replayEventsAfter keeps same-millisecond bursts of different streams separate', async () => {
    const { InMemoryEventStore } = await import('./server')
    let checked = 0
    let attempts = 0
    while (checked < SAME_MS_BURSTS && attempts < MAX_BURST_ATTEMPTS) {
      attempts++
      const store = new InMemoryEventStore()
      const startedAt = Date.now()
      const idA = await store.storeEvent('stream-a', { jsonrpc: '2.0', id: 1, method: 'a1', params: {} })
      const idB = await store.storeEvent('stream-b', { jsonrpc: '2.0', id: 2, method: 'b1', params: {} })
      const idA2 = await store.storeEvent('stream-a', { jsonrpc: '2.0', id: 3, method: 'a2', params: {} })
      const idB2 = await store.storeEvent('stream-b', { jsonrpc: '2.0', id: 4, method: 'b2', params: {} })
      if (startedAt !== Date.now()) continue

      checked++
      // Replaying from a stream-a anchor must not leak stream-b events, even though
      // both streams share the millisecond and therefore the id prefix ordering.
      expect(await replayFrom(store, idA)).toEqual({ streamId: 'stream-a', ids: [idA2], methods: ['a2'] })
      expect(await replayFrom(store, idB)).toEqual({ streamId: 'stream-b', ids: [idB2], methods: ['b2'] })
    }
    expect(checked).toBe(SAME_MS_BURSTS)
  })
})
