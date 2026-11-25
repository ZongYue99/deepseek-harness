---
kind: upgrade-guide
description: "MCP tools default to search-based loading, and on-demand integrations use search_tools instead of load_tools."
---
# MCP tools load through search by default

English | [中文](guide.zh.md)

## Change

MCP client and manager entries default to `toolLoading: on-demand` instead of `eager`. An agent initially sees a search tool per server, without a catalog of every tool. `mcp__<serverName>__search_tools({ query, limit? })` replaces `mcp__<serverName>__load_tools({ tools })` and loads matching definitions into that agent's next request. Existing `on-demand` entries, including Linear, Notion, and Tencent Docs, use the new interface. Search matches names and descriptions; exact raw or callable names select one tool. The client configuration `searchResultLimit` defaults to 8, and `catalogDescriptionMaxLength` now bounds search-result summaries. A server tool named `search_tools` is reserved in on-demand mode.

## Migration

1. For integrations that call MCP tools immediately, set `toolLoading: eager` on the server entry in `cordis.yml`, a profile patch, or MCP manager settings. Otherwise, allow the agent to search first. Policies using `tools.restrict()` for individual MCP names must retain `eager` or use execution guards: search-loaded tools are agent-scoped and are not filtered by inherited-tool masks.
2. Update skills and scripted callers of `load_tools` to call `search_tools` with a `query`. Execute the discovered tool in a subsequent model step or PTC program. Do not treat the search result as the operation's result.
3. Start a new session and confirm that the initial tool list contains the server's search tool, a matching search adds its callable tools, and their execution still passes the normal guards. Resumed and forked agents must discover tools again. Deployments with a server tool named `search_tools` can use `eager` to expose it directly.
