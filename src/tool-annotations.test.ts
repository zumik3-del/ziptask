import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { McpServer, ToolAnnotations } from '@modelcontextprotocol/server'
import { TaskService } from './core/service'
import { TaskRepo } from './db/repo'
import { createMcpServer } from './mcp/server'
import { closeTestDb, createTestDb } from './test-context'

// #2710/#2714: annotations and descriptions are the client-facing contract of tools/list.
// These tests read the advertised payload, not the registration source, so a preset that
// stops reaching the wire is caught even when the constants themselves stay correct.

const READ_ONLY_TOOLS = ['get_template', 'list_projects']

const DESTRUCTIVE_TOOLS = ['update_status', 'delete_project']

// get_task/list_tasks/list_queue/get_timeline look like reads but reap expired leases
// (src/core/task-query.ts), so they are advertised as mutating (#2712).
const MUTATING_TOOLS = [
  'create_task',
  'get_task',
  'list_tasks',
  'claim_task',
  'update_task',
  'list_queue',
  'add_comment',
  'get_timeline',
  'create_project',
  'update_project'
]

const ALL_TOOLS = [...READ_ONLY_TOOLS, ...MUTATING_TOOLS, ...DESTRUCTIVE_TOOLS].sort()

// Measured from tools/list at #2714: 3840 chars of tool.description plus 2831 chars of
// inputSchema property descriptions. The 10-char headroom is the one the description-only
// budget carried before schema text was counted.
const MEASURED_PAYLOAD = 6671
const PAYLOAD_HEADROOM = 10
const PAYLOAD_BUDGET = MEASURED_PAYLOAD + PAYLOAD_HEADROOM

function annotationsFor(name: string): ToolAnnotations {
  if (READ_ONLY_TOOLS.includes(name))
    return {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  if (DESTRUCTIVE_TOOLS.includes(name))
    return {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    }
  return {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false
  }
}

let db: Database
let server: McpServer
let client: Client

beforeEach(async () => {
  db = createTestDb()
  const svc = new TaskService(new TaskRepo(db), { leaseTtlMin: 15, scope: 'test' })
  server = createMcpServer(svc)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'tool-annotations-test', version: '1.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
})

afterEach(async () => {
  await client.close()
  await server.close()
  closeTestDb(db)
})

type AdvertisedTool = {
  name: string
  description?: string
  annotations?: ToolAnnotations
  inputSchema?: { properties?: Record<string, { description?: string }> }
}

async function advertisedTools(): Promise<AdvertisedTool[]> {
  const listed = await client.listTools()
  return listed.tools as AdvertisedTool[]
}

function annotatedWith(tools: AdvertisedTool[], hint: keyof ToolAnnotations): string[] {
  return tools
    .filter((tool) => tool.annotations?.[hint] === true)
    .map((tool) => tool.name)
    .sort()
}

function payloadChars(tools: AdvertisedTool[]): {
  described: number
  schemas: number
  total: number
} {
  const described = tools.reduce((sum, tool) => sum + (tool.description ?? '').length, 0)
  const schemas = tools.reduce(
    (sum, tool) =>
      sum +
      Object.values(tool.inputSchema?.properties ?? {}).reduce(
        (propSum, prop) => propSum + (prop.description ?? '').length,
        0
      ),
    0
  )
  return { described, schemas, total: described + schemas }
}

describe('tool annotations matrix (#2710)', () => {
  test('the matrix names all 14 advertised tools, each exactly once', async () => {
    const tools = await advertisedTools()
    expect(ALL_TOOLS.length).toBe(14)
    expect(tools.map((tool) => tool.name).sort()).toEqual(ALL_TOOLS)
  })

  test('every advertised tool carries exactly the hints its read/write class requires', async () => {
    for (const tool of await advertisedTools()) {
      expect({ [tool.name]: tool.annotations }).toEqual({ [tool.name]: annotationsFor(tool.name) })
    }
  })

  test('only the two pure reads claim idempotency and only the two closures claim destructiveness', async () => {
    const tools = await advertisedTools()
    expect(annotatedWith(tools, 'readOnlyHint')).toEqual([...READ_ONLY_TOOLS].sort())
    expect(annotatedWith(tools, 'idempotentHint')).toEqual([...READ_ONLY_TOOLS].sort())
    expect(annotatedWith(tools, 'destructiveHint')).toEqual([...DESTRUCTIVE_TOOLS].sort())
    expect(annotatedWith(tools, 'openWorldHint')).toEqual([])
  })

  test('a tool is annotated repeatable only when it cannot write, and never both read-only and destructive', async () => {
    for (const tool of await advertisedTools()) {
      const annotations = tool.annotations
      expect(annotations).toBeDefined()
      expect({ [tool.name]: annotations?.idempotentHint }).toEqual({
        [tool.name]: annotations?.readOnlyHint
      })
      expect({
        [tool.name]: annotations?.readOnlyHint === true && annotations?.destructiveHint === true
      }).toEqual({ [tool.name]: false })
    }
  })
})

describe('tool description payload ceiling (#2710)', () => {
  test('descriptions plus every advertised schema property description stay within budget', async () => {
    const tools = await advertisedTools()
    expect(tools.length).toBe(14)
    for (const tool of tools)
      expect(`${tool.name}: ${typeof tool.description}`).toBe(`${tool.name}: string`)

    const { described, schemas, total } = payloadChars(tools)
    expect(schemas, 'no advertised schema property description is measured').toBeGreaterThan(0)
    expect(
      total,
      `advertised payload is ${total} chars (descriptions ${described} + schema descriptions ${schemas}), over the ${PAYLOAD_BUDGET}-char budget measured as ${MEASURED_PAYLOAD} + ${PAYLOAD_HEADROOM} headroom`
    ).toBeLessThanOrEqual(PAYLOAD_BUDGET)
  })
})

describe('get_template description intent (#2710)', () => {
  test('names the four templates, the tools that consume them, and the text it yields', async () => {
    const tools = await advertisedTools()
    const getTemplate = tools.find((tool) => tool.name === 'get_template')
    expect(getTemplate).toBeDefined()

    const description = getTemplate!.description as string
    for (const name of ['task', 'epic', 'comment-success', 'comment-failure'])
      expect(description).toContain(`\`${name}\``)
    expect(description).toContain('create_task')
    expect(description).toContain('add_comment')
    expect(description.toLowerCase()).toContain('template text')
  })

  test('advertises the four template names as the accepted argument values', async () => {
    const tools = await advertisedTools()
    const getTemplate = tools.find((tool) => tool.name === 'get_template')
    const name = getTemplate?.inputSchema?.properties?.name as { enum?: string[] } | undefined
    expect(name?.enum?.sort()).toEqual(['comment-failure', 'comment-success', 'epic', 'task'])
  })
})
