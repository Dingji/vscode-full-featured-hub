#!/usr/bin/env pwsh
#
# 登录 → 验证 → 发布，任何一步失败就停下。
#
# 为什么要有这个脚本：token 一旦写进命令行就会进 shell 历史、进 CI 日志、进别人
# 的截图。这里用 Read-Host -AsSecureString 读，只存在于这个进程的环境变量里，
# 进程结束就没了，也不回显。
#
#   pwsh -File publish.ps1                              # 发布 2.1.0 那个 .vsix
#   pwsh -File publish.ps1 -Vsix other-2.2.0.vsix       # 或指定的包
#   pwsh -File publish.ps1 -Check                       # 只验证凭据，不发布
#
# 建 PAT 时的两个设置（选错了会得到 401 / TF400813）：
#   Organization : All accessible organizations
#   Scopes       : Marketplace → Manage   （要先点 "Show all scopes"）
# 建好后页面上那次显示的就是 token 本身：52 个字符，只显示一次。
# PAT 的格式是 52 位小写字母加数字；36 位的 GUID 不是 token。

[CmdletBinding()]
param(
  [string] $Publisher = 'vscode-full-featured-hub',
  [string] $Vsix = 'vscode-full-featured-hub-2.1.0.vsix',
  [switch] $Check
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

# The Marketplace id, for the messages at the end. Built here rather than inline:
# a `-replace '-[\d.]+$'` inside a double-quoted string is read as a variable
# reference (`$'`), which is a parse error, and single-quoting the whole thing is
# clearer than escaping it.
$name = [IO.Path]::GetFileNameWithoutExtension($Vsix) -replace '-[\d.]+$', ''
$ExtensionId = "$Publisher.$name"

function Fail($message) {
  Write-Host ""
  Write-Host "  ✗ $message" -ForegroundColor Red
  exit 1
}

if (-not $Check -and -not (Test-Path -LiteralPath $Vsix)) {
  Fail "找不到 $Vsix —— 先跑 npm run package"
}

Write-Host ""
Write-Host "  publisher : $Publisher"
if (-not $Check) { Write-Host "  package   : $Vsix" }
Write-Host ""

# Two ways in, on purpose. `Read-Host -AsSecureString` needs an interactive console
# (it ignores piped stdin and simply blocks), so it is only used when nobody has
# handed us a token already — an environment variable is what CI has, and it is also
# what lets this script be tested without a human sitting in front of it.
if ([string]::IsNullOrWhiteSpace($env:VSCE_PAT)) {
  Write-Host "  粘贴 PAT（输入不会回显，也不会进历史）：" -ForegroundColor Cyan
  $secure = Read-Host -AsSecureString '  PAT'
  $token = [System.Net.NetworkCredential]::new('', $secure).Password
} else {
  Write-Host "  用环境变量里的 VSCE_PAT（不提示输入）" -ForegroundColor Cyan
  $token = $env:VSCE_PAT
}
if ([string]::IsNullOrWhiteSpace($token)) { Fail '没有拿到 token' }

# 先在本地就把格式不合理的东西挡掉，省一次往返。真实 PAT 恒为 52 位小写字母数字。
if ($token -notmatch '^[a-z0-9]{52}$') {
  Write-Host ""
  Write-Host "  ! 这看起来不是 PAT：长度 $($token.Length)，PAT 恒为 52 位小写字母数字。" -ForegroundColor Yellow
  if ($token -match '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
    Write-Host "    它是个 GUID —— 那是 Azure AD 的对象 / 租户 / 应用 ID，不是 token。" -ForegroundColor Yellow
  }
  Write-Host "    仍然继续验证，让服务器把话说清楚。" -ForegroundColor Yellow
}

# 只给子进程看，不进命令行、不进历史。
$env:VSCE_PAT = $token

try {
  Write-Host ""
  Write-Host "  1/2  验证凭据（不会发布任何东西）" -ForegroundColor Cyan
  & npx --yes '@vscode/vsce@4' verify-pat $Publisher
  if ($LASTEXITCODE -ne 0) {
    Fail '凭据验证失败 —— 上面那行 ERROR 就是原因（TF400813 通常意味着它不是 PAT，或 scopes 不对）'
  }

  if ($Check) {
    Write-Host ""
    Write-Host "  ✓ 凭据有效（-Check，未发布）" -ForegroundColor Green
    exit 0
  }

  Write-Host ""
  Write-Host "  2/2  发布 $Vsix" -ForegroundColor Cyan
  & npx --yes '@vscode/vsce@4' publish --packagePath $Vsix
  if ($LASTEXITCODE -ne 0) { Fail '发布失败' }

  Write-Host ""
  Write-Host "  ✓ 已发布：https://marketplace.visualstudio.com/items?itemName=$ExtensionId" -ForegroundColor Green
  Write-Host "    装它：code --install-extension $ExtensionId"
} finally {
  # 进程结束本来也会消失，显式清掉是为了万一这个 shell 还被继续用。
  Remove-Item Env:\VSCE_PAT -ErrorAction SilentlyContinue
  $token = $null
}