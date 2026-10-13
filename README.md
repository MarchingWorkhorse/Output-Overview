# output-overview

> 一句话：给 DeepSeek Harness（DSH）装上「产出总览」—— 自动统计 AI 生成的代码行数、文档数量、采纳率和成本，在 Web 设置面板里按工作区、时间范围查看。

[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

`output-overview` 是一个 DSH 第三方插件：它读取 DSH 的会话历史日志，识别其中的文件写入操作（`write` / `edit` / `str_replace_editor`），离线聚合出代码与文档的产出统计和成本归集，并通过宿主 HTTP 接口 + Web 设置面板展示。全部计算在本机完成，不访问任何外部服务。

## 功能

| 指标 | 口径 |
|---|---|
| 生成代码行数 | `write` 全文行数 + 编辑工具新增行数，按文件扩展名排除文档类 |
| 文档统计 | `.md/.markdown/.mdx/.txt/.rst/.adoc` 的文件数与生成行数 |
| 采纳率（代码存活） | 按文件重放全部写入/编辑并做行级来源追踪，`窗口内生成且现仍存活的行数 ÷ 窗口内生成行数` |
| 采纳率（工具执行） | 写入类工具调用成功执行的比例；被拒绝、报错或无结果的调用算不采纳，只读 `view` 不计入 |
| 成本 | 按轮次归集 token 成本（`assistant/message` 的 usage：未缓存输入 / 缓存读 / 缓存写 / 输出），轮次成本按该轮生成的代码/文档行数比例分摊，无写入的轮次计入「对话开销」；**以人民币（CNY，¥）显示**，按可配置汇率由 USD 折算 |
| 时间过滤 | 全部 / 今天 / 最近 7 / 30 天 / 自定义起止日期（`from`/`to`，epoch ms，双闭区间）；窗口内只计窗口期操作，内容重放仍用全量历史保证存活判定准确；采纳率与成本均跟随窗口 |
| 维度 | 总览卡片、按会话、按日期、按文件 Top 榜 |

实测示例（某真实环境，37 个会话）：生成代码 12,604 行，代码存活采纳率 80.5%，工具执行采纳率 88.0%，文档 58 个 / 4,682 行，总成本 ¥58.06（代码 ¥36.82 · 文档 ¥9.95 · 对话开销 ¥11.29，按 1 USD = 6.70 CNY 折算）。

## 安装

```powershell
dsh plugin --profile web add https://github.com/MarchingWorkhorse/Output-Overview.git
```

装好后**重启 DSH**（插件进入 bundle 栈，需进程重载）；打开 Web 界面的 **设置 → 产出总览** 即可查看面板。

开发调试（本地路径安装，junction 链接，改代码后重启即生效）：

```powershell
dsh plugin --profile web add D:\path\to\output-overview
```

## 使用

- **Web 面板**：设置 → 「产出总览」。顶部支持工作区多选（点击列表项切换选中，可多选；「全部工作区」按钮清空选择）、子代理会话开关、时间范围选择；下方为最近 14 天趋势表与文件 Top 10。成本以人民币（¥）显示，注明汇率；**选定工作区后，所有卡片（含总成本）只统计该工作区的会话**，右上角显示「N 个会话（全部 M）」。
- **HTTP API**：`GET /output-overview/api/summary`，支持 `?workspace=<cwd>`（可重复出现实现多选，如 `?workspace=a&workspace=b`；缺省为全部）、`?subagents=false`、`?from=<ms>&to=<ms>`、`?refresh=1`。返回代码/文档/采纳率/成本聚合与明细；**所有指标（含成本与会话数）均跟随工作区过滤**——`sessionCount` 是所选工作区的会话数，全库总数另以 `totalSessionCount` 给出；成本值已按 `displayCurrency` 折算（`costs.currency`/`costs.fx.rate` 标注币种与汇率，`costs.pricing.currency` 是单价报价币种）。面板配置另有 `GET/POST /output-overview/api/config`（读取/保存定价与币种覆盖，POST 后 summary 缓存自动失效）。

## 定价与币种配置

**推荐：直接在面板配置。** 打开 设置 → 「产出总览」，点顶部「定价配置」按钮：模型列表自动从会话日志提取（含各自轮数），逐个填四类单价、选**单价币种**（USD 或 CNY，选 CNY 即直接填人民币价）、选默认模型、改显示币种与汇率，点「保存并重算」即时生效。列表下方输入框可手动**添加模型**（还没用过、想预填单价的模型），每行可「移除」。保存写入 `~/.dsh/output-overview-config.json`（优先于 cordis.patch.yml，重启不丢）；「恢复默认」清除面板覆盖、回到 YAML/内置默认。

也可以改 profile 的 `cordis.patch.yml`（改完重启生效）：

成本按**模型分表计价**：每个轮次按产生它的模型（会话日志的 `request/header` / `request/context` / `model/selection` 事件）取对应单价；模型未知或不在表内的轮次回落到 `default`。单价币种由 `unit` 决定（`USD` 默认 / `CNY`），显示币种由 `currency` 决定——两者可以独立选择：CNY 单价 + CNY 显示时总成本就是人民币原值，不经过美元换算。默认只有 `glm-5.3-flash` 一档（USD 报价：输入 $0.06 / 缓存读 $0.01725 / 缓存写 $0.21 / 输出 $0.21）。成本**默认以人民币显示**（1 USD = 6.70 CNY，2026-10-12 牌价；面板会标注所用汇率）。

```yaml
- id: output-overview
  config:
    pricing:
      default: glm-5.3-flash          # 未知模型轮次按这个模型计价
      unit: CNY                       # 单价币种：CNY（人民币价）或 USD（默认）
      models:
        glm-5.3-flash:                # 键名 = 会话日志里的模型 id
          hit: 0.11                   # cacheReadTokens，按 unit 报价 / 1M
          miss: 0.42                  # 未缓存输入 inputTokens
          write: 1.4                  # cacheWriteTokens
          out: 1.4                    # 输出 outputTokens
        zj-deepseek-v4-flash:         # 加一行即支持另一个模型
          hit: 0.07
          miss: 0.35
          write: 1.2
          out: 1.2
    currency:        # 显示币种（成本值按 fx 折算；unit=CNY 且 currency=CNY 时不折算）
      code: CNY      # 改回 USD 即恢复美元显示
      symbol: "¥"
      fx: 6.7        # 1 USD = 6.7 显示币种（unit=USD 时用于折算；unit=CNY 且显示 CNY 时忽略）
```

单一模型的旧写法（`pricing: { label, hit, miss, write, out }` 平铺一档价）仍然兼容，等价于只有一条记录的模型表；不带 `unit` 字段的既有配置一律按 USD 报价处理。面板底注会列出每个模型的花费与轮数（如 `glm-5.3-flash ¥25.34（84 轮 · 0.42/1.4）`），便于核对哪款模型烧钱。

## 数据来源与权限说明

- 通过 `ctx.sessionQuery`（dsh-base 默认挂载的会话查询服务）读取本机 `~/.dsh/sessions` 下的会话日志，筛选文件写入类工具调用并解析参数与结果；被拒绝或执行失败的调用不计入生成行数。
- **只读 + 一处配置写入**：统计只注册 GET 路由，不执行 shell、不访问外部网络、不收集遥测；唯一的写操作是面板「保存定价」写 `~/.dsh/output-overview-config.json`（原子写入）。
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
node lib\stats-cost.test.js          # 成本归集测试
node scripts\smoke.mjs               # 真实数据端到端冒烟（假宿主 + 真 HTTP）
```

纯 ESM JavaScript，无构建步骤；`lib/` 为宿主端（cordis 插件），`client/client.js` 为手写 `__ModuleLoader__` 浏览器 bundle。

## 许可证

[MIT](./LICENSE)
