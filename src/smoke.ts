import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { rmSync } from 'node:fs'
import { openDatabase } from './db/db'
import { TaskRepo } from './db/repo'
import { TaskService } from './core/service'
import { startHttp } from './server'

const TMP_DB = `/tmp/opencode/ziptask-smoke-${Date.now()}.db`
process.env.ZIPTASK_DB = TMP_DB
const db = openDatabase(TMP_DB)
const svc = new TaskService(new TaskRepo(db), { leaseTtlMin: 15 })

function parseToolResult(result: any): any {
  return JSON.parse((result.content as any[])[0].text)
}

function textOf(result: any): string {
  return (result.content as any[])[0].text
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`)
  console.log(`[smoke] ok: ${msg}`)
}

const host = '127.0.0.1'
const server = startHttp({
  svc,
  port: 0,
  host,
  maxSessions: 10,
  onShutdown: () => {
    try { rmSync(TMP_DB) } catch {}
    try { rmSync(TMP_DB + '-wal') } catch {}
    try { rmSync(TMP_DB + '-shm') } catch {}
    db.close()
  }
})

const port = server.port
console.log(`[smoke] server on port ${port}, db: ${TMP_DB}`)

try {
  const healthRes = await fetch(`http://${host}:${port}/health`)
  const health = await healthRes.json() as any
  assert(health.ok === true, '/health')

  const client = new Client({ name: 'smoke-test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`http://${host}:${port}/mcp`))
  await client.connect(transport)
  console.log('[smoke] MCP client connected')

  const created = parseToolResult(await client.callTool({
    name: 'create_task',
    arguments: { title: 'Smoke v2 task', description: 'Smoke description', reporter: 'smoke' }
  }))
  assert(created.status === 'queued' && created.id > 0, `create_task → {id, status:queued} (no task_path), id=${created.id}`)
  const idA = created.id

  const queue1 = textOf(await client.callTool({ name: 'list_queue', arguments: {} }))
  assert(queue1 === `${idA}|p2|Smoke v2 task`, `list_queue pipe id|priority|title: "${queue1}"`)

  const claim = parseToolResult(await client.callTool({
    name: 'claim_task',
    arguments: { agent: 'smoke-agent', task_id: idA, include: ['description'] }
  }))
  assert(
    claim.id === idA && claim.lease_ttl_min === 15 && claim.description === 'Smoke description' && !('lease_until' in claim),
    `claim_task include → {id, lease_ttl_min, description}: ${JSON.stringify(claim)}`
  )

  const g1 = parseToolResult(await client.callTool({ name: 'get_task', arguments: { id: idA, fields: ['version'] } }))
  const review = parseToolResult(await client.callTool({
    name: 'update_status',
    arguments: { id: idA, agent: 'smoke-agent', status: 'review', version: g1.version, comment: 'in review' }
  }))
  assert(review.status === 'review', `update_status → review v${review.version}`)

  const g2 = parseToolResult(await client.callTool({ name: 'get_task', arguments: { id: idA, fields: ['version'] } }))
  const done = parseToolResult(await client.callTool({
    name: 'update_status',
    arguments: { id: idA, agent: 'smoke-agent', status: 'done', version: g2.version, comment: 'result written' }
  }))
  assert(done.status === 'done', `update_status → done v${done.version}`)

  const createdB = parseToolResult(await client.callTool({
    name: 'create_task',
    arguments: { title: 'Second | task', reporter: 'smoke' }
  }))
  const idB = createdB.id
  const queue2 = textOf(await client.callTool({ name: 'list_queue', arguments: {} }))
  assert(queue2 === `${idB}|p2|Second / task`, `list_queue sanitizes | → /: "${queue2}"`)

  const batch = textOf(await client.callTool({ name: 'batch_statuses', arguments: { ids: [idA, idB, 999] } }))
  assert(batch === `${idA}|4\n${idB}|1\n999|0`, `batch_statuses pipe id|code (+unknown → |0): "${batch}"`)

  const batchA = textOf(await client.callTool({ name: 'batch_statuses', arguments: { ids: [idA, idB, 999], include: ['assignee'] } }))
  assert(batchA === `${idA}|4|smoke-agent\n${idB}|1|-\n999|0|-`, `batch_statuses pipe id|code|assignee (null → -): "${batchA}"`)

  const brief = parseToolResult(await client.callTool({ name: 'get_task', arguments: { id: idB } }))
  assert(
    !('description' in brief) && !('task_path' in brief) && !('result_path' in brief) && !('parent_id' in brief),
    `get_task brief: no description, no removed fields: ${JSON.stringify(brief)}`
  )

  const c1 = parseToolResult(await client.callTool({
    name: 'add_comment',
    arguments: { id: idA, agent: 'smoke', content: 'added | pipe test' }
  }))
  assert(c1.comment_id > 0, `add_comment → {comment_id}: ${JSON.stringify(c1)}`)

  const bad = await client.callTool({ name: 'add_comment', arguments: { id: 9999, agent: 'smoke', content: 'x' } })
  assert(bad.isError === true, 'add_comment unknown id → error')

  const tl = textOf(await client.callTool({ name: 'get_timeline', arguments: { id: idA } }))
  assert(tl.split('\n').length >= 2, `get_timeline has multiple lines: "${tl}"`)
  const tlFirst = tl.split('\n')[0].split('|')
  assert(tlFirst[0] === '1' && tlFirst[1] === 'action', `get_timeline first line shape: ${tlFirst}`)
  const tlComment = tl.split('\n').find(l => l.includes('|comment|'))
  assert(tlComment !== undefined, `get_timeline includes comment row: "${tl}"`)

  const tlLim = textOf(await client.callTool({ name: 'get_timeline', arguments: { id: idA, limit: 1 } }))
  assert(tlLim.split('\n').length === 1, `get_timeline limit=1: ${tlLim}`)

  const tlBad = await client.callTool({ name: 'get_timeline', arguments: { id: 9999 } })
  assert(tlBad.isError === true, 'get_timeline unknown id → error')

  const met = textOf(await client.callTool({ name: 'metrics', arguments: { period: 'all' } }))
  assert(met.startsWith('done_count|'), `metrics shape: ${met}`)
  assert(met.includes('status_time|'), `metrics includes status_time: ${met}`)
  assert(met.includes('bottleneck|'), `metrics includes bottleneck: ${met}`)

  const tplTask = textOf(await client.callTool({ name: 'get_template', arguments: { name: 'task' } }))
  assert(tplTask.includes('## Goal'), `get_template task has Goal section`)
  assert(tplTask.includes('## Acceptance criteria'), `get_template task has Acceptance criteria`)
  assert(tplTask.includes('## Constraints'), `get_template task has Constraints`)
  assert(tplTask.includes('## Deliverable'), `get_template task has Deliverable`)

  const tplSuccess = textOf(await client.callTool({ name: 'get_template', arguments: { name: 'comment-success' } }))
  assert(tplSuccess.startsWith('Done.'), `get_template comment-success starts with Done.`)

  const tplFailure = textOf(await client.callTool({ name: 'get_template', arguments: { name: 'comment-failure' } }))
  assert(tplFailure.startsWith('Blocked:'), `get_template comment-failure starts with Blocked:`)

  const tplUnknown = await client.callTool({ name: 'get_template', arguments: { name: 'nonexistent' as any } })
  assert(tplUnknown.isError === true, 'get_template unknown name → error')

  await client.close()
  console.log('[smoke] ALL CHECKS PASSED')
} finally {
  try { rmSync(TMP_DB) } catch {}
  try { rmSync(TMP_DB + '-wal') } catch {}
  try { rmSync(TMP_DB + '-shm') } catch {}
  db.close()
}
