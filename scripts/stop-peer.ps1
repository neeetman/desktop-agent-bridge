. (Join-Path $PSScriptRoot 'bridge-paths.ps1')
$ErrorActionPreference = 'Stop'
$connectionPath = Join-Path $ProjectRoot 'runtime/router/connection.json'
if (-not (Test-Path -LiteralPath $connectionPath)) { return }
$connection = Get-Content -LiteralPath $connectionPath -Raw | ConvertFrom-Json
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.pid)"
if ($process) {
    $scriptPath = SourceFile 'peer-router.mjs'
    if ($process.Name -ne 'node.exe' -or -not $process.CommandLine.Replace('/', '\').Contains($scriptPath)) { throw 'Router PID belongs to a different process; refusing to stop it.' }
    Stop-Process -Id $connection.pid
    Write-Output "Desktop peer router stopped (PID $($connection.pid))."
}
