import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as McpClient from '../src/index.ts'
import { connectionStatusIn } from '../src/status.ts'
import { McpToolLoader } from '../src/tool-loading.ts'
import { McpToolRegistrationError, syncTools, type ToolBridgeOptions, type ToolDisposers } from '../src/tools.ts'
import { startHttpMcpFixture } from './http-fixture.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

async function host(): Promise<Context> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  return ctx
}

/** An agent with its own scope, announced as disposed after the scope unwinds. */
async function createAgent(ctx: Context): Promise<{ agent: Agent; scope: Scope; dispose: () => Promise<void> }> {
  const agent = {} as Agent
  let scope!: Scope
  await ctx.plugin({ inject: ['tools'], apply(inner: Context) { scope = createScope(inner, agent) } })
  return { agent, scope, dispose: async () => {
    await scope.dispose()
    ctx.emit('agent/disposed', { agent })
  } }
}

interface MockTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

function createMockClient(tools: MockTool[]) {
  return {
    listTools: vi.fn(async () => ({ tools, nextCursor: undefined })),
    callTool: vi.fn(async (params: { name: string }) => ({ content: [{ type: 'text', text: `called ${params.name}` }] })),
    getServerCapabilities: (): object => ({ tools: {} }),
  }
}

const object = { type: 'object' }

/** One on-demand server in its own plugin context: a loader plus the generation each sync publishes to it. */
async function onDemand(ctx: Context, maxLength = 160) {
  let owner!: Context
  await ctx.plugin({ inject: ['tools'], apply(inner: Context) { owner = inner } })
  const loader = new McpToolLoader(owner, 'srv', maxLength, 8)
  const opts: ToolBridgeOptions = { signal: new AbortController().signal, serverName: 'srv', toolCallTimeoutMs: 60_000, loader }
  let disposers: ToolDisposers = new Map()
  return {
    owner,
    loader,
    async sync(tools: MockTool[]): Promise<ToolDisposers> {
      disposers = await syncTools(createMockClient(tools) as never, owner, opts, disposers)
      return disposers
    },
    clear(): void {
      for (const dispose of disposers.values()) dispose()
      disposers = new Map()
    },
  }
}

function load(ctx: Context, agent: Agent | undefined, query: string, limit?: number) {
  return executeToolFixture(ctx, {
    name: 'mcp__srv__search_tools', arguments: { query, ...limit === undefined ? {} : { limit } }, callId: ToolCallId('load'), signal: new AbortController().signal,
    ...agent === undefined ? {} : { agent },
  })
}

it('registers only search and keeps tool names, descriptions and schemas out of the initial prompt', async () => {
  const ctx = await host()
  const server = await onDemand(ctx, 24)
  const disposers = await server.sync([
    { name: 'search', description: '  Search   the workspace.\nLonger details stay out of the catalog.', inputSchema: object },
    { name: 'fetch', description: 'Fetch one page by its identifier from the workspace.', inputSchema: object },
    { name: 'ping', inputSchema: object },
  ])

  expect([...disposers.keys()]).toEqual(['mcp__srv__search_tools'])
  expect(server.loader.size).toBe(3)
  expect(ctx.tools.get('mcp__srv__search')).toBeUndefined()
  expect(ctx.tools.get('mcp__srv__search_tools')?.description)
    .toBe('Search for tools from MCP server srv and make matching tools available for your next call. Returns their callable names and summaries.')
  expect(server.loader.catalog(undefined)).toBe('### Tools from MCP server srv\n\nSearch with mcp__srv__search_tools to find and load tools before using them.')
  expect(server.loader.catalog(undefined)).not.toContain('Fetch one page')
})

it('omits the catalog for an agent that cannot see the loader and while no generation is published', async () => {
  const ctx = await host()
  const server = await onDemand(ctx)
  expect(server.loader.catalog(undefined)).toBe('')
  await server.sync([{ name: 'search', inputSchema: object }])
  const { agent, scope } = await createAgent(ctx)
  scope.ctx.tools.restrict({ deny: ['mcp__srv__search_tools'] })

  expect(server.loader.catalog(agent)).toBe('')
  expect(server.loader.catalog(undefined)).not.toBe('')
})

it('registers loaded tools in the calling agent\'s own scope', async () => {
  const ctx = await host()
  const server = await onDemand(ctx)
  await server.sync([{ name: 'search', inputSchema: object }, { name: 'fetch', inputSchema: object }])
  const first = await createAgent(ctx)
  const second = await createAgent(ctx)

  expect(await load(ctx, first.agent, 'search')).toMatchObject({ isError: false, value: 'Available for your next call:\n- mcp__srv__search' })
  expect(await load(ctx, first.agent, 'search fetch'))
    .toMatchObject({ isError: false, value: 'Available for your next call:\n- mcp__srv__search\n- mcp__srv__fetch' })
  expect(await load(ctx, first.agent, 'search')).toMatchObject({ isError: false, value: 'Available for your next call:\n- mcp__srv__search' })
  expect(ctx.tools.get('mcp__srv__search', first.agent)).toBeDefined()
  expect(ctx.tools.get('mcp__srv__search')).toBeUndefined()
  expect(ctx.tools.get('mcp__srv__search', second.agent)).toBeUndefined()
  expect(await executeToolFixture(ctx, {
    name: 'mcp__srv__search', arguments: {}, callId: ToolCallId('search'), signal: new AbortController().signal, agent: first.agent,
  })).toMatchObject({ isError: false, value: { content: [{ type: 'text', text: 'called search' }] } })
})

it('rejects absent agents and invalid search arguments without loading tools', async () => {
  const ctx = await host()
  const server = await onDemand(ctx)
  await server.sync([{ name: 'search', inputSchema: object }])
  const { agent } = await createAgent(ctx)
  expect(await load(ctx, undefined, 'search')).toMatchObject({ isError: true, error: { info: { code: 'TOOL_CONTEXT_UNAVAILABLE' } } })
  for (const query of ['', '   ']) {
    expect(await load(ctx, agent, query)).toMatchObject({ isError: true, error: { info: { code: 'INVALID_ARGS' } } })
  }
  for (const limit of [0, 1.5, 9]) {
    expect(await load(ctx, agent, 'search', limit)).toMatchObject({ isError: true, error: { info: { code: 'INVALID_ARGS' } } })
  }
  expect(await load(ctx, agent, 'missing')).toMatchObject({ isError: false, value: 'No matching tools. Try different keywords or an exact tool name.' })
  expect(ctx.tools.get('mcp__srv__search', agent)).toBeUndefined()
})

it('re-registers loaded tools from each new generation and drops the ones it no longer offers', async () => {
  const ctx = await host()
  const server = await onDemand(ctx)
  await server.sync([{ name: 'search', description: 'Old.', inputSchema: object }, { name: 'fetch', inputSchema: object }])
  const { agent } = await createAgent(ctx)
  await load(ctx, agent, 'search fetch')

  await server.sync([{ name: 'search', description: 'New.', inputSchema: object }])
  expect(ctx.tools.get('mcp__srv__search', agent)?.description).toBe('New.')
  expect(ctx.tools.get('mcp__srv__fetch', agent)).toBeUndefined()

  await server.sync([{ name: 'search', inputSchema: object }, { name: 'fetch', inputSchema: object }])
  expect(ctx.tools.get('mcp__srv__fetch', agent)).toBeUndefined()
})

it('withdraws the loader and loaded tools with the generation and restores loaded tools from the next one', async () => {
  const ctx = await host()
  const server = await onDemand(ctx)
  await server.sync([{ name: 'search', inputSchema: object }])
  const { agent } = await createAgent(ctx)
  await load(ctx, agent, 'search')

  server.clear()
  expect(ctx.tools.get('mcp__srv__search_tools')).toBeUndefined()
  expect(ctx.tools.get('mcp__srv__search', agent)).toBeUndefined()
  expect(server.loader.size).toBe(0)

  await server.sync([{ name: 'search', inputSchema: object }])
  expect(ctx.tools.get('mcp__srv__search', agent)).toBeDefined()
})

it('releases an agent\'s loaded tools when the agent is disposed', async () => {
  const ctx = await host()
  const server = await onDemand(ctx)
  await server.sync([{ name: 'search', inputSchema: object }])
  const subject = await createAgent(ctx)
  await load(ctx, subject.agent, 'search')

  await subject.dispose()
  await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__search', subject.agent)).toBeUndefined() })
  await server.sync([{ name: 'search', inputSchema: object }])
  expect(ctx.tools.get('mcp__srv__search', subject.agent)).toBeUndefined()
})

it('keeps a failed restore to its own agent', async () => {
  const ctx = await host()
  const server = await onDemand(ctx)
  await server.sync([{ name: 'search', inputSchema: object }])
  const blocked = await createAgent(ctx)
  const other = await createAgent(ctx)
  await load(ctx, blocked.agent, 'search')
  await load(ctx, other.agent, 'search')
  server.clear()
  const squatter = defineTool({
    name: 'mcp__srv__search', description: 'Squats.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'squat',
  })
  createScope(server.owner, blocked.agent).ctx.tools.register(squatter)
  const error = vi.spyOn(server.owner.logger, 'error')

  await server.sync([{ name: 'search', inputSchema: object }])
  expect(error).toHaveBeenCalledWith(expect.stringContaining('mcp-client(srv): could not restore loaded tool "search" for an agent'))
  expect(ctx.tools.get('mcp__srv__search', blocked.agent)).toBe(squatter)
  expect(ctx.tools.get('mcp__srv__search', other.agent)).toBeDefined()
  expect(ctx.tools.get('mcp__srv__search_tools')).toBeDefined()
})

it('leaves a server tool named like the loader out of the catalog', async () => {
  const ctx = await host()
  const server = await onDemand(ctx)
  const warn = vi.spyOn(server.owner.logger, 'warn')

  await server.sync([{ name: 'search_tools', inputSchema: object }, { name: 'search', inputSchema: object }])
  expect(server.loader.size).toBe(1)
  expect(warn).toHaveBeenCalledWith('mcp-client(srv): server tool "search_tools" is not offered because its name is the on-demand loader\'s')
})

it('fails the generation when another registration holds the loader name', async () => {
  const ctx = await host()
  ctx.tools.register(defineTool({
    name: 'mcp__srv__search_tools', description: 'Foreign.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'foreign',
  }))
  const server = await onDemand(ctx)
  const error = vi.spyOn(server.owner.logger, 'error').mockImplementation(() => {})

  await expect(server.sync([{ name: 'search', inputSchema: object }])).rejects.toBeInstanceOf(McpToolRegistrationError)
  expect(error).toHaveBeenCalledWith(expect.stringContaining('mcp-client(srv): tool registration failed, no tools registered'))
})

it('loads and calls an on-demand server\'s tool through the plugin and withdraws it on unload', async () => {
  const ctx = await host()
  const { agent } = await createAgent(ctx)
  const fixture = await startHttpMcpFixture()
  onTestFinished(fixture.close)
  const fiber = await ctx.plugin(McpClient, McpClient.Config({
    transport: 'streamable-http', serverName: 'demo', url: fixture.url,
    failOnStartupError: true, reconnect: { enabled: false },
  }))

  expect(connectionStatusIn(fiber)!.current()).toMatchObject({ state: 'connected', toolCount: 1 })
  expect(ctx.tools.get('mcp__demo__ping', agent)).toBeUndefined()
  const prompt = await ctx.systemPrompt.assemble({ scope: agent })
  expect(prompt.sections.map(section => section.text)).toContain('### Tools from MCP server demo\n\nSearch with mcp__demo__search_tools to find and load tools before using them.')
  expect(await executeToolFixture(ctx, {
    name: 'mcp__demo__search_tools', arguments: { query: 'ping' }, callId: ToolCallId('load'), signal: new AbortController().signal, agent,
  })).toMatchObject({ isError: false, value: 'Available for your next call:\n- mcp__demo__ping: Replies pong.' })
  expect(await executeToolFixture(ctx, {
    name: 'mcp__demo__ping', arguments: {}, callId: ToolCallId('ping'), signal: new AbortController().signal, agent,
  })).toMatchObject({ isError: false })

  await fiber.dispose()
  expect(ctx.tools.get('mcp__demo__search_tools')).toBeUndefined()
  expect(ctx.tools.get('mcp__demo__ping', agent)).toBeUndefined()
})

it('searches descriptions in English and Chinese, honors limits and accepts exact callable names', async () => {
  const ctx = await host()
  const server = await onDemand(ctx, 24)
  await server.sync([
    { name: 'alpha', description: 'Find documents.\nSearch workspace content.', inputSchema: object },
    { name: 'beta', description: 'Fetch documents by identifier.', inputSchema: object },
    { name: 'gamma', description: '搜索中文文档内容。', inputSchema: object },
  ])
  const { agent } = await createAgent(ctx)
  expect(await load(ctx, agent, 'workspace')).toMatchObject({ value: 'Available for your next call:\n- mcp__srv__alpha: Find documents.' })
  expect(await load(ctx, agent, '中文文档')).toMatchObject({ value: 'Available for your next call:\n- mcp__srv__gamma: 搜索中文文档内容。' })
  expect(await load(ctx, agent, 'mcp__srv__beta')).toMatchObject({ value: 'Available for your next call:\n- mcp__srv__beta: Fetch documents by id...' })
  const limited = await createAgent(ctx)
  await load(ctx, limited.agent, 'documents', 1)
  expect(['alpha', 'beta'].filter(name => ctx.tools.get(`mcp__srv__${name}`, limited.agent))).toHaveLength(1)
})

it('keeps the initial catalog constant for 500 tools and loads only the default result limit', async () => {
  const ctx = await host()
  const server = await onDemand(ctx)
  await server.sync([{ name: 'entry_0', description: 'Find documents', inputSchema: object }])
  const small = server.loader.catalog(undefined)
  await server.sync(Array.from({ length: 500 }, (_, index) => ({
    name: `entry_${index}`, description: 'Find documents', inputSchema: object,
  })))
  expect(server.loader.catalog(undefined)).toBe(small)
  expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['mcp__srv__search_tools'])
  const { agent } = await createAgent(ctx)
  await load(ctx, agent, 'documents')
  expect(ctx.tools.schemas(agent)).toHaveLength(9)
})

it('rolls back the complete batch when a matching tool cannot be registered', async () => {
  const ctx = await host()
  const server = await onDemand(ctx)
  await server.sync([{ name: 'alpha', description: 'documents', inputSchema: object }, { name: 'beta', description: 'documents', inputSchema: object }])
  const { agent } = await createAgent(ctx)
  const collision = createScope(server.owner, agent).ctx.tools.register(defineTool({
    name: 'mcp__srv__beta', description: '', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => '',
  }))
  expect(await load(ctx, agent, 'documents')).toMatchObject({ isError: true, error: { info: { code: 'MCP_TOOL_REGISTRATION_FAILED' } } })
  expect(ctx.tools.get('mcp__srv__alpha', agent)).toBeUndefined()
  collision()
  expect(await load(ctx, agent, 'documents')).toMatchObject({ isError: false })
  expect(ctx.tools.get('mcp__srv__alpha', agent)).toBeDefined()
})

it('preserves execution guards after discovery', async () => {
  const ctx = await host()
  const server = await onDemand(ctx)
  await server.sync([{ name: 'search', inputSchema: object }])
  const { agent } = await createAgent(ctx)
  await load(ctx, agent, 'search')
  ctx.tools.guard(exec => exec.name === 'mcp__srv__search' ? { reason: 'Blocked by policy.', info: { name: 'PolicyError', code: 'POLICY_DENIED' } } : undefined)
  expect(await executeToolFixture(ctx, {
    name: 'mcp__srv__search', arguments: {}, callId: ToolCallId('blocked'), signal: new AbortController().signal, agent,
  })).toMatchObject({ isError: true, error: { info: { code: 'POLICY_DENIED' } } })
})

it('defaults both transports to search and validates the configurable result limit', () => {
  for (const server of [
    { transport: 'stdio' as const, serverName: 'demo', command: 'fixture' },
    { transport: 'streamable-http' as const, serverName: 'demo', url: 'https://example.invalid/mcp' },
  ]) {
    expect(McpClient.Config(server)).toMatchObject({ toolLoading: 'on-demand', searchResultLimit: 8 })
    expect(McpClient.Config({ ...server, toolLoading: 'eager', searchResultLimit: 2 })).toMatchObject({ toolLoading: 'eager', searchResultLimit: 2 })
    for (const searchResultLimit of [0, 1.5, -1]) expect(() => McpClient.Config({ ...server, searchResultLimit })).toThrow()
  }
})
