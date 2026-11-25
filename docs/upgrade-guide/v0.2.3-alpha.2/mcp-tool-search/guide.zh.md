---
kind: upgrade-guide
description: "MCP 工具默认通过搜索加载，按需集成使用 search_tools 替代 load_tools。"
---
# MCP 工具默认通过搜索加载

[English](guide.md) | 中文

## 变更

MCP 客户端与管理器条目的默认值从 `eager` 改为 `toolLoading: on-demand`。agent 最初看到每台服务器的搜索工具，不再看到全部工具目录。`mcp__<serverName>__search_tools({ query, limit? })` 替代 `mcp__<serverName>__load_tools({ tools })`，将匹配定义加载到该 agent 的下一次请求。现有 `on-demand` 条目（包括 Linear、Notion 和腾讯文档）使用新接口。搜索匹配名称与描述；精确的原始名称或可调用名称选中一个工具。客户端配置 `searchResultLimit` 默认为 8，`catalogDescriptionMaxLength` 现在限制搜索结果摘要。按需模式保留服务器工具名 `search_tools`。

## 迁移

1. 需要立即调用 MCP 工具的集成，应在 `cordis.yml`、profile patch 或 MCP 管理器设置的服务器条目中指定 `toolLoading: eager`。其他集成允许 agent 先搜索。用 `tools.restrict()` 限制单个 MCP 名称的策略必须保留 `eager` 或改用执行守卫：搜索加载的工具属于 agent 作用域，不受继承工具掩码过滤。
2. 将调用 `load_tools` 的技能和脚本改为使用 `query` 调用 `search_tools`。在后续模型步骤或 PTC 程序中执行发现的工具，不要把搜索结果当作操作结果。
3. 启动新会话，确认初始工具列表包含服务器的搜索工具，匹配搜索会添加可调用工具，执行仍受正常守卫约束。恢复和 fork 的 agent 需要重新发现工具。服务器存在名为 `search_tools` 的工具时，可以使用 `eager` 直接提供它。
