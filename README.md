# dsh-code-stats

DSH 代码统计插件 — 统计 DeepSeek Harness 生成代码行数、文档数与代码存活率，Web 面板展示。

English | [中文](#中文)

## 中文

### 功能

| 指标 | 口径 |
|---|---|
| 代码行数 | `write` 全文行数 + 编辑工具新增行数，按文件扩展名排除文档类 |
| 文档统计 | `.md/.markdown/.mdx/.txt/.rst/.adoc` 的文件数与生成行数 |
| 采纳率（代码存活） | 按文件重放全部写入/编辑并做行级来源追踪，`窗口内生成且现仍存活的行数 ÷ 窗口内生成行数` |
| 采纳率（工具执行） | 写入类工具调用（write/edit/str_replace_editor）成功执行的比例；被拒绝、报错或无结果的调用算不采纳，只读 `view` 不计入 |
| 时间过滤 | `from`/`to`（epoch ms，双闭区间）；窗口内只计窗口期操作，内容重放仍用全量历史保证存活判定准确；两个采纳率均跟随窗口 |
| 维度 | 总览、按会话、按日期、按文件 Top 榜 |

### 数据来源

通过 `ctx.sessionQuery`（dsh-base 默认挂载）读取全部会话的原始事件日志，
筛选文件写入类工具调用（write / str_replace 等）并解析其参数与结果。
被拒绝或执行失败的工具调用不计入。

### 安装

```powershell
dsh plugin --profile web add D:\path\to\dsh-code-stats
```

或在 profile 目录中 `pnpm add <本地路径>` 后重启（`patchReload: live` 会自动感知 patch 变化）。

### HTTP API

| 路由 | 说明 |
|---|---|
| `GET /code-stats/api/summary` | 总览统计（含 per-session / per-day / per-file 明细） |

查询参数：`?workspace=<cwd>` 过滤工作区；`?subagents=false` 排除子代理会话；
`?from=<ms>&to=<ms>` 时间窗口（双闭区间，日期按本地时区取零点/23:59:59.999）；`?refresh=1` 强制重算。
面板时间选项：全部时间 / 今天 / 最近 7 天 / 最近 30 天 / 自定义范围（起止日期选择器，起止颠倒会自动交换）。
示例：`/code-stats/api/summary?from=1791500000000`（只统计该时刻之后的生成）。
