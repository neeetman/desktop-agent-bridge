param(
    [string]$CallerThread = $env:CODEX_THREAD_ID,
    [string[]]$WritableRoots = @(),
    [string[]]$ProtectedThreads = @(),
    [switch]$WithDeepSeek,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot)
$node = (Get-Command node -ErrorAction Stop).Source
$python = (Get-Command python -ErrorAction Stop).Source
$nodeMajor = & $node -p "Number(process.versions.node.split('.')[0])"
if ($LASTEXITCODE -ne 0 -or [int]$nodeMajor -lt 24) { throw 'Node.js 24 or later is required.' }
& $python -c "import sys; assert sys.version_info >= (3,11); import frida; assert frida.__version__ == '17.9.1'"
if ($LASTEXITCODE -ne 0) { throw 'Python 3.11+ and frida==17.9.1 are required. See README.md.' }
if (-not (Test-Path -LiteralPath (Join-Path (Split-Path $python) 'pythonw.exe'))) { throw 'pythonw.exe must exist beside the selected Python interpreter.' }
& $node -e "require.resolve('ws',{paths:[process.argv[1]]})" $root
if ($LASTEXITCODE -ne 0) { throw 'Run npm ci in the checkout first.' }
$codex = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
$claude = Get-AppxPackage -Name Claude | Sort-Object Version -Descending | Select-Object -First 1
if (-not $codex -or -not $claude) { throw 'Install and initialize both Codex and Claude Windows desktop packages first.' }
$codexExe = Join-Path $codex.InstallLocation 'app/ChatGPT.exe'
$claudeExe = Join-Path $claude.InstallLocation 'app/Claude.exe'
& $python (Join-Path $root 'deployment.py') check --codex-executable $codexExe --claude-executable $claudeExe
if ($LASTEXITCODE -ne 0) { throw 'Desktop compatibility check failed. No attachment or configuration update was performed.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$suffix = $identity.User.Value.Split('-')[-1]
foreach ($name in @("DesktopSessionBridge-$suffix", "DesktopSessionBridge-$suffix-Watchdog")) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($task) {
        $expected = Join-Path $root 'supervisor-task.pyw'
        if ($task.Description -notlike 'Desktop Session Bridge*' -or
            -not (@($task.Actions) | Where-Object { $_.Arguments -like ('*' + $expected + '*') })) {
            throw "Existing task $name belongs to another installation. Follow docs/migration.md before switching directories."
        }
    }
}
# Fixed ports and native pipe names permit one installation per interactive user.
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -ge 43127 -and $_.LocalPort -le 43133 })
foreach ($listener in $listeners) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
    $owned = $owner -and $owner.CommandLine -and $owner.CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0
    if (-not $owned -and $listener.LocalPort -eq 43132) {
        $deepseekConnection = Join-Path $root 'runtime/deepseek-native/connection.json'
        if (Test-Path -LiteralPath $deepseekConnection) {
            $owned = (Get-Content -LiteralPath $deepseekConnection -Raw | ConvertFrom-Json).pid -eq $listener.OwningProcess
        }
    }
    if (-not $owned) { throw "Port $($listener.LocalPort) is owned by another installation/process. No changes were made." }
}
if ($WithDeepSeek) {
    $profile = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh/profiles/desktop/cordis.patch.yml'
    if (-not (Test-Path -LiteralPath $profile)) { throw 'Initialize DeepSeek Harness desktop profile before using -WithDeepSeek.' }
}
if (-not $CallerThread) {
    $connectionFile = Join-Path $root 'runtime/connection.json'
    if (Test-Path -LiteralPath $connectionFile) { $CallerThread = (Get-Content -LiteralPath $connectionFile -Raw | ConvertFrom-Json).callerThread }
}
if (-not $CallerThread -and -not $CheckOnly) { throw 'Provide -CallerThread with an existing Codex desktop dispatcher chat ID on this machine.' }
if ($CheckOnly) { Write-Output 'Preflight passed; no processes started, native attachment, config writes or task registration performed.'; return }
$initializeArgs = @((Join-Path $root 'deployment.py'), 'initialize')
foreach ($directory in $WritableRoots) { $initializeArgs += @('--writable-root', $directory) }
foreach ($thread in $ProtectedThreads) { $initializeArgs += @('--protected-thread', $thread) }
& $python @initializeArgs
if ($LASTEXITCODE -ne 0) { throw 'Machine-local initialization failed.' }
& (Join-Path $root 'start.ps1') -CallerThread $CallerThread
& $python (Join-Path $root 'install-peer-mcp.py')
if ($LASTEXITCODE -ne 0) { throw 'MCP configuration installation failed; inspect runtime/mcp-config-backups.' }
if ($WithDeepSeek) {
    & $python (Join-Path $root 'install-deepseek-plugin.py')
    if ($LASTEXITCODE -ne 0) { throw 'DeepSeek plugin installation failed.' }
}
& (Join-Path $root 'install-autostart.ps1') -WithoutDeepSeek:(-not $WithDeepSeek)
Write-Output 'Installation registered. Allow the supervisor to start, then run npm run status and verify native communication. Existing GUI sessions may need to reconnect their MCP worker.'
