# Full Featured Hub

**一张卡片，一个自由列网格，里面住着九个面板 —— 每个面板有自己的路由、自己的轮询，所以它们同时都是活的。**

这是 DeepSeek Harness 插件 `@dingji_cherubino/dsh-full-featured-hub` 的 **VS Code 移植版**。卡片**本身就是原插件**：`hud/client.js` 一字未改地跑在 webview 里，宿主半区（`hud/index.js` + `hud/lib/` + 九个 `hud/panels/*/host.js`）**逐字节复制**进扩展。版本跟着上游走。

| | |
|---|---|
| **商城列表名** | `Full Featured Hub`（= `package.json#displayName`，也就是本页标题） |
| **扩展 id** | `vscode-full-featured-hub.vscode-full-featured-hub` |
| **底部面板页签** | **HUD** —— 卡片在 VS Code 里一直叫这个名字（命令是 `HUD: …`，输出通道是 `HUD`），列表名只是商城的标题 |
| **版本** | 2.1.0（= 上游 `hud/package.json` 的版本，有测试盯着这个等式） |
| **VS Code** | `^1.90.0`，`extensionKind: ["ui"]` |
| **许可** | MIT（第三方见 `THIRD-PARTY-NOTICES.md`） |
| **测试** | 本移植 122 项 + 上游 792/548/37 项，全绿 |

---

## 目录

1. [安装与首次运行](#1-安装与首次运行)
2. [卡片与面板总览](#2-卡片与面板总览)
3. [每个面板：它显示什么、数据从哪来](#3-每个面板它显示什么数据从哪来)
4. [右侧卡片：数据库 / SSH 二选一](#4-右侧卡片数据库--ssh-二选一)
5. [布局：自由列网格](#5-布局自由列网格)
6. [设置（全部 11 项）](#6-设置全部-11-项)
7. [命令（全部 12 条）](#7-命令全部-12-条)
8. [凭据：与 DeepSeek Harness 共用同一份](#8-凭据与-deepseek-harness-共用同一份)
9. [架构：怎么把它塞进 VS Code](#9-架构怎么把它塞进-vs-code)
10. [「一模一样」是怎么保证的](#10-一模一样是怎么保证的)
11. [与 DSH 版的全部差异](#11-与-dsh-版的全部差异)
12. [开发](#12-开发)
13. [故障排查](#13-故障排查)
14. [已知限制](#14-已知限制)
15. [安全](#15-安全)
16. [许可与第三方](#16-许可与第三方)

---

## 1. 安装与首次运行

```bash
code --install-extension vscode-full-featured-hub.vscode-full-featured-hub   # 从商城
code --install-extension vscode-full-featured-hub-2.1.0.vsix                # 或本地这个 .vsix
```

装完 **重载窗口**（`Ctrl+Shift+P` → `Developer: Reload Window`），点底部面板的 **HUD** 页签。

**大多数面板开箱就有数据** —— 汇率、股市、期货、债市、天气、快递走公开接口，不需要任何配置。要凭据的那几家（DeepSeek key、GitHub token、邮箱授权码、数据库密码、SSH 密码）**都在卡片里直接填，不用改设置文件**。

**扩展 id 变过两次，每一次都等于"另一个扩展"**：先是 `dsh-hud.dsh-hud`，然后 `dsh-hud.vscode-full-featured-hub`（改包名），最后是现在的 **`vscode-full-featured-hub.vscode-full-featured-hub`**（publisher 与包名对齐 —— 商城只认你注册的那个 publisher ID）。**装新的之前把旧的都卸掉**，否则会有多个扩展同时注册那个 HUD 视图：

```bash
code --uninstall-extension dsh-hud.dsh-hud
code --uninstall-extension dsh-hud.vscode-full-featured-hub
```

命令、设置、路由、存储路径**从来没跟着改**（还是 `hud.*`、`/dsh-hud/…`、`storages/dsh-hud/…`），所以升级不丢任何配置。

---

## 2. 卡片与面板总览

九个**宿主面板**；浏览器半区注册**七张卡片**（股市、期货、债市、汇率共用一张，天气只有标题栏读数），本移植再加一张 **SSH**：

| 卡片 | 面板 id | 默认 | 说明 |
|---|---|---|---|
| **用量** | `quota` | ✅ 开 | 十个订阅平台 + 任意自定义 JSON 端点；卡内凭据抽屉；近 30 天曲线 |
| **GitHub** | `github` | ✅ 开 | 设备码登录、自己的仓库、release / push / 分支 / 合并 / issue、CI 状态、待我评审 |
| **快递** | `parcel` | ✅ 开 | 快递 100 单号跟踪，可加备注 |
| **股市** | `markets` | ✅ 开 | 自选 + **今日涨跌榜** + 分时/日/周/月 K 线；债券、期货、汇率是它的兄弟视图 |
| **数据库** | `sql` | ✅ 开 | 只读 SQL 客户端，六个引擎；连接管理、库表树、语句编辑器 |
| **SSH** | 本移植新增 | ✅ 开（选它时） | 与数据库卡片**二选一**，见第 4 节 |
| **待办** | `todo` | ⬜ 关 | ICS 日历 + 手写 IMAP + 飞书/钉钉 + 番茄钟 + 通知 |
| **天气** | `weather` | 标题栏 | `head`-only：只在卡片标题栏出一行读数（含空气质量），**不占栏位**；它的卡片默认关闭 |
| 期货 / 债市 / 汇率 | `futures` / `bond` / `fx` | ⬜ 关 | **不是独立卡片**，是股市那张卡片的视图 |

> **"九个面板、七个卡片"不是笔误**：期货、债市、汇率是**三个宿主面板**，但它们共享**一张卡片** —— 它们的客户端工厂是被那张卡片的组件直接调用的，而不是各自注册。规则是：**当一个工厂本身就是一张卡片时它被注册，当它只是一张卡片的视图时被调用。**

面板的开关和顺序都存在布局里，用 ⚙ 或 `HUD: Reset Card Layout` 管。

---

## 3. 每个面板：它显示什么、数据从哪来

### 3.1 用量（`quota`）

**十个平台**，每个有自己的端点与认证方式：

| 平台 | kind | 端点（`baseUrl`） | 凭据 |
|---|---|---|---|
| OpenCode GO | `opencode-go` | `https://opencode.ai/zen/go` | `OPENCODE_GO_API_KEY` |
| DeepSeek 官方 | `deepseek` | `https://api.deepseek.com` | `DEEPSEEK_API_KEY`；可选 `DEEPSEEK_USER_TOKEN` **解锁近 30 天用量曲线** |
| 智谱 / z.ai | `zai` | `https://api.z.ai` | `ZAI_API_KEY`（z.ai 上走 Bearer，国内站用原始 key） |
| Command Code | `commandcode` | `https://api.commandcode.ai` | `COMMANDCODE_API_KEY`（可选；没配就读 `~/.commandcode/auth.json`） |
| 月之暗面 Kimi | `moonshot` | `https://api.moonshot.ai` | `MOONSHOT_API_KEY` |
| Grok | `grok` | `https://cli-chat-proxy.grok.com` | `GROK_API_KEY`（可选；没配就读 `~/.grok/auth.json`） |
| 千问 Token Plan | `qwen` | 面板内置 | `QWEN_TOKEN_PLAN_CN_API_KEY`；可选 `QWEN_CONSOLE_COOKIE` 补上月度窗口 |
| MiMo | `mimo` | `https://platform.xiaomimimo.com/api/v1` | `MIMO_CONSOLE_COOKIE`（控制台会话 Cookie） |
| OpenRouter | `openrouter` | `https://openrouter.ai` | `OPENROUTER_API_KEY` |
| SiliconFlow | `siliconflow` | `https://api.siliconflow.cn` | `SILICONFLOW_API_KEY` |

> 表里的端点是 `src/quota-catalog.js` 里**实际写着的值** —— 有几个不是你凭印象会猜到的那个域名（z.ai 不是 `open.bigmodel.cn`，Grok 走的是 CLI 代理）。**任何一条都可以被 `hud.panels.quota.subscriptions` 里的条目覆盖。**

**`hud.quotaDiscovery` 决定"哪些平台存在"**：

- `chosen`（默认）—— **只显示 `hud.panels.quota.subscriptions` 里列的那些**，并且**把没选中的平台的凭据从面板隐藏**。用 `HUD: Choose Quota Platforms…` 选，`HUD: Reset Quota Platforms` 恢复 `auto`。
- `auto` —— DeepSeek Harness 自己的行为：读你 DSH profile 里的 provider 表（`llm-pi-ai`），加上内置发现（设了 `DEEPSEEK_API_KEY` 就出现 DeepSeek 行），再加上显式列表。

**两个容易踩的点**：

1. **每条订阅必须写 `baseUrl`**。不写会继承默认值 `https://opencode.ai/zen/go` —— 于是你以为在查 DeepSeek，其实在查 OpenCode。
2. **`subscriptions: []` 是"我一条都不要"，键不存在才是"别管我"**。两者差别很大。

选中列表还会**豁免面板自己那条兜底凭据**（面板的 `apiKeyEnv`），否则会出现"我明明有 key，它却说未配置"。

### 3.2 GitHub（`github`）

设备码登录（`HUD: Set Credential…` 存 `GITHUB_TOKEN`，或在卡片里走设备码流程）。显示自己的仓库活动、release、push、分支、合并、issue、CI 状态、待我评审的 PR。

**限流**：未认证 60 次/小时，认证 5000 次/小时 —— 所以登录之后它才真正好用。轮询间隔可以用 `hud.panels.github.pollMs` 调。

### 3.3 待办（`todo`）

四种来源合到一个列表里：**ICS 日历订阅**、**手写 IMAP 客户端**（没有用第三方库，直接讲协议）、**飞书/钉钉 webhook**、以及**番茄钟**。提醒走 VS Code 通知（`hud.notifications`）。

IMAP 的授权码要在卡片里填；它和 SQL 一样是从扩展宿主直接开 socket 的，这是 `extensionKind: ["ui"]` 的原因之一。

### 3.4 天气（`weather`）

**数据来源**：天气按 **IP 定位**（`ip-api.com`）取当前城市，**没有"城市"设置项** —— 它显示的就是你这条网络出口所在的地方。

### 3.5 快递（`parcel`）

快递 100 单号跟踪。加单号时可以写备注，列表按最新动态排序。

### 3.6 股市 / 期货 / 债市 / 汇率（`markets` / `futures` / `bond` / `fx`）

**一张卡片，四个视图。** 股市那张里：

- **自选** —— 你关注的标的，带 K 线（周期由宿主决定：实时 1 分钟 240 根、5/15/60 分、日/周/月）
- **今日涨跌榜** —— 涨幅榜 / 跌幅榜各 20 行，**鼠标悬浮在任意一行上显示该股当日分时 K 线**；点 `＋` 加入自选。榜单由 `GET /dsh-hud/market/rank` 一次返回涨跌两个方向，带上沪深京开市状态，并**滤掉新股和退市整理股**（它们的涨跌幅不是市场的涨跌幅）。
- **红涨绿跌** —— 这是这张卡片被阅读的约定，不是主题选择。

**数据源是东方财富**：自选走 `ulist.np/get`（你已知代码的报价），榜单走 `clist/get`（按涨跌幅排序整个市场）。两个看着一样但**错了都不报错**的细节：

| | |
|---|---|
| `po=1` 是**降序**、`po=0` 是**升序** | 写反了就是把涨幅榜显示两遍 |
| `fltt=2` 时涨跌幅**已经是百分数**（`206.59` = +206.59%） | 报价路径要除以 100（那个端点返回百分之一），照抄过来会把每个涨幅显示成 0.02% |
| `referer` 不是装饰 | 这个端点对裸客户端返回**空列表**而不是报错，看起来就像"今天没人涨" |

### 3.7 数据库（`sql`）

**六个引擎，三种只读模型**：

| 驱动 | 只读模型 | 含义 |
|---|---|---|
| SQLite | `engine` | 引擎自己拒绝写（文件句柄只读） |
| PostgreSQL | `transaction` | 只读事务，服务器强制 |
| MySQL / MariaDB | `transaction` | 同上 |
| SQL Server | `client` | **本插件拒绝发送写语句** —— SQL Server 没有只读事务，`ApplicationIntent=ReadOnly` 只是路由提示 |
| Oracle | `client` | 同上（只读模式属于一个跨调用的游标/事务） |
| DB2 | `client` | 同上 |

**连接管理**：卡片右上角 `＋ 连接`（**先测试再保存** —— 只有真连上的才写进配置），⚙ 里列出所有连接并可编辑/删除/切换，或用 `HUD: Manage SQL Connections…`。配置存在面板自己的存储里（`$DSH_HOME/storages/dsh-hud/sql/state.json`），设置里没写过 `sql` 时回退到 `hud.panels.sql`。

**写操作需要两道开关**：连接必须是可写的，**并且**运行时勾选「允许写」。缺一不可。

### 3.8 SSH 终端

见下一节。

---

## 4. 右侧卡片：数据库 / SSH 二选一

`hud.rightCard` 决定最右侧那张卡片是**数据库客户端**还是**交互式 SSH 终端**。

**两张只能存在一个，而且是"配置级"的互斥**：没被选中的那个面板**根本不会注册**，不是被隐藏。所以不存在"两个都能打开"的中间状态。

**切换**：命令面板 `HUD: Right Card: Database / SSH…`，或 **HUD 面板标题栏上的那个按钮**。切换会**重建卡片**（跟 `hud.language` 一样），因为"注册哪个面板"是在文档构造时决定的。

### SSH 终端能做什么

- **真 PTY**：`vim`、`top`、`Ctrl-C`、窗口缩放都正常。xterm.js 在 webview，`ssh2` 在扩展宿主。
- **键击和输出走 base64** —— shell 的输出是字节流，不是文本。按 UTF-8 解会把 `ls --color`、二进制 `cat`、以及被读取边界切断的 UTF-8 字符弄坏，而这三样恰好是终端存在的理由。

### 主机管理与凭据

三个入口，**同一份列表**：

- 卡片里的 **⚙**：列出主机，可编辑 / 删除 / 新建
- `HUD: Manage SSH Hosts…`：命令面板，多一个**真的连一次**的测试（不是 ping —— 端口能应答并不说明密码对）
- 手改 `$DSH_HOME/storages/dsh-hud/ssh/state.json`

**密码和私钥都不进主机条目**：条目里只有**凭据名**（`hud_ssh_<id>`），密钥写进 DSH 凭据库 —— 和 SQL 卡片的 `passwordRef` 是同一套做法。私钥登录则填**私钥文件路径**，口令也从凭据库取。

### 主机指纹

第一次连接时记录并显示在标题栏。`hud.sshStrictHostKey` 打开后，**指纹不匹配就拒绝连接**；默认关，因为自己搭的机器用自签密钥是常态，一道过不去的墙比它挡掉的风险更糟 —— 但**指纹无论如何都会记录并显示**，所以"没校验"是你看得见的事实，不是要你相信的承诺。

### 会话归 webview 所有

`hud.retainContext` 默认 false，**切走标签页会销毁 webview**。所以视图销毁时会**关掉它开的所有会话** —— 否则会在别人服务器上留下一个没人管的登录。

---

## 5. 布局：自由列网格

一键 `⚙` 打开布局编辑器（也可以从卡片标题栏进）：

- **列数**：1–3 列（`MAX_COLUMNS = 3`）
- **每张卡片的 `span`**：占几列（默认 1）
- **行高**：每张卡片 1–12 行（`MIN_ROWS` / `MAX_ROWS`），默认 3
- **顺序**：编辑器里的 ↑/↓ 就是排列顺序
- **折叠**：折成一行，**不占栏位** —— 这是"让更多卡片塞进一行"的方式
- **隐藏**：`HUD: Reset Card Layout` 恢复默认

**卡片高度**是 `max(实测内容高度, 布局声明的高度)`：只信声明会让内容超出时滚动（下面还空着），只信实测会把几乎空的卡片压成一行并破坏列高。取最大值是唯一同时满足两边的规则。

布局存在 webview 的 `localStorage` 里 —— 而这个移植把它接到了 VS Code 的 `globalState`（`hud.storage.` 前缀），所以换窗口、重启都不会丢。上游从 V2 到 V10 的 prefs 版本迁移原样保留。

---

## 6. 设置（全部 11 项）

| 设置 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `hud.panels` | object | `{}` | **每个面板的切片**，键是面板 id。与 DSH 的形状**完全一致**，所以配置块可以在两个工具之间直接复制 |
| `hud.retainContext` | boolean | `false` | 切走标签页时是否保留 webview。**改它会重建视图**（会关掉 SSH 会话） |
| `hud.notifications` | boolean | `true` | 待办提醒是否走 VS Code 通知 |
| `hud.credentialsFile` | string | `""` | 凭据文件路径。空 = `$DSH_HOME/.credentials.yaml` |
| `hud.credentialStore` | `dsh`/`vscode`/`both` | `dsh` | 新密码写到哪里 |
| `hud.statusBar` | boolean | `false` | 状态栏显示一行用量摘要 |
| `hud.dshProfile` | string | `""` | 用哪个 DSH profile（空 = 自动选最新的） |
| `hud.language` | `auto`/`zh`/`en` | `auto` | 卡片语言。`auto` **跟着 DSH profile 的 locale**，编辑器显示语言只是兜底 |
| `hud.quotaDiscovery` | `chosen`/`auto` | `chosen` | 用量平台怎么发现（见 3.1） |
| `hud.rightCard` | `database`/`ssh` | `database` | 最右侧那张卡片是哪个（见第 4 节） |
| `hud.sshStrictHostKey` | boolean | `false` | 是否拒绝指纹变化的主机 |

**有测试断言"声明了的设置 == 被读取的设置"** —— 一条只写在文档里、代码从不读的设置就是一句谎话，这个等式就是防它的。

---

## 7. 命令（全部 12 条）

| 命令 | 作用 |
|---|---|
| `HUD: Show HUD` | 聚焦到 HUD 面板 |
| `HUD: Reload HUD` | 重跑 webview 里的脚本（**不重新解析文档** —— 改语言/右侧卡片要用重载窗口） |
| `HUD: Set Credential…` | 存一个凭据（Cookie / token / key） |
| `HUD: Open Credentials File` | 打开凭据文件 |
| `HUD: Right Card: Database / SSH…` | 切换最右侧卡片 |
| `HUD: Manage SSH Hosts…` | SSH 主机增 / 改 / 删 / 测试 |
| `HUD: Manage SQL Connections…` | 数据库连接增 / 改 / 删 / 设为当前 |
| `HUD: Choose Quota Platforms…` | 选用量平台 |
| `HUD: Reset Quota Platforms` | 恢复 `hud.quotaDiscovery: auto` |
| `HUD: Open Panel Settings` | 打开 `hud.panels` 设置页 |
| `HUD: Reset Card Layout` | 恢复默认布局 |
| `HUD: Show Diagnostics` | **输出诊断**：版本、凭据文件、语言、挂载的面板、路由数、布局、以及 webview 自己测到的盒子尺寸 |

`HUD: Show Diagnostics` 是排查问题的第一站 —— 它连"卡片实测到的高度"都报，因为"卡片没铺满"这类问题和配置无关，只和盒子有关。

---

## 8. 凭据：与 DeepSeek Harness 共用同一份

凭据解析分成五层，**先命中的赢**（顺序来自 `CredentialStore#resolve`，不是文档）：

1. **进程环境变量**（`DEEPSEEK_API_KEY=… code .`）
2. **`$DSH_HOME/.credentials.yaml`** ← 和 DSH 共用同一份文件，也是默认的写入目标
3. **VS Code SecretStorage**（`hud.credentialStore: vscode` 或 `both` 时写入）
4. **`<工作区>/.env`**
5. **`$DSH_HOME/.env`**

**顺序是这条规则里最重要的事实**：一个过期的**环境变量**会盖住你刚在卡片里存的密码。第 1 层永远赢。

**引用名的规则**是 `[A-Za-z_][A-Za-z0-9_]*` —— 不是"可读性建议"：名字超出这个模式会让凭据插件**加载失败**，而凭据插件加载失败 **DSH 就起不来**。所以卡片生成的引用名会把连字符换成下划线（`conn-1` → `hud_sql_conn_1`），有测试盯着这条。

`HUD: Show Diagnostics` 和 `npm run refs` 都只打印**引用名和是否存在，绝不打印值**。

---

## 9. 架构：怎么把它塞进 VS Code

### 9.1 三个接缝

宿主半区是一个 **DSH 插件**：它期待一个 cordis 风格的 `ctx`，上面挂着 `webServer`、`credentials` 和一个 `effect()` 作用域。除此之外，整棵宿主树 —— `lib/host-kit.js`、`lib/imap.js`、`lib/sql/*` 和九个 `panels/*/host.js` —— **只通过 `lib/host-kit.js#createHost` 建出来的那个 per-panel `host` 对象**接触上下文。这就是适配器能这么小的原因。

浏览器半区是一个 **DSH module-loader bundle**：一次 `window.__ModuleLoader__.load({ id, factory })`，它的 factory 只做两件事 —— `require('react/jsx-runtime')` 和 `require('react')`。

所以移植只提供三样东西：

| 接缝 | 提供者 |
|---|---|
| **React** | `media/react.js`（esbuild 打包的**真** React + `jsx-runtime` + `react-dom/client`） |
| **模块加载器** `window.__ModuleLoader__` | `media/runtime.js` |
| **宿主服务** `ctx.webServer` / `ctx.credentials` | `src/ctx.js` + `src/router.js` + `src/credentials.js` |

### 9.2 一次请求走的路

```
面板里：  fetch('/dsh-hud/quota/usage')
             ↓  runtime 把 fetch 换成 RPC（webview 里没有同源服务器）
webview：  postMessage({ id, method: 'route', params: { path, method, body } })
             ↓
扩展宿主：  HudViewProvider.handle()  →  RouteTable.dispatch()
             ↓  造出假的 req / res（和真实 socket 一样的事件与时序）
面板的宿主半区： host.route('state', handler) 真的跑起来
             ↑
webview：  postMessage({ id, ok: true, data: { status, headers, body } })
             ↓
面板里：  拿到一个真的 Response
```

**为什么值得这样做**：面板的代码一句没改。它以为自己在一个同源网页里，实际上每个请求都穿过了 VS Code 的消息通道。

### 9.3 文件地图

```
src/
  extension.js      66.0 KB  激活、设置、命令、RPC、webview 宿主、诊断
  credentials.js    18.5 KB  五层凭据解析（DSH 那份的移植）
  quota-catalog.js  14.1 KB  十个用量平台的定义与选择逻辑
  ssh.js             7.7 KB  SSH 会话（ssh2 + 真 PTY，base64 字节流）
  dsh-profile.js     7.3 KB  读 DSH profile 的 cordis.patch.yml（provider 表、locale）
  router.js          6.1 KB  路由表 + 假 req/res + 有界 body 读取
  ssh-hosts.js       6.0 KB  SSH 主机列表（$DSH_HOME 存储，原子写）
  sql-connections.js 5.6 KB  SQL 连接的命令面板 CRUD
  ctx.js             4.6 KB  cordis 上下文适配器
  settings.js        4.2 KB  VS Code 设置 → HUD config（纯函数）
  webview.js         3.8 KB  文档拼装（CSP nonce、脚本顺序）
  connection-list.js 2.4 KB  两类连接共用的列表规则

media/
  react.js         139.9 KB  esbuild 打包的 React（保留 @license）
  xterm.js         345.0 KB  esbuild 打包的 xterm.js（保留 @license）
  runtime.js        22.4 KB  运行时垫片：RPC、localStorage、通知、剪贴板、
                             fetch→路由、模块加载器、CSP nonce、布局上报
  ssh-card.js       17.7 KB  本移植的 SSH 卡片（通过上游自己的扩展点注册）
  theme.css          5.8 KB  从 client.js 里提取的 19 个主题变量 + 面板铺满规则

hud/                        上游插件，逐字节复制（不是本移植的代码）
tools/                      构建与诊断脚本
test/                       本移植的测试
```

### 9.4 CSP 与主题

webview 的 CSP 是**严格的、每份文档一个 nonce**，没有 `unsafe-inline`。卡片会注入十一个样式表，每个都是 `document.createElement('style')` + `textContent` —— 这会被 nonce 策略挡掉，所以运行时**在 `<style>` 进入 DOM 之前给每一个盖上 nonce**（`installStyleNonce`）。

主题：`tools/gen-theme.mjs` 从 `hud/client.js` 里把 **19 个 `--dsw-*` 变量**抽出来，映射到 VS Code 的主题变量，写进 `media/theme.css`；**任何一个变量映射不出来它就拒绝写文件**。同一个脚本还输出那段"面板铺满"的规则。

---

## 10. 「一模一样」是怎么保证的

`hud/` 里的每一个文件都要和上游**逐字节相同**，`npm run check:verbatim` 每次都在验：

```bash
npm run check:verbatim
# Every file the port loads is byte-for-byte identical to upstream.
```

它按 sha256 比对，而且**只有真正会被加载的文件才有权让整个检查失败**（`index.js`、`client.js`、`package.json`、`client/**`、`lib/**`、`panels/**`）。上游的 README、测试、工具改了不算数 —— 那些不参与运行。

**同步是单向的**：

```bash
npm run hud:sync              # 从 ../dsh-hud 复制，并删除上游删掉的文件
npm run hud:sync -- --check   # 只报告差异，不写（不同步就退出 1）
```

**不要手改 `hud/`。** 修 bug 要修在上游，然后同步过来 —— 那些修复才会同时惠及 DSH 那边。

---

## 11. 与 DSH 版的全部差异

**这些是必要的适配，不是简化。** 除了下面这些，卡片的行为与 DSH 版一致。

| | DSH 版 | 这里 | 为什么 |
|---|---|---|---|
| **面板位置** | 输入框下方的 dock 单元 | 底部面板的 webview 视图 | VS Code 里没有"输入框下方"这个位置 |
| **传输** | 同源 `fetch('/dsh-hud/…')` | `postMessage` → 路由表 → 假 `req`/`res` | webview 没有同源服务器 |
| **`localStorage`** | 浏览器 localStorage | VS Code `globalState`（`hud.storage.` 前缀） | 布局要跨窗口、跨重启活着 |
| **浏览器 API** | `Notification`、`navigator.clipboard`、`window.open` | VS Code 通知 / 剪贴板 / `openExternal` | webview 里这些要么没有，要么需要权限 |
| **`$DSH_HOME/storages/`** | 面板自己读写 | **同一批文件**，未改动 | 存储约定一样，所以两个工具能看到同一份数据 |
| **面板就是容器的高度** | dock 单元本身就是卡片 | `media/theme.css` 里的无条件 `!important` 规则 | 上游用 `window.innerHeight − head − 72` 算高度，在 VS Code 里那个 72 是错的 |
| **`ctx.loader`** | 真的 loader 服务 | 读 DSH profile 的 patch 文件 | 用量面板靠它发现 provider |
| **语言** | 由 DSH locale 插件决定 | `hud.language`（`auto` 时读 DSH profile 的 locale） | 编辑器显示语言经常是英文，而 HUD 不是编辑器 chrome |

另外本移植**新增**了两样，都在上游自己的扩展点里实现：

- **SSH 卡片**（第 4 节）—— 通过 `hud/client.js` 自己导出的 `__registerPanel` 注册，所以它和上游卡片一样有 span、顺序、折叠、隐藏。
- **`HUD: Manage SQL Connections…`** —— 卡片里本来就有的增删改，搬到一个人们会去找的地方；它**走面板自己的路由**，所以校验和落盘仍然只有一份实现。

---

## 12. 开发

```bash
npm install
npm run hud:vendor      # 解出上游测试需要的 vendor 资源
npm run verify          # 闸门：逐字节一致 + 上游三套 + 本移植这套
```

### 12.1 脚本

| 脚本 | 作用 |
|---|---|
| `npm run vendor:react` | 生成 `media/react.js`（esbuild，保留 `@license`） |
| `npm run vendor:xterm` | 生成 `media/xterm.js`（含 xterm 的 CSS，作为文本内联） |
| `npm run vendor:theme` | 从 `client.js` 提取 19 个主题变量 → `media/theme.css` |
| `npm run vendor` | 上面三个 |
| `npm run hud:sync` | 从上游同步 `hud/`（`-- --check` 只报告） |
| `npm run hud:vendor` | 解出上游测试的 vendor 资源 |
| `npm run hud:test` | 上游的三套测试：构建一致性 + config + host + client |
| `npm run check:verbatim` | 逐字节比对 `hud/` 与上游 |
| `npm run refs` | 列出凭据引用名（**只名字，不打印值**） |
| `npm test` | 本移植的测试（121 项，60 秒超时） |
| `npm run verify` | `check:verbatim` + `hud:test` + `test` |
| `npm run package` | 出 `.vsix` |

### 12.2 测试

**上游的三套也在跑，它们是这个移植最好的接缝测试**：

| 套件 | 项数 | 验什么 |
|---|---|---|
| `hud/tools/test-config.mjs` | 37 | 配置 schema |
| `hud/tools/test-host.mjs` | 792 | 宿主半区：九个面板、路由、五个 SQL 驱动、IMAP、TDS 字节级 |
| `hud/tools/test-client.mjs` | 548 | 浏览器半区：真实 bundle 在 jsdom 里渲染 |

**本移植自己的 121 项**（`test/`）：

| 文件 | 验什么 |
|---|---|
| `webview.test.js` | 真 React + 真 runtime + 真 `hud/client.js` 在 jsdom 里启动；CSP/脚本顺序；卡片铺满规则；SSH 卡片与数据库卡片的**互斥**（读 shell 的 `data-panel` 列表）；涨跌榜视图与悬浮 K 线；通知/剪贴板/openExternal/fetch 垫片 |
| `extension-activation.test.js` | 真扩展在临时 `$DSH_HOME` 里启动；清单与设置的**声明的 == 读取的**；语言解析；布局上报；用量平台选择；SSH 主机列表与 RPC；权限门（未选平台时凭据不可见） |
| `ssh.test.js` | **对着一个真的 SSH 服务器**（`ssh2` 也能当服务端，在进程内起一个）：认证 → PTY（尺寸逐字段断言）→ shell → 双向字节 → 改窗口 → 干净关闭；以及主机列表的原子写 |
| `units.test.js` | 设置映射、路由表（同步与异步 500、404、POST body）、上下文适配器、TDS token 流 |
| `dsh-profile.test.js` | patch 文档 → entry、profile 选择、locale 读取 |

**测试环境是隔离的**：每个测试把 `DSH_HOME` 指向临时目录。不这样做的话，套件会去读**你自己的** `~/.dsh` —— 那意味着测试结果取决于跑测试的人配了什么。

### 12.3 怎么加一个面板 / 怎么跟上上游

1. 在上游加 `panels/<id>/host.js` 和 `client.js`
2. 加到上游的 `panels/index.js#PANELS`
3. 加到上游的 `client/register.js#CLIENT_PANELS`
4. 上游跑 `node tools/build-client.mjs` 重新生成 `client.js`
5. 这里跑 `npm run hud:sync && npm run verify`

### 12.4 诊断脚本

| 脚本 | 什么时候用 |
|---|---|
| `tools/probe-panel.mjs` | 用真宿主半区打一条路由，看面板到底收到什么 JSON |
| `tools/probe-sql.mjs` | 用真驱动连一个数据库（连接测试 + 执行语句） |
| `tools/probe-sql-sweep.mjs` | 逐表 `SELECT TOP n *`，找出哪张表的应答解析不了 |
| `tools/probe-sql-tokens.mjs` | 按**应答形态**遍历语句（空结果、只有 INFO、`EXEC`、超大应答…） |
| `tools/probe-tds.mjs` | 抓 TDS 握手字节，解码 PRELOGIN 选项表 |
| `tools/probe-market-rank.mjs` | 直接打东方财富的榜单端点，验 `po` 排序与 `fltt` 单位 |
| `tools/probe-quota.mjs` | 用真凭据跑用量收集 |

**它们从不接收密码作为命令行参数** —— 一律从环境变量读，而且只打印引用名和是否存在。

---

## 13. 故障排查

### 卡片高度不对 / 下方有空白

`media/theme.css` 里那段**无条件的 `!important` 铺满规则**负责这件事（`.hud-root` → `height:100vh`，`.hud-root > .hud-card` → `flex:1`，`.hud-body` → `grid-auto-rows: minmax(var(--hud-row-h,78px),1fr)`，`.hud-resize` 隐藏）。

先 `HUD: Show Diagnostics` 看它报的 **`card layout`** 块 —— 那里有 webview 自己测到的面板视口、`.hud-root`/`.hud-card`/`.hud-body` 的盒子、以及 `UNUSED BELOW`。改完 `client.js` 后记得 `npm run vendor:theme` 重新生成，有一个测试会在规则被改掉时失败。

### SQL Server 报「登录超时」

**2.1.0 修好了四个 TDS 缺陷**，全都是对着一个真实实例查出来的：

| 缺陷 | 症状 |
|---|---|
| 明文回退时又报了一次 `ENCRYPT_OFF`，然后发明文登录 | 服务器**一句话不说直接关连接** —— 自相矛盾的声明，它有权惩罚 |
| `readMessage` 只监听 `data` 和 `error` | 对方挂断时 Promise **永远悬着**：没有计时器、没有事件能了结它。**这就是"登录超时"的全部内容** |
| `session.query` 在 TDS/Oracle/DB2 上不存在 | 连上了却执行不了任何语句：`session.query is not a function` |
| 不认识的 token 直接抛错 | `TDS: 不认识的 token 0xee` |

先用探针确认驱动本身：

```bash
SQL_HOST=… SQL_USER=… SQL_DATABASE=… SQL_PASSWORD=… node tools/probe-sql.mjs --driver=sqlserver
```

### `TDS: 不认识的 token 0x…`

错误信息现在会带上**应答开头 16 字节的 hex**，因为同一个 token 号有两种完全不同的病因：

- **`0xEE` = FEDAUTHINFO**（MS-TDS 2.2.7.5）：按它自己的 **DWORD** 长度跳过（邻居们用的是 WORD —— 宽度写错不会报错，只会把后面每个 token 都错位）
- **开头像 `17 03 03`** = TLS 记录：服务器加密了会话而驱动在读明文，是**完全不同的问题**

**长度装不下时仍然报错**：如果流本来就错位，那四个字节其实是行数据，按它跳过会吞掉整个应答、然后返回一个看起来真实的结果。**大声失败胜过安静地解错。**

### 卡片报 `HTTP 404（响应不是 JSON）`

新加或改过的路由**需要重载窗口**。上游自己的提示就写在错误里：宿主半区是按 URL 缓存的 Node 模块，刷新页面不够。`HUD: Reload HUD` 只重跑文档里已有的脚本，**不会重新解析**。

### `＋ 连接` 是灰的，点不动

面板判断的是 `drivers.every(d => d.available !== true)`，而**空数组的 `every` 恒为真**。所以状态路由没应答时，这个按钮会一直禁用 —— 不是 bug，是"驱动清单还没到"。若一直如此，看 `HUD: Show Diagnostics` 里面板是否挂载。

### 用量卡片只有一行，或者报「未配置 API Key」

- `hud.quotaDiscovery: chosen` 时**只会显示你选中的平台**，而"什么都没选"只会显示那一行兜底（`opencode-go`）。
- 用 `HUD: Choose Quota Platforms…` 选，或把 `hud.quotaDiscovery` 改成 `auto`。
- **每条订阅都要写 `baseUrl`**（不写会继承 OpenCode 的默认值）。

### 装了扩展但看不到 HUD，或者有两个 HUD

**两个扩展 id 同时装着**。查一下：

```bash
code --list-extensions --show-versions | Select-String hud
```

应该只有 `vscode-full-featured-hub.vscode-full-featured-hub`。旧的卸掉：

```bash
code --uninstall-extension dsh-hud.dsh-hud
code --uninstall-extension dsh-hud.vscode-full-featured-hub
```

### 面板不刷新 / 刷得太勤

每个面板有自己的 `pollMs`：`hud.panels.<id>.pollMs`，并且**各自把值夹在自己的上下限之间**（例如股市卡片 10 秒 ~ 1 小时，债市 5 分钟 ~ 24 小时 —— 债券收益率不会每分钟变一次）。填一个越界的值不会报错，只会被夹到边界。

### 凭据明明有，却说「凭据无效」

**解析是五层的，先命中的赢** —— 一个过期的**环境变量**会盖住你在卡片里刚存的值。顺序见第 8 节。另外引用名必须匹配 `[A-Za-z_][A-Za-z0-9_]*`。

### SSH 连不上

- **没有可用密码**：在卡片里输一次，或 `HUD: Set Credential…` 存 `hud_ssh_<id>`
- **密钥登录**：主机条目要填**私钥文件路径**（口令从凭据库取）
- **主机密钥变了**：`hud.sshStrictHostKey` 打开时会拒绝，并显示新指纹；确认无误后更新条目里的 `fingerprint`
- **Windows / AD 认证**：不支持，只有密码和密钥

### 某个面板报 `fetch failed` / 网络错误

那是**面板的上游**不可达，不是本移植的问题。用 `tools/probe-panel.mjs <路由>` 直接打那条路由看原始应答。注意有些端点在网络受限时会返回**空列表而不是错误** —— 看起来就像"今天没有数据"。

---

## 14. 已知限制

1. **必须在 UI 侧运行**（`extensionKind: ["ui"]`）。宿主半区读 `$DSH_HOME` 的凭据与存储文件，SQL / IMAP / SSH 都从扩展宿主直接开 socket。**远程开发场景下不要把它当 workspace 扩展**。
2. **依赖 DSH 的目录约定**：`$DSH_HOME` 默认 `~/.dsh`。不装 DSH 也能用（自选、天气、快递、股市都不需要），但用量面板的 provider 发现和凭据共用会退化。
3. **上游在持续开发。** `hud/` 是一个**快照**，"与上游逐字节一致"只对某个**具名版本**有意义 —— 发布时应在 CHANGELOG 里记下那个版本。
4. **卡片是 webview**，所以它没有原生控件；键盘可达性取决于上游的实现（本移植的 SSH 卡片给每行加了 `onFocus`/`onBlur`，键盘用户也有悬浮图）。
5. **SQL Server 的只读是"本插件拒绝发送写语句"**，不是服务器强制 —— 卡片会明说这个区别。
6. **SSH 不支持 Windows / AD 认证**，也不提供 agent 转发。

---

## 15. 安全

- **凭据永远不离开这台机器。** 它们在 `$DSH_HOME/.credentials.yaml`、环境变量或 VS Code SecretStorage 里；扩展只解析、不转发。**`.vsix` 里没有任何密钥** —— `npm run refs` 和诊断都只打印名字与是否存在。
- **webview 的 CSP 是严格的**，每份文档一个 nonce，没有 `unsafe-inline`；`localResourceRoots` 只允许 `media/` 和 `hud/`。
- **`openExternal` 只接受 http(s)**，其余一律拒绝。
- **RPC 有边界**：请求体 64 KB 上限，超了返回 413；路由表拒绝重复路径。
- **SSH**：主机指纹会记录并显示；`hud.sshStrictHostKey` 可开启严格校验；会话随视图销毁而关闭，不会留下孤儿登录。
- **写操作需要两道开关**（连接可写 + 运行时勾选），SQL 面板还按驱动说明白它到底是哪一种只读。

---

## 16. 许可与第三方

本移植与上游都是 **MIT**。分发的第三方代码见 **`THIRD-PARTY-NOTICES.md`**：

| | 形式 | 许可 |
|---|---|---|
| React / ReactDOM | 打进 `media/react.js` | MIT（`@license` 头保留在文件末尾） |
| xterm.js | 打进 `media/xterm.js` | MIT（同上） |
| `ssh2` | 运行时依赖 `node_modules/ssh2` | MIT |
| `yaml` | 运行时依赖 `node_modules/yaml` | ISC（自带 LICENSE） |
| 上游插件 `hud/` | 逐字节复制 | MIT（`hud/LICENSE` 原样随包） |

> `vsce` 会警告"这个扩展有 600 多个文件，应该打包" —— 这条建议在这里**不适用**：绝大多数文件是上面那两个运行时依赖，和必须逐字复制的 `hud/**`。它是 WARNING，不是 ERROR。

---

**仓库里的相关文件**：

- **[PUBLISHING.md](PUBLISHING.md)** —— 发布到商城 / Open VSX 的完整流程：前置条件、publisher 与 PAT、发布命令、发布后验证、以及本仓库特有的坑
- **[CHANGELOG.md](CHANGELOG.md)** —— 每个版本改了什么（也是商城的 changelog 页签）
- **[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)** —— 分发的全部第三方代码及其完整许可
- **[hud/README.md](hud/README.md)** —— **上游插件自己的文档**：每个面板的原始设计说明

> 这些是相对链接，而它们能存在是因为 `package.json` 里有 `repository`：`vsce` 会用仓库地址把它们改写成绝对 URL。**没有那个字段时，README 里任何一个相对链接都会让 `vsce package` 直接失败**（`ERROR Couldn't detect the repository … will be broken`），而且**一个 `.vsix` 都不会产出** —— 实测过，那不是警告。