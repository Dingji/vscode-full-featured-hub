# 打包与发布

这份文件是 **维护者手册**，不是用户文档。

它不在 `package.json` 的 `files` 白名单里，所以 **不会被发布到 npm**（npm 始终会带上 `README.md` 和 `LICENSE`，其余按白名单）。一份发布手册属于改代码的人，不属于装插件的人。

下面每一条命令都在本机跑过，并且写了它**当时真实的输出**。凡是我没有验证过的事情，第 8 节单独列出来了 —— 那份清单比这份文档的其余部分更值得读。

---

## 0. 一页速查

```powershell
cd <repo>

npm login                     # 必须；本机 `npm whoami` 曾经返回 401
npm test                      # 全套检查（`npm publish` 现在自己也会跑一遍，见下）
npm version patch             # 或 minor / major；会改 package.json 并打 git tag
npm pack                      # 生成 dingji_cherubino-dsh-full-featured-hub-<version>.tgz（prepack 自动重建）
npm publish                   # 发布：prepublishOnly → 测试，prepack → 重建，然后才上传
```

**tarball 文件名 ≠ 包名**：scoped 包把 `@` 去掉、`/` 换成 `-`，所以核对时用
`*-dsh-full-featured-hub-*.tgz`，而不是 `dsh-full-featured-hub-*.tgz`（后者匹配不到任何东西）。

**`npm publish` 自带门禁**（`prepublishOnly: npm test`）：本节开头那句"全绿才继续"原本是一条
**需要人记住**的规矩，现在是一条**工具记住**的规矩 —— 测试红着的时候，包根本走不出这台机器。
`prepack` 紧接着重建 bundle，所以**发布出去的正是刚测过的那一份**。

发布前**唯一不可跳过的一步**是第 3 节：核对包内的 `client.js` 与本地测试过的构建**逐字节一致**。

### ✅ 包名已定：`@dingji_cherubino/dsh-full-featured-hub`

**要唯一性就用 scope。** `@dingji_cherubino/dsh-full-featured-hub` 现在查是空的，但"空"是先到先得 —— 谁先发布归谁。
`@<你的npm用户名>/@dingji_cherubino/dsh-full-featured-hub` 则是**由构造保证唯一**的：只有那个账号能往自己的 scope 里发布。

改名不要手改，跑这个（它会读 `npm whoami`，也可以把名字作为参数传进去）：

```powershell
npm login                                  # 先登录，工具要读用户名
npm run rename -- --dry-run                # 打印每一行的前后，不写任何文件
npm run rename                             # 落盘：仓库 + 本地 profile 的链接与 bundles
```

它做三件事，顺序不能换：

1. **改仓库**（`package.json`、`cordis.patch.yml`、`index.js`、bundle banner、两份文档），
   每个被改的文件留一份 `.bak-before-rename`，并**逐行打印前后**；
2. **改本地安装**：profile 的 `dependencies` 键、`bundles` 名单、以及 node_modules 链接
   （scoped 名字需要 `node_modules\@scope\` 这一层目录）。换链接用 `cmd /c rmdir` + `mklink /J`，
   **绝不用 `Remove-Item -Recurse`** —— 对 junction 它会删掉**目标**，而目标就是整个仓库；
   前后各数一次仓库文件数，不一致就抛错；
3. **报告它故意没动的行**：路由 `/dsh-hud/…`、`storageDomain`、`dsh-hud:prefs`、凭据名前缀、
   仓库目录 —— 它们只是**看起来**像包名。

判断"这一行是不是包名"用的是**片段屏蔽**，不是整行匹配：profile 的依赖行是
`"dsh-…": "link:E:/Project/DeepseekPlugin/dsh-hud"` —— 键**必须**改，末尾的路径**必须**不改。
整行规则第一次跑的时候正好把这两者判反了。

`dsh-hud` 被占用这件事本身留在这里作记录：

```
dsh-hud@0.1.0 | MIT | deps: 1 | versions: 1
DeepSeek Harness 的 HUD 状态栏插件：在输入区下方常驻显示会话实时信息…
maintainers:
- dafei1288 <dafei1288@keymail.com>
```

同一片领域、**不同作者、不同形态**（那个是状态栏，这个是卡片坞）。如果照旧发布，除了 403，
还有一个更隐蔽的后果：profile 的 `bundles` 里写的就是 `dsh-hud`，从 npm 装的人拿到的是他那一个。

**现在的名字**：`@dingji_cherubino/dsh-full-featured-hub`（2026-10-02 查过，可用）。

改名时改了什么，以及**故意没改**什么 —— 后者每一项都会让用户丢东西：

| 改动 | 不动 |
|---|---|
| `package.json` 的 `name` | `/dsh-hud/<panel>/<action>` **路由**（`ROUTE_PREFIX` 是常量） |
| `cordis.patch.yml` 的 `name`（**必须是可解析的包名**，否则启动报 `Cannot find package`） | `dsh-hud/<panel>` **storageDomain**（改了等于清空所有人的设置） |
| README / PUBLISHING 里的安装说明 | `dsh-hud:prefs` **浏览器偏好键**（由客户端 cell 的 id 派生） |
| profile 的依赖键、`bundles`、node_modules 链接名 | `dsh-hud-sql-<id>` **凭据名前缀**（改了等于让已存的密钥失联） |
| 生成的 bundle banner（`tools/build-client.mjs`） | **仓库目录名**（它是 profile 链接的目标） |

### 改名之后本地安装必须同步（否则 DSH 起不来）

`cordis.patch.yml` 里的 `name` 会被 DSH 当作**包名去解析**，所以 profile 里必须有一个同名链接。
换链接时**不要用 `Remove-Item -Recurse`** —— 对 junction 它会删掉**目标**的内容，而这里的目标是整个仓库。
用 `cmd /c rmdir`（只删重解析点），并在前后数一次仓库文件数：

```powershell
$repo = 'E:\Project\DeepseekPlugin\dsh-hud'
$before = (Get-ChildItem $repo -Recurse -File | Where-Object { $_.FullName -notmatch 'node_modules' }).Count
& cmd /c rmdir "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-hud"
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@dingji_cherubino/dsh-full-featured-hub" -Target $repo
(Get-ChildItem $repo -Recurse -File | Where-Object { $_.FullName -notmatch 'node_modules' }).Count   # 必须和 $before 相同
```

profile 的 `package.json` 同步改两处（**改完要重启 DSH**，bundle 名单是启动时读的）：

```jsonc
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@dingji_cherubino/dsh-full-featured-hub"] } },
  "dependencies": { "@dingji_cherubino/dsh-full-featured-hub": "link:E:/Project/DeepseekPlugin/dsh-hud" }
}
```

（注意 link 路径末尾是**仓库目录名**，它没有跟着改 —— 目录名与包名无关。）

---

## 0.5 发布前必查：包里有没有不该出去的东西

这一轮开发用真实的主机、用户名和密码验证过功能，它们**很容易顺着注释和 README 的验证记录溜进包里**。
已有的一次清理（记在这里，因为下次还会发生）：

```
lib/sql/index.js ×1   122.112.251.34:1      → 203.0.113.10:1      （RFC 5737 文档地址段）
lib/ssh/client.js ×1  …host key is known for 172.21.0.138 → 198.51.100.20
README.md ×1          真机验证（… 172.21.0.138 …）        → 198.51.100.20
README.md ×1          引用的 ssh 报错原文                 → 同上
README.md ×1          user=dingji                        → user=<user>
README.md ×2          signed in as Dingji                 → signed in as <you>
```

打包之后按这个清单搜一遍**解包出来的目录**，全部应当未命中：

```powershell
$tmp = "$env:TEMP\hud-verify"
Get-ChildItem "$tmp\package" -Recurse -File |
  Select-String -Pattern '122\.112\.251\.34|172\.21\.0\.138|dingji|Dingji','Ladri di biciclette','007911' -SimpleMatch

# 还有一类，2026-10-03 才想起来查：npm 令牌与 .npmrc。
# 仓库里和包里都不该有它们 —— 令牌只应该活在 %USERPROFILE%\.npmrc 里。
Get-ChildItem "$tmp\package" -Recurse -File | Select-String -Pattern '_authToken|npm_[A-Za-z0-9]{20,}'
tar -tzf (Get-ChildItem *-*.tgz | Select-Object -First 1).FullName | Select-String -Pattern 'npmrc|\.env|secret|token'
```

（两条都应当**没有输出**。`files` 白名单本来就不会带上 `.npmrc`，但"本来不会"和"查过"是两件事。）

**数值和证据留着，标识符换掉** —— 这是这份文档一贯的取舍：测量的结果值得写下来，谁的服务器不值得。

> **令牌一旦被打印出来（终端、日志、聊天记录、issue），就当它已经泄露**：去 npm → Access Tokens
> 吊销并重建。这一步没有任何自动化的替代品。

---

## 1. 发布前：跑测试

```powershell
npm test
```

`test` 脚本按**最快失败**的顺序串起七项检查：

| 检查 | 覆盖 | 期望 |
|---|---|---|
| `tools/test-host.mjs` | 宿主半区：路由、解析、SQL/TDS 协议、SSH 会话、假日表 | `792/792` |
| `tools/test-client.mjs` | 浏览器半区：布局、面板、折叠、区域开关、终端、涨跌榜 | `548/548` |
| `tools/test-config.mjs` | 配置 schema | `37/37` |
| `tools/check-utf8.mjs` | 文件编码 | `all green` |
| `tools/check-jsx.mjs` | 片段里的 jsx/jsxs 用法 | `all green` |
| `tools/check-tdz.mjs` | 跨片段的暂时性死区引用 | `all green` |
| `tools/build-client.mjs --check` | bundle 与片段是否一致 | `is up to date` |

**数字会变，全绿不会。** 断言可以随功能增删，但任何一项红着都不该发。

还有一项**不在** `npm test` 里，因为它需要网络和真实的凭据：

```powershell
node tools/live-check.mjs     # 期望：16/16 checks returned real data
```

它打的是真实的行情/用量接口。**发布前值得跑一次**，因为单元测试用的是固定夹具 —— 夹具能证明解析正确，证明不了上游还认这些字段。

---

## 2. 打包

```powershell
npm pack
```

`prepack` 会**自动**先跑 `node tools/build-client.mjs`，所以不需要手动重建。

这是刻意的，而且它是这份文档里最重要的一处工程决定：

> **发布一个过期的 bundle，是唯一一种从外面看不出来的打包错误。**
>
> 插件装得上、加载得动、行为就像那个从未发布过的版本 —— 而 `client.js` 里跑的是上一次构建的代码。单元测试测的是**片段**，`client.js` 是拼出来的，两者不一致时没有任何东西会报错。

`prepack` 把这件事变成不可能，而 `build-client.mjs --check` 证明构建是确定性的（同样输入 → 逐字节同样的输出），所以在这里跑一次只花一秒。

### 包应该长什么样

```
dingji_cherubino-dsh-full-featured-hub-2.1.0.tgz
  40 个文件 · 打包后约 609 kB

  index.js                 宿主入口
  client.js                浏览器 bundle（生成的，不要手改）
  cordis.patch.yml         DSH 的 patch 层
  lib/                     host-kit、imap、sql/（7 个数据库驱动实现）、ssh/（3 个文件）
  panels/                  11 个面板 × (host.js + client.js) + index.js = 21 个文件
  README.md  LICENSE       npm 始终带上，即使不在 files 里
  package.json
```

**tarball 的文件名不是包名。** scoped 包把 `@` 去掉、`/` 换成 `-`：
`@scope/name` + `1.2.3` → `scope-name-1.2.3.tgz`。所以核对时用 `*-dsh-full-featured-hub-*.tgz`，
写成 `dsh-full-featured-hub-*.tgz` 会**一个都匹配不到**（而"没匹配到"看起来像"没打包"）。

**`tools/` 和测试不在包里**，这是 `files` 白名单决定的。代价要说清楚：**从 npm 装的人跑不了 `npm test`** —— 测试是仓库里的事，不是包的事。

### 有一类文件是 `files` 管不住的

npm **无条件**打包 `README*`、`LICENSE*`、`CHANGELOG*`、`package.json`。这不是"也会带上"，
是**白名单管不着**。实测：改名工具第一次真跑，把每个改动文件留了一份 `.bak-before-rename`，
于是包里出现了 `README.md.bak-before-rename` —— **40 个文件变成 41 个**，而多出来的那一份是旧文档。

所以工具的备份写进 `.rename-backups/`（一个没人会看的目录，白名单也不会匹配 `README*`）。
**每次打包之后数一次文件数**：多一个或少一个都值得看一眼。

### 有一类文件必须在包里，而且漏了不会报错

`files` 里写的是 `lib`（整个目录），所以 `lib/ssh/` 三个文件都在。**但这一点值得每次核对**，因为
其中一个是**运行时会去执行的**：

```
lib/ssh/askpass.cjs    ssh 的 askpass 程序 —— 密码认证靠它把密码交出去
```

它被 ssh 当作可执行程序调用（`NODE_OPTIONS=--require` 预载，见 README），**不是被 import 的**。
所以如果 `files` 哪天收紧成 `lib/**/*.js`，它会静默消失：包能装、能跑、只有密码登录会失败，
而失败信息是 ssh 的 `Permission denied` —— 看上去像密码错。第 3 节的核对命令里已经带上它。

---

## 3. 验证包 —— 不要跳过

```powershell
$tmp = "$env:TEMP\hud-verify"
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $tmp | Out-Null
tar -xzf (Get-ChildItem *-dsh-full-featured-hub-*.tgz | Select-Object -First 1).FullName -C $tmp

(Get-FileHash "$tmp\package\client.js" -Algorithm SHA256).Hash
(Get-FileHash 'client.js' -Algorithm SHA256).Hash
```

两个哈希必须**相同**。不同就说明 `prepack` 没跑、或者构建不是确定性的 —— 两种情况都不该发。

### 为什么必须用 `tar -xzf`，不能用 PowerShell 重定向

我第一次核对时是这么写的：

```powershell
tar -xzOf $tgz package/client.js > packed.js    # ✗ 会给出错误的结论
```

`>` 在 PowerShell 里**会重新编码**输出，所以两个文件必然不同 —— 而你会以为包坏了。**用 `tar -xzf` 解到目录再取哈希**，它写的是原始字节。

一个会给出**错误结论**的验证步骤，比没有验证步骤更糟。

### 顺手确认东西都在

```powershell
(Get-ChildItem "$tmp\package\panels" -Directory).Count      # 期望 11
Get-ChildItem "$tmp\package\panels" -Directory | Select-Object -ExpandProperty Name

Test-Path "$tmp\package\lib\ssh\askpass.cjs"                # 期望 True（见上一节）
```

新增面板之后一定要看这一行 —— 面板目录漏掉一个不会有任何报错，只会在用户那里表现为**少一张卡片**。

---

## 4. 发布

```powershell
npm version patch        # 2.0.0 → 2.0.1
npm publish
```

`publishConfig` 已经写好了 `access: public` 和 `registry: https://registry.npmjs.org/`，不需要额外参数。

### 版本号怎么定

| 变化 | 版本 |
|---|---|
| 修 bug、改文案、调高度 | `patch` |
| 新增面板、新增设置项 | `minor` |
| 改 `PREFS_VERSION` 的语义、改配置 schema | `major` |

### `PREFS_VERSION` 什么时候要升

**只在旧数据会被误读时升。** 两种情况的区别值得记牢：

- **加一个新字段** → **不升**。旧数据里没有它，缺失就是正确读法。
  - 例：`hiddenColumns`（区域开关）。缺失 = "什么都不隐藏"，这正是所有早于它的 prefs 文件的正确读法。升版本号意味着把这个键穿过八个迁移函数的返回值，一无所获。
- **改一个已有字段的含义或结构** → **必须升**，并在 `readPrefs` 的路由表里加一条 `migrateV<n>`。
  - 用户不需要清 `localStorage`，迁移会读旧数据、写新形状。这是这个插件的既定做法：**迁移，而不是要求用户清缓存。**

越界的值在**读取时**过滤，不是写入时信任。`hiddenColumns: [9, -1, 1]` 只会保留 `1` —— 一个越界索引会隐藏一个不存在的列，而那一列的卡片会消失、**界面上却没有画出来的开关能把它们找回来**。

---

## 5. 装到 profile 里验证

发布之后**必须**在真实的 DSH 里装一次。单元测试跑在 jsdom 里，它没有真实的布局引擎、没有真实的网络。

本机的开发装法是一个 **junction**：

```powershell
# 仓库链接进 profile 的 node_modules（改代码即时生效，不需要重装）
New-Item -ItemType Junction -Path "C:\Users\<user>\.dsh\profiles\<profile>\node_modules\@dingji_cherubino/dsh-full-featured-hub" -Target "<repo>"
```

```jsonc
// C:\Users\<user>\.dsh\profiles\<profile>\package.json
{
  "dsh": {
    "profile": {
      "bundles": ["base", "web-app", "@dingji_cherubino/dsh-full-featured-hub"]   // ← 加进这一行
    }
  }
}
```

从 npm 装的话就是普通的 `dsh plugin install @dingji_cherubino/dsh-full-featured-hub`（或往 profile 的依赖里加），**不需要 junction**。

---

## 6. 宿主半区改了必须重启 Harness

**这一条最容易踩，而且它的症状会指向错误的方向。**

> 浏览器半区（`client.js`）每次刷新页面都会重新加载。
> **宿主半区（`panels/*/host.js`、`lib/`）是按 URL 缓存的 Node 模块。**

所以：

| 改了什么 | 要做什么 |
|---|---|
| `panels/*/client.js`、`client/shell.js` | 刷新页面（F5） |
| `panels/*/host.js`、`lib/**`、`index.js` | **重启 DSH** |
| 新增面板、新增路由 | **重启 DSH** |

**禁用再启用插件不够，刷新页面也不够。** 这一点是实测的：移除「机器」面板后重新启用插件，`/dsh-hud/machine/state` **仍然返回 200** —— 那条路由还在旧的模块里活着。

### 症状长什么样

宿主路由不存在时，请求会得到 **404**（GET）或 **405**（POST），而且响应体**不是 JSON**：

```
GET  /dsh-hud/futures/state      → 404
POST /dsh-hud/futures/refresh    → 405   ← 因为 web 服务器先检查方法、再检查路径
```

**405 而不是 404 的原因就在这**：一个 POST 打到未注册的路径上，先在方法检查那一步就被拒了。

shell 的 `fetchJson` 会识别这种情况（**响应体不是 JSON** 是判据）并附上说明。**响应体是 JSON 的 404/405 不加这句提示** —— 那说明是路由自己在回答，它知道自己的原因（比如 `method-not-allowed`），把它说成"路由不存在"会把人送去重启一个根本不需要重启的进程。

---

## 7. 排错表

| 现象 | 原因 | 处理 |
|---|---|---|
| 卡片里显示 `HTTP 404/405（响应不是 JSON）` | 宿主路由还没挂载 | 重启 DSH（见第 6 节） |
| 卡片里显示 `method-not-allowed` | 路由存在，但请求方法不对 | 这是代码 bug，不是环境问题 |
| DSH 启动直接失败，报 `must match /^[A-Za-z_][A-Za-z0-9_]*$/` | **凭据名里有连字符** | 改名；连字符会让凭据插件加载失败并**阻止 DSH 启动** |
| 界面行为像上一个版本 | 包里的 `client.js` 是旧的 | 第 3 节；`prepack` 应该已经堵死了这条路 |
| 布局改动没生效 | 改的是宿主半区 | 重启 DSH |
| 卡片高度不合适 | 行高是全局的 | `ROW_UNIT_PX` + `ROW_GAP_PX` 在 `client/shell.js`；改完跑 `npm test`，布局断言会告诉你三列是否仍然齐平 |

---

## 8. 我没有验证过的事

诚实清单。这些不是"大概没问题"，是**明确没查**：

- ~~**`dsh-hud` 这个名字在 npm 上是否可用。**~~ **已查并已解决**：占用者是别人，
  包名改成了 `@dingji_cherubino/dsh-full-featured-hub`，见第 0 节。
- **从 npm 装（而不是 junction）的完整流程。** 本机一直用 junction，所以 `files` 白名单之外的隐含依赖、`peerDependencies` 的解析，都没有在真实安装里验证过。
- **scope 包（`@you/...`）在 DSH 里的加载路径。** 这次用的是不带 scope 的名字，所以没有碰到；
  本地一直是 junction，scope 包的短名解析、以及 profile 依赖里写全名之后 `bundles` 该写什么，都没有验证过。
- **跨版本升级的迁移路径。** 迁移函数的**单元测试**是有的，但"装 1.x → 升到 2.x → 打开界面"这条真实路径没走过。
- **`prefers-reduced-motion` 的真实表现。** 断言只确认了那条媒体查询在样式表里；没有在开启了 reduced motion 的真实浏览器里看过。
- **Windows 之外的平台。** 全部验证都在 Windows + PowerShell 上做的。SSH 那一半**尤其**：
  askpass 用的是 `node.exe` + `NODE_OPTIONS` 预载（Windows 上 `.cmd` 不能当 askpass 程序），
  这套在 macOS / Linux 上没有测过 —— 那边 `ssh` 本来就更可能直接读 TTY。
- **一台没有 `ssh` 客户端的机器。** 能力是**问出来的**（`available()`），没有客户端时卡片会说明原因而不是崩，
  但这个分支只在假夹具里跑过。

---

## 9. 发布清单

```
[ ] npm login                        本机 whoami 曾返回 401
[ ] 包名                              `@dingji_cherubino/dsh-full-featured-hub`（已定，见第 0 节）
[ ] npm test                         全绿（792 / 548 / 37 / 三项检查）
[ ] node tools/live-check.mjs        16/16（需要网络）
[ ] 第 0.5 节：包里没有真实主机 / 用户名 / 密码
[ ] npm version <patch|minor|major>
[ ] npm pack
[ ] 第 3 节：包内 client.js 与本地构建逐字节一致
[ ] 包内面板数量正确（当前 11），且 lib/ssh/askpass.cjs 在
[ ] profile 的链接与 bundles 已同步改名（第 0 节，改完重启 DSH）
[ ] npm publish
[ ] 在真实 DSH 里装一次并打开界面
[ ] 改了宿主半区 → 重启 DSH
[ ] README.md 反映了本次变化
```

最后一条不是形式：**README 是这个插件唯一的使用文档**，而它的读者是下一个装它的人。