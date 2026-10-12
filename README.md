# dsh-code-stats

> 一句话：给 DeepSeek Harness（DSH）装上「产出仪表盘」—— 自动统计 AI 生成的代码行数、文档数量和采纳率，在 Web 设置面板里按工作区、时间范围查看。

[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

`dsh-code-stats` 是一个 DSH 第三方插件：它读取 DSH 的会话历史日志，识别其中的文件写入操作（`write` / `edit` / `str_replace_editor`），离线聚合出代码与文档的产出统计，并通过宿主 HTTP 接口 + Web 设置面板展示。全部计算在本机完成，不访问任何外部服务。

## 功能

| 指标 | 口径 |
|---|---|
| 生成代码行数 | `write` 全文行数 + 编辑工具新增行数，按文件扩展名排除文档类 |
| 文档统计 | `.md/.markdown/.mdx/.txt/.rst/.adoc` 的文件数与生成行数 |
| 采纳率（代码存活） | 按文件重放全部写入/编辑并做行级来源追踪，`窗口内生成且现仍存活的行数 ÷ 窗口内生成行数` |
| 采纳率（工具执行） | 写入类工具调用成功执行的比例；被拒绝、报错或无结果的调用算不采纳，只读 `view` 不计入 |
| 成本 | 按轮次归集 token 成本（`assistant/message` 的 usage：未缓存输入 / 缓存读 / 缓存写 / 输出），轮次成本按该轮生成的代码/文档行数比例分摊，无写入的轮次计入「对话开销」 |
| 时间过滤 | 全部 / 今天 / 最近 7 / 30 天 / 自定义起止日期（`from`/`to`，epoch ms，双闭区间）；窗口内只计窗口期操作，内容重放仍用全量历史保证存活判定准确；采纳率与成本均跟随窗口 |
| 维度 | 总览卡片、按会话、按日期、按文件 Top 榜 |

实测示例（某真实环境，37 个会话）：生成代码 12,551 行，代码存活采纳率 80.9%，工具执行采纳率 88.0%，文档 58 个 / 4,577 行，总成本 $8.61（代码 $5.47 · 文档 $1.45 · 对话开销 $1.69）。

## 安装

```powershell
dsh plugin --profile web add https://github.com/MarchingWorkhorse/Output-Overview.git
```

装好后**重启 DSH**（插件进入 bundle 栈，需进程重载）；打开 Web 界面的 **设置 → 代码统计** 即可查看面板。

开发调试（本地路径安装，junction 链接，改代码后重启即生效）：

```powershell
dsh plugin --profile web add D:\path\to\dsh-code-stats
```

## 使用

- **Web 面板**：设置 → 「代码统计」。顶部支持工作区筛选、子代理会话开关、时间范围选择；下方为最近 14 天趋势表与文件 Top 10。
- **HTTP API**：`GET /code-stats/api/summary`，支持 `?workspace=<cwd>`、`?subagents=false`、`?from=<ms>&to=<ms>`、`?refresh=1`。返回代码/文档/采纳率聚合与明细。

## 定价配置

成本默认按 `glm-5.3-flash` 的 USD 单价计算（输入 $0.06 / 缓存读 $0.01725 / 缓存写 $0.21 / 输出 $0.21，每 1M tokens）。换模型或换价时，在 profile 的 `cordis.patch.yml` 加一段按 id 覆盖的配置即可（改完重启生效）：

```yaml
- id: dsh-code-stats
  config:
    pricing:
      label: my-model
      hit: 0.01725   # cacheReadTokens，USD / 1M
      miss: 0.06     # 未缓存输入 inputTokens
      write: 0.21    # cacheWriteTokens
      out: 0.21      # 输出 outputTokens
```

## 数据来源与权限说明

- 通过 `ctx.sessionQuery`（dsh-base 默认挂载的会话查询服务）读取本机 `~/.dsh/sessions` 下的会话日志，筛选文件写入类工具调用并解析参数与结果；被拒绝或执行失败的调用不计入生成行数。
- **只读**：插件仅注册 GET 路由，不执行 shell、不写文件、不访问外部网络、不收集遥测。
- 统计为近似重放：编辑重放按字面量子串替换语义执行，极端情况（如文件被 AI 之外的手段修改）可能偏差。

## 兼容性

| DSH 版本 | 状态 |
|---|---|
| 0.1.5-rc.1 | 已验证（web profile） |

依赖宿主内置的 `sessionQuery` 与 `webServer` 服务（web profile 默认具备）；其他 profile（headless 等）无 Web 面板意义，未测试。

## 开发

```powershell
node lib\stats-engine.test.js        # 统计引擎测试
node lib\session-reader.test.js      # 会话读取层测试
node lib\stats-window.test.js        # 时间窗口测试
node scripts\smoke.mjs               # 真实数据端到端冒烟（假宿主 + 真 HTTP）
```

纯 ESM JavaScript，无构建步骤；`lib/` 为宿主端（cordis 插件），`client/client.js` 为手写 `__ModuleLoader__` 浏览器 bundle。

## 许可证

[MIT](./LICENSE)
