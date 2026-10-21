import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { TaskRepo } from './db/repo'
import { TaskService } from './core/service'
import { TASK_PRIORITIES, type TaskPriority } from './core/tasks'
import { formatError } from './core/result'
import { handleCreateTask, handleGetTask, handleListQueue, handleListTasks } from './mcp/task-tools'
import { registerAllTools } from './mcp/tools'
import { loadSettings } from './config'
import { createTestDb, closeTestDb, getTaskRow, json, text, startTestServer, textOf } from './test-context'
import type { TestServer } from './test-context'

// The refusal the service and the schema share, pinned as the literal text the contract
// publishes: one `INVALID:` prefix, then the accepted set. `formatError` adds the code prefix
// (src/core/result.ts), so the message the service carries must not carry it as well.
const PRIORITY_REFUSAL = 'INVALID: priority must be one of p0, p1, p2, p3 or the number 0..3'
// The message the service carries: bare, like every other service refusal in src/core/guards.ts.
const PRIORITY_MESSAGE = 'priority must be one of p0, p1, p2, p3 or the number 0..3'

let db: Database
let repo: TaskRepo
let svc: TaskService
beforeEach(() => { db = createTestDb(); repo = new TaskRepo(db); svc = new TaskService(repo, { leaseTtlMin: 15, scope: 'test' }) })
afterEach(() => { closeTestDb(db) })

// The create_task inputSchema as the MCP layer registers it: the shape the wire validates
// against and advertises, so a schema/service disagreement shows up here and not only over the wire.
function createTaskShape(): any {
  let shape: any
  registerAllTools({ registerTool: (name: string, cfg: any) => { if (name === 'create_task') shape = cfg.inputSchema } } as any, svc)
  return shape
}

// The advertised priority property: the JSON Schema the registered shape converts to. This is
// what tools/list publishes (the MCP SDK's converter and z.toJSONSchema publish the same
// anyOf), so a disagreement between the advertisement and the runtime shows up here.
function advertisedPriority(): any {
  return (z.toJSONSchema(createTaskShape()) as any).properties.priority
}

// A tiny JSON-Schema matcher for the shapes the advertisement uses: a string enum, an integer
// range and the digit-string branch (an enum of the digit strings, or a pattern over them).
// It answers "does the published schema accept this value" - the question the advertisement
// and the runtime refusal must agree on.
function branchAccepts(branch: any, value: unknown): boolean {
  if (branch?.type === 'string') {
    if (typeof value !== 'string') return false
    if (Array.isArray(branch.enum)) return branch.enum.includes(value)
    if (typeof branch.pattern === 'string') return new RegExp(branch.pattern).test(value)
    return true
  }
  if (branch?.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return false
    if (typeof branch.minimum === 'number' && value < branch.minimum) return false
    if (typeof branch.maximum === 'number' && value > branch.maximum) return false
    return true
  }
  return false
}

// The value set the published schema accepts.
function advertises(property: any, value: unknown): boolean {
  const branches: any[] = Array.isArray(property?.anyOf) ? property.anyOf : [property]
  return branches.some(branch => branchAccepts(branch, value))
}

// The accepted shapes, derived from the canonical list: the canonical "pN", the number N and
// the digit string "N". A new priority would extend this set with it.
const ACCEPTED_PRIORITIES: unknown[] = [
  ...TASK_PRIORITIES,
  ...TASK_PRIORITIES.map((_, index) => index),
  ...TASK_PRIORITIES.map((_, index) => String(index))
]
// The refused shapes: a look-alike digit string, an unknown canonical form, a number out of
// range and a value of another type. The digit strings "4" and "9" are in the list because the
// runtime refuses every digit outside 0..3, so an advertisement that accepts any single digit
// would over-state the accepted set.
const REFUSED_PRIORITIES: unknown[] = [
  ' ', 'p4', 5, -1, 2.5, 'high', '', 'P2', '00', '03', ' 0', '0 ', '4', '9', '10', null, true, false, {}, [], Number.NaN
]

const createWith = (title: string, priority: unknown) =>
  handleCreateTask(svc, { title, reporter: 'dev', priority: priority as any })

// The row counts a refusal must not move: a refused call writes no task row, no audit row and
// no comment, so the three counts are the evidence that nothing was written.
function storeCounts(): { tasks: number; audit: number; comments: number } {
  const count = (table: string) => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  return { tasks: count('tasks'), audit: count('audit_log'), comments: count('comments') }
}

const pipeLine = (id: number): string =>
  text(handleListQueue(svc, { limit: 100 })).split('\n').find(line => line.startsWith(`${id}|`)) ?? ''

describe('the numeric priority input (#1908)', () => {
  test('the number 2, the digit string "2" and the canonical "p2" all store "p2"', () => {
    const asNumber = json(createWith('Number', 2)).id as number
    const asDigitString = json(createWith('DigitString', '2')).id as number
    const asCanonical = json(createWith('Canonical', 'p2')).id as number

    expect(getTaskRow(db, asNumber).priority).toBe('p2')
    expect(getTaskRow(db, asDigitString).priority).toBe('p2')
    expect(getTaskRow(db, asCanonical).priority).toBe('p2')

    // The read-back is part of the contract: every accepted shape comes back as the canonical
    // string, from the task view and from the queue line alike.
    for (const [id, title] of [[asNumber, 'Number'], [asDigitString, 'DigitString'], [asCanonical, 'Canonical']] as const) {
      expect(json(handleGetTask(svc, { id })).priority).toBe('p2')
      expect(pipeLine(id)).toBe(`${id}|p2|${title}`)
    }
  })

  test('the boundaries 0 and 3 store "p0" and "p3"', () => {
    const lowest = json(createWith('Lowest', 0)).id as number
    const highest = json(createWith('Highest', 3)).id as number

    expect(getTaskRow(db, lowest).priority).toBe('p0')
    expect(getTaskRow(db, highest).priority).toBe('p3')
  })

  test('every accepted shape stores the canonical "pN" and nothing else', () => {
    const accepted: Array<[unknown, string]> = [
      ['p0', 'p0'], ['p1', 'p1'], ['p2', 'p2'], ['p3', 'p3'],
      [0, 'p0'], [1, 'p1'], [2, 'p2'], [3, 'p3'],
      ['0', 'p0'], ['1', 'p1'], ['2', 'p2'], ['3', 'p3']
    ]
    for (const [input, canonical] of accepted) {
      const id = json(createWith(`Shape ${JSON.stringify(input)}`, input)).id as number
      expect(getTaskRow(db, id).priority).toBe(canonical)
    }
  })

  test('the stored priority is read back as the canonical form by get_task and by the list_queue pipe line', () => {
    const id = json(createWith('ReadBack', 2)).id as number

    expect(json(handleGetTask(svc, { id })).priority).toBe('p2')
    expect(pipeLine(id)).toBe(`${id}|p2|ReadBack`)
  })

  test('list_tasks reports the canonical form, not the shape the caller wrote', () => {
    const id = json(createWith('Listed', 2)).id as number

    const listed = json(handleListTasks(svc, { fields: ['id', 'priority'] })) as { tasks: Array<{ id: number; priority: string }> }
    const row = listed.tasks.find(task => task.id === id)
    expect(row?.priority).toBe('p2')
  })

  test('a task created without a priority takes the configured default', () => {
    const id = json(handleCreateTask(svc, { title: 'Default' })).id as number
    expect(getTaskRow(db, id).priority).toBe('p2')
  })
})

describe('the strings that only look like a digit', () => {
  // The digit string is matched by shape (a single ASCII digit), never by parsing it: `Number()`
  // trims whitespace and reads other Unicode decimal digits, so a one-character check that asks
  // `Number()` turns " " into 0 (the highest urgency) and "٣" into 3.
  const whitespace = [' ', '\t', '\n', '\r', '\v', '\f', '\u00a0', '\u2000', '\u3000']
  const digitAdjacent = ['0 ', ' 0', '0\n', '00', '03', '-0', '+0', '0x0']
  const otherDigits = ['\u0663', '\u06f3', '\u0664']

  test('a whitespace string is refused, not read as the highest urgency', () => {
    for (const input of whitespace) {
      const res = createWith(`Whitespace ${JSON.stringify(input)}`, input)
      expect(res.isError).toBe(true)
      expect(text(res)).toBe(PRIORITY_REFUSAL)
    }
  })

  test('a digit-adjacent string is refused', () => {
    for (const input of digitAdjacent) {
      const res = createWith(`Adjacent ${JSON.stringify(input)}`, input)
      expect(res.isError).toBe(true)
      expect(text(res)).toBe(PRIORITY_REFUSAL)
    }
  })

  test('another Unicode decimal digit is refused', () => {
    for (const input of otherDigits) {
      const res = createWith(`Unicode ${JSON.stringify(input)}`, input)
      expect(res.isError).toBe(true)
      expect(text(res)).toBe(PRIORITY_REFUSAL)
    }
  })

  test('the canonical form is case sensitive', () => {
    const res = createWith('WrongCase', 'P2')
    expect(res.isError).toBe(true)
    expect(text(res)).toBe(PRIORITY_REFUSAL)
  })

  test('a refused look-alike writes no task row', () => {
    const before = storeCounts()
    for (const input of [...whitespace, ...digitAdjacent, ...otherDigits, 'P2']) createWith('Look alike', input)
    expect(storeCounts()).toEqual(before)
  })
})

describe('the refused priority shapes', () => {
  const refused: unknown[] = [5, -1, 2.5, 1e2, 'p4', 'high', '']

  test('every invalid shape is refused with the one INVALID message', () => {
    for (const input of refused) {
      const res = createWith(`Refused ${JSON.stringify(input)}`, input)
      expect(res.isError).toBe(true)
      expect(text(res)).toBe(PRIORITY_REFUSAL)
    }
  })

  test('a refused priority creates no task row, no audit row and no comment', () => {
    const before = storeCounts()
    for (const input of refused) createWith(`Refused ${JSON.stringify(input)}`, input)
    expect(storeCounts()).toEqual(before)
  })

  test('a value of another type is refused too, and never falls back to the default', () => {
    // Only an absent priority takes the configured default; `null` and every other unusable
    // value is refused, so a caller cannot write a task whose priority is the default by
    // accident (the stored value would not be the one the caller asked for).
    const otherTypes: unknown[] = [null, true, false, {}, [], Number.NaN]
    for (const input of otherTypes) {
      const res = createWith(`Other ${JSON.stringify(input)}`, input)
      expect(res.isError).toBe(true)
      expect(text(res)).toBe(PRIORITY_REFUSAL)
    }
    const before = storeCounts()
    for (const input of otherTypes) createWith('Other type', input)
    expect(storeCounts()).toEqual(before)
  })

  test('the refusal carries the code prefix exactly once', () => {
    // `formatError` is what the tool layer turns a service error into (src/core/result.ts), so
    // the service message must not repeat the code the formatter adds.
    const result = svc.createTask({ title: 'Once', reporter: 'dev', priority: 'p4' as any })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID')
      expect(result.error.message).toBe(PRIORITY_MESSAGE)
      expect(formatError(result.error)).toBe(PRIORITY_REFUSAL)
    }
  })

  test('no shape is refused by one layer and accepted by the other', () => {
    // The schema and the service ask the same guard, so a shape the schema rejects is never
    // accepted further down: the two layers cannot disagree about what a priority is.
    for (const input of refused) {
      expect(createTaskShape().safeParse({ title: 'Schema', priority: input }).success).toBe(false)
      const result = svc.createTask({ title: 'Service', reporter: 'dev', priority: input as any })
      expect(result.ok).toBe(false)
    }
  })
})

describe('the queue order is unchanged by the numeric input', () => {
  test('a priority 0 task sorts before a priority 2 task in list_queue', () => {
    const p2 = json(createWith('Two', 2)).id as number
    const p0 = json(createWith('Zero', 0)).id as number

    const lines = text(handleListQueue(svc, { limit: 100 })).split('\n')
    expect(lines.indexOf(`${p0}|p0|Zero`)).toBeGreaterThanOrEqual(0)
    expect(lines.indexOf(`${p2}|p2|Two`)).toBeGreaterThan(lines.indexOf(`${p0}|p0|Zero`))
  })

  test('the numeric input and the canonical input produce the same queue order', () => {
    const numeric = json(createWith('Numeric', 1)).id as number
    const canonical = json(createWith('Canonical', 'p1')).id as number

    const lines = text(handleListQueue(svc, { limit: 100 })).split('\n')
    const numericLine = lines.indexOf(`${numeric}|p1|Numeric`)
    const canonicalLine = lines.indexOf(`${canonical}|p1|Canonical`)
    expect(numericLine).toBeGreaterThanOrEqual(0)
    expect(canonicalLine).toBeGreaterThanOrEqual(0)
    expect(numericLine).toBeLessThan(canonicalLine)
  })
})

describe('the service path without the schema', () => {
  test('the service accepts the number and the digit string and stores the canonical form', () => {
    const asNumber = svc.createTask({ title: 'Number', reporter: 'dev', priority: 2 })
    const asDigitString = svc.createTask({ title: 'DigitString', reporter: 'dev', priority: '2' })

    expect(asNumber.ok).toBe(true)
    expect(asDigitString.ok).toBe(true)
    if (asNumber.ok) expect(getTaskRow(db, asNumber.data.id).priority).toBe('p2')
    if (asDigitString.ok) expect(getTaskRow(db, asDigitString.data.id).priority).toBe('p2')
  })

  test('the service refuses an unusable priority', () => {
    for (const input of ['p4', 5, ' ']) {
      const result = svc.createTask({ title: 'Refused', reporter: 'dev', priority: input as any })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID')
        expect(formatError(result.error)).toBe(PRIORITY_REFUSAL)
      }
    }
  })
})

describe('the priority at the schema layer', () => {
  // The schema is the gate the wire validates against. The tests above reach the handler
  // directly and therefore never touch it, so a schema-level regression on the digit string
  // (or on the canonical form) would pass every other test in this file. It is pinned here.

  test('the schema accepts the canonical form, the number and the digit string', () => {
    const shape = createTaskShape()
    expect(shape.safeParse({ title: 'Canonical', priority: 'p2' }).success).toBe(true)
    expect(shape.safeParse({ title: 'Number', priority: 2 }).success).toBe(true)
    expect(shape.safeParse({ title: 'DigitString', priority: '2' }).success).toBe(true)
  })

  test('the schema accepts every accepted shape and refuses every refused one', () => {
    const shape = createTaskShape()
    for (const value of ACCEPTED_PRIORITIES) {
      expect(shape.safeParse({ title: 'Accepted', priority: value }).success).toBe(true)
    }
    for (const value of REFUSED_PRIORITIES) {
      expect(shape.safeParse({ title: 'Refused', priority: value }).success).toBe(false)
    }
  })

  test('the schema refuses with the one INVALID message, on the priority field', () => {
    // The schema layer adds the `INVALID: ` prefix itself (the service carries the bare
    // message, src/core/guards.ts), so the two layers end up with the same published text.
    const shape = createTaskShape()
    for (const value of [' ', 'p4', 5]) {
      const result = shape.safeParse({ title: 'Refused', priority: value })
      expect(result.success).toBe(false)
      expect(result.error.issues.map((issue: any) => issue.path)).toEqual([['priority']])
      expect(result.error.issues[0].message).toBe(PRIORITY_REFUSAL)
    }
  })

  test('an absent priority is accepted by the schema, so the default can take its place', () => {
    const shape = createTaskShape()
    expect(shape.safeParse({ title: 'Absent' }).success).toBe(true)
    const schema = z.toJSONSchema(createTaskShape()) as any
    expect(schema.required).toContain('title')
    expect(schema.required).not.toContain('priority')
  })
})

describe('the configured default accepts the same shapes', () => {
  let testDir: string
  beforeEach(() => {
    testDir = join('/tmp/opencode', `priority-config-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testDir, { recursive: true })
  })
  afterEach(() => { try { rmSync(testDir, { recursive: true }) } catch {} })

  const writeSettingsJson = (content: object): string => {
    const path = join(testDir, 'settings.json')
    writeFileSync(path, JSON.stringify(content))
    return path
  }

  test('a settings.json with a numeric defaults.priority loads the canonical form', () => {
    const path = writeSettingsJson({ defaults: { priority: 2 } })
    expect(loadSettings({ path, env: {}, argv: [] }).defaults.priority).toBe('p2')
  })

  test('the loaded default is the priority of a task created without one', () => {
    // The boot path (src/index.ts) hands `settings.defaults.priority` to the service as its
    // defaultPriority; there is no server harness that boots from a settings file, so the
    // handoff is covered here: the loaded default is what the service writes.
    const path = writeSettingsJson({ defaults: { priority: 2 } })
    const settings = loadSettings({ path, env: {}, argv: [] })
    const configured = new TaskService(repo, { leaseTtlMin: 15, scope: 'test', defaultPriority: settings.defaults.priority as TaskPriority })

    const id = json(handleCreateTask(configured, { title: 'Default' })).id as number
    expect(getTaskRow(db, id).priority).toBe('p2')
  })

  test('an env override in the digit-string form loads the canonical form', () => {
    expect(loadSettings({ env: { ZIPTASK_DEFAULTS_PRIORITY: '2' }, argv: [] }).defaults.priority).toBe('p2')
  })

  test('an unusable configured default is refused at startup, naming defaults.priority', () => {
    for (const value of ['p4', 'p9', '5', ' ']) {
      expect(() => loadSettings({ env: { ZIPTASK_DEFAULTS_PRIORITY: value }, argv: [] }))
        .toThrow(/Invalid configuration after env overrides: defaults\.priority: INVALID: priority must be one of/)
    }
    const path = writeSettingsJson({ defaults: { priority: 9 } })
    expect(() => loadSettings({ path, env: {}, argv: [] }))
      .toThrow(/Invalid settings\.json: .*priority must be one of/s)
  })
})

describe('the create_task schema stays JSON-Schema-convertible', () => {
  test('the registered shape converts to JSON Schema', () => {
    // A transform on the shape would make `z.toJSONSchema` throw ("Transforms cannot be
    // represented in JSON Schema"), so the schema validates and the service normalizes.
    expect(() => z.toJSONSchema(createTaskShape())).not.toThrow()
  })

  test('the advertised priority is not a closed enum and no longer free-form', () => {
    // A closed enum cannot express the number 2, so advertising one would refuse the numeric
    // form on the wire while the service accepts it: the two layers would disagree.
    const schema = z.toJSONSchema(createTaskShape()) as any
    expect(schema.properties.priority.enum).toBeUndefined()
    // But the field is no longer free-form either: it states the accepted set in three
    // branches, so a client reads the constraint instead of guessing it from the prose.
    const branches = schema.properties.priority.anyOf as any[]
    expect(Array.isArray(branches)).toBe(true)
    expect(branches).toHaveLength(3)
    for (const branch of branches) {
      expect(branch.type).toBeDefined()
    }
  })

  test('the advertised priority states the accepted set', () => {
    const branches = advertisedPriority().anyOf as any[]
    // The canonical branch: the canonical list itself, so the advertisement cannot drift
    // from the list the service accepts.
    expect(branches).toContainEqual({ type: 'string', enum: [...TASK_PRIORITIES] })
    // The number branch: the integers 0..3.
    expect(branches).toContainEqual({ type: 'integer', minimum: 0, maximum: TASK_PRIORITIES.length - 1 })
    // The digit-string branch: exactly the four digit strings and nothing else. The branch
    // may state them as an enum or as a pattern, so the pin is on the set it accepts.
    const digitBranch = branches.find(branch => branch.type === 'string' && !(branch.enum ?? []).includes(TASK_PRIORITIES[0]))
    expect(digitBranch).toBeDefined()
    for (const digit of TASK_PRIORITIES.map((_, index) => String(index))) {
      expect(branchAccepts(digitBranch, digit)).toBe(true)
    }
    for (const other of ['4', '9', '00', '03', ' 0', '0 ', 'p0', '']) {
      expect(branchAccepts(digitBranch, other)).toBe(false)
    }
  })

  test('the advertisement and the runtime refusal agree on every shape', () => {
    // The advertisement is what a client reads, the schema is what the wire validates and the
    // service is what writes the row. On every shape the three must answer the same way, or
    // the published contract and the enforced one have drifted apart.
    const property = advertisedPriority()
    for (const value of [...ACCEPTED_PRIORITIES, ...REFUSED_PRIORITIES]) {
      const expected = ACCEPTED_PRIORITIES.includes(value)
      const advertised = advertises(property, value)
      const atSchema = createTaskShape().safeParse({ title: 'Agreement', priority: value }).success
      const atService = svc.createTask({ title: 'Agreement', reporter: 'dev', priority: value as any }).ok

      expect(advertised).toBe(expected)
      expect(atSchema).toBe(expected)
      expect(atService).toBe(expected)
    }
  })
})

describe('the create_task priority over the wire', () => {
  let srv: TestServer
  let client: Client

  beforeEach(async () => {
    srv = startTestServer()
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`))
    client = new Client({ name: 'priority-test', version: '1.0.0' })
    await client.connect(transport)
  })

  afterEach(async () => {
    try { await client.close() } catch {}
    srv.stop()
  })

  const taskCount = (): number =>
    (srv.db.query('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n

  test('the number 2 is accepted over the wire and stored as "p2"', async () => {
    const res: any = await client.callTool({
      name: 'create_task',
      arguments: { title: 'WireNumber', reporter: 'dev', priority: 2, project: 'test' }
    })
    expect(res.isError).toBeUndefined()
    const id = JSON.parse(textOf(res)).id
    expect(getTaskRow(srv.db, id).priority).toBe('p2')
  })

  test('an invalid priority is refused over the wire with the SDK-wrapped text', async () => {
    const before = taskCount()
    const res: any = await client.callTool({
      name: 'create_task',
      arguments: { title: 'WireRefused', reporter: 'dev', priority: 'p4', project: 'test' }
    })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toBe(`MCP error -32602: Input validation error: Invalid arguments for tool create_task: ${PRIORITY_REFUSAL} at priority`)
    expect(taskCount()).toBe(before)
  })

  test('the digit string is accepted over the wire and stored as "p2"', async () => {
    // The number is pinned above; the digit string is the shape a client sends when it
    // stringifies the priority, so it travels the same path.
    const res: any = await client.callTool({
      name: 'create_task',
      arguments: { title: 'WireDigitString', reporter: 'dev', priority: '2', project: 'test' }
    })
    expect(res.isError).toBeUndefined()
    const id = JSON.parse(textOf(res)).id
    expect(getTaskRow(srv.db, id).priority).toBe('p2')
  })

  test('the tools/list advertisement states the accepted set', async () => {
    // The advertisement the MCP SDK publishes for create_task: a client reads the accepted
    // set from it, so it must carry the same three branches as the registered shape.
    const list: any = await client.listTools()
    const tool = list.tools.find((entry: any) => entry.name === 'create_task')
    const property = tool.inputSchema.properties.priority

    expect(property.enum).toBeUndefined()
    expect(property.anyOf).toHaveLength(3)
    expect(property.anyOf).toContainEqual({ type: 'string', enum: [...TASK_PRIORITIES] })
    expect(property.anyOf).toContainEqual({ type: 'integer', minimum: 0, maximum: TASK_PRIORITIES.length - 1 })
    for (const value of [...ACCEPTED_PRIORITIES, ...REFUSED_PRIORITIES]) {
      expect(advertises(property, value)).toBe(ACCEPTED_PRIORITIES.includes(value))
    }
  })
})
