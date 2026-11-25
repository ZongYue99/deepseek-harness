/**
 * On-demand tool loading for one MCP server: the server's tools stay out of the
 * tool registry until a search registers matching tools in the calling agent's scope.
 *
 * @module
 */

import MiniSearch from 'minisearch'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { truncateWithoutSplittingSurrogatePair } from '@deepseek-ai/dsh-output-retention'
import { createScope, type Scope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { defineTool, ToolArgsError, ToolContextUnavailableError, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { McpToolRegistrationError, publicToolName } from './tools.ts'

/** Raw name of the loader tool inside the server's `mcp__<serverName>__` namespace. */
export const LOADER_RAW_NAME = 'search_tools'

/** One agent's loaded tools from this server. */
interface AgentLoads {
  readonly scope: Scope
  /** Raw names this agent loaded; a name stays loaded while the server offers it. */
  readonly names: Set<string>
  /** Live registrations by raw name; empty while no generation is published. */
  readonly registered: Map<string, () => void>
}

/**
 * Owns one on-demand server's search tool, its discovery prompt, and each agent's
 * loaded tools. A published generation registers the loader and re-registers
 * every agent's loaded tools that the generation still offers.
 */
export class McpToolLoader {
  /** Model-facing name of this server's loader tool. */
  readonly name: string
  private readonly tool: ToolDefinition
  /** The published generation's tools by raw name; empty while none is published. */
  private offered: ReadonlyMap<string, ToolDefinition> = new Map()
  private index = this.createIndex()
  private readonly loads = new Map<Agent, AgentLoads>()

  /**
   * Define the loader and release each agent's loaded tools with the agent.
   * @param ctx - the server plugin's context; it owns the loader and the agents' scopes.
   * @param serverName - the server's tool namespace.
   * @param descriptionMaxLength - maximum characters of each search result's summary.
   * @param resultLimit - maximum tools loaded by one search.
   */
  constructor(
    private readonly ctx: Context,
    private readonly serverName: string,
    private readonly descriptionMaxLength: number,
    private readonly resultLimit: number,
  ) {
    this.name = publicToolName(serverName, LOADER_RAW_NAME)
    this.tool = defineTool({
      name: this.name,
      description: `Search for tools from MCP server ${serverName} and make matching tools available for your next call. Returns their callable names and summaries.`,
      parameters: {
        query: { type: 'string', required: true, description: 'Task keywords or an exact tool name.' },
        limit: { type: 'integer', description: `Maximum tools to load, from 1 to ${resultLimit}; defaults to ${resultLimit}.` },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      // The executor turns a synchronous validation failure into a rejected call.
      execute: (args, exec) => new Promise((resolve) => { resolve(this.search(args.query, args.limit ?? this.resultLimit, exec.agent)) }),
    })
    ctx.on('agent/disposed', ({ agent }) => {
      const loads = this.loads.get(agent)
      this.loads.delete(agent)
      // Cordis contains disposal failures, and this plugin's unload awaits a disposal still in flight.
      void loads?.scope.dispose()
    })
  }

  /** Number of tools the published generation offers. */
  get size(): number {
    return this.offered.size
  }

  /**
   * Publish one generation: register the loader, then re-register each agent's loaded tools the generation still offers.
   * @param tools - the generation's tool definitions by raw name, without a tool named like the loader.
   * @returns the withdrawal, which unregisters the loader and the loaded tools while keeping the loaded names for the next generation.
   * @throws when the loader name is already registered; nothing is published then.
   */
  publish(tools: ReadonlyMap<string, ToolDefinition>): () => void {
    const index = this.createIndex()
    index.addAll([...tools].map(([id, tool]) => ({ id, name: id, description: tool.description })))
    const unregister = this.ctx.tools.register(this.tool)
    this.offered = tools
    this.index = index
    for (const loads of this.loads.values()) {
      for (const name of loads.names) {
        const definition = tools.get(name)
        if (definition === undefined) loads.names.delete(name)
        else this.register(loads, name, definition)
      }
    }
    return () => {
      unregister()
      this.offered = new Map()
      this.index = this.createIndex()
      for (const loads of this.loads.values()) {
        for (const dispose of loads.registered.values()) dispose()
        loads.registered.clear()
      }
    }
  }

  /**
   * Render service-level discovery instructions for one assembly.
   * @param scope - the assembling agent, or undefined for the global view.
   * @returns discovery instructions, or an empty string when no generation is published or the scope cannot see the loader.
   */
  catalog(scope: ScopeKey | undefined): string {
    if (this.offered.size === 0 || this.ctx.tools.get(this.name, scope) !== this.tool) return ''
    return `### Tools from MCP server ${this.serverName}\n\nSearch with ${this.name} to find and load tools before using them.`
  }

  private createIndex(): MiniSearch {
    const segmenter = new Intl.Segmenter('en', { granularity: 'word' })
    return new MiniSearch({
      fields: ['name', 'description'],
      tokenize: text => [...segmenter.segment(text.normalize('NFKC').replaceAll('_', ' '))]
        .filter(part => part.isWordLike).map(part => part.segment),
    })
  }

  private search(query: string, limit: number, agent: Agent | undefined): string {
    if (agent === undefined) throw new ToolContextUnavailableError(`${this.name} requires an agent`)
    if (query.trim() === '') throw new ToolArgsError(['query must contain task keywords or a tool name'])
    if (limit < 1 || limit > this.resultLimit) throw new ToolArgsError([`limit must be between 1 and ${this.resultLimit}`])
    const exact = [...this.offered].find(([name, tool]) => name === query.trim() || tool.name === query.trim())
    const names = exact === undefined
      ? this.index.search(query).slice(0, limit).map(hit => hit.id as string)
      : [exact[0]]
    if (names.length === 0) return 'No matching tools. Try different keywords or an exact tool name.'
    this.load(names, agent)
    return 'Available for your next call:\n' + names.map((name) => {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- search results belong to the current generation
      const tool = this.offered.get(name)!
      const summary = this.summary(tool.description)
      return summary === '' ? `- ${tool.name}` : `- ${tool.name}: ${summary}`
    }).join('\n')
  }

  /** First description line with whitespace collapsed, capped at the configured length. */
  private summary(description: string): string {
    const [first = ''] = description.trim().split('\n', 1)
    const line = first.replaceAll(/\s+/g, ' ').trim()
    if (line.length <= this.descriptionMaxLength) return line
    return truncateWithoutSplittingSurrogatePair(line, this.descriptionMaxLength - 3) + '...'
  }

  /** Register search matches atomically in the calling agent's own scope. */
  private load(requested: readonly string[], agent: Agent): void {
    let loads = this.loads.get(agent)
    if (loads === undefined) {
      loads = { scope: createScope(this.ctx, agent), names: new Set(), registered: new Map() }
      this.loads.set(agent, loads)
    }
    const added = new Map<string, () => void>()
    try {
      for (const name of requested) {
        if (loads.registered.has(name)) continue
        // oxlint-disable-next-line typescript/no-non-null-assertion -- names come from this generation's index
        added.set(name, loads.scope.ctx.tools.register(this.offered.get(name)!))
      }
    } catch (cause) {
      for (const dispose of added.values()) dispose()
      throw new McpToolRegistrationError('Tool search could not load matching tools; no new tools were loaded.', { cause })
    }
    for (const [name, dispose] of added) {
      loads.registered.set(name, dispose)
      loads.names.add(name)
    }
  }

  /** Register one loaded tool for one agent; a failure drops only that tool for that agent. */
  private register(loads: AgentLoads, name: string, definition: ToolDefinition): void {
    try {
      loads.registered.set(name, loads.scope.ctx.tools.register(definition))
    } catch (error) {
      loads.names.delete(name)
      this.ctx.logger.error(`mcp-client(${this.serverName}): could not restore loaded tool "${name}" for an agent: ${String(error)}`)
    }
  }
}
