import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { McpServer, ToolAnnotations } from '@modelcontextprotocol/server'
import { TaskService } from './core/service'
import { TaskRepo } from './db/repo'
import { createMcpServer } from './mcp/server'
import { closeTestDb, createTestDb } from './test-context'

// #2710: annotations and descriptions are the client-facing contract of tools/list.
// These tests read the advertised payload, not the registration source, so a preset that
// stops reaching the wire is caught even when the constants themselves stay correct.

const READ_ONLY_TOOLS = [
  'get_task',
  'list_tasks',
  'list_queue',
  'get_timeline',
  'get_template',
  'list_projects'
]

const MUTATING_TOOLS = [
  'create_task',
  'claim_task',
  'update_task',
  'add_comment',
  'create_project',
  'update_project'
]

const DESTRUCTIVE_TOOLS = ['update_status', 'delete_project']

const ALL_TOOLS = [...READ_ONLY_TOOLS, ...MUTATING_TOOLS, ...DESTRUCTIVE_TOOLS].sort()

const DESCRIPTION_BUDGET = 3850

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

async function advertisedTools(): Promise<any[]> {
  const listed = await client.listTools()
  return listed.tools as any[]
}

describe('tool annotations matrix (#2710)', () => {
  test('the matrix names all 14 advertised tools, each exactly once', async () => {
    const tools = await advertisedTools()
    expect(ALL_TOOLS.length).toBe(14)
    expect(tools.map((tool) => tool.name).sort()).toEqual(ALL_TOOLS)
  })

  test('every advertised tool carries exactly the hints its read/write class requires', async () => {
    for (const tool of await advertisedTools()) {
      expect(`${tool.name}: ${JSON.stringify(tool.annotations)}`).toBe(
        `${tool.name}: ${JSON.stringify(annotationsFor(tool.name))}`
      )
    }
  })

  test('read-only tools are the only idempotent ones and destructive tools the only destructive ones', async () => {
    const tools = await advertisedTools()
    expect(
      tools
        .filter((tool) => tool.annotations?.idempotentHint === true)
        .map((t) => t.name)
        .sort()
    ).toEqual([...READ_ONLY_TOOLS].sort())
    expect(
      tools
        .filter((tool) => tool.annotations?.destructiveHint === true)
        .map((tool) => tool.name)
        .sort()
    ).toEqual([...DESTRUCTIVE_TOOLS].sort())
    expect(tools.filter((tool) => tool.annotations?.openWorldHint === true)).toEqual([])
  })
})

describe('tool description payload ceiling (#2710)', () => {
  test('the 14 descriptions together stay within the 3850-character budget', async () => {
    const tools = await advertisedTools()
    expect(tools.length).toBe(14)
    for (const tool of tools)
      expect(`${tool.name}: ${typeof tool.description}`).toBe(`${tool.name}: string`)

    const total = tools.reduce((sum, tool) => sum + (tool.description as string).length, 0)
    expect(
      total,
      `tool description payload is ${total} chars, over the ${DESCRIPTION_BUDGET}-char budget`
    ).toBeLessThanOrEqual(DESCRIPTION_BUDGET)
  })
})

describe('get_template description intent (#2710)', () => {
  test('names when to use it and that it returns the template text', async () => {
    const tools = await advertisedTools()
    const getTemplate = tools.find((tool) => tool.name === 'get_template')
    expect(getTemplate).toBeDefined()

    const description = getTemplate!.description as string
    expect(description).toContain('create_task')
    expect(description).toContain('add_comment')
    expect(description.toLowerCase()).toContain('template')
    expect(description).toMatch(/return/i)
  })
})
