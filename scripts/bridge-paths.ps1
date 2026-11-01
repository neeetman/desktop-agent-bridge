$ProjectRoot = Split-Path $PSScriptRoot -Parent
$BridgeSourceLayout = Get-Content -LiteralPath (Join-Path $ProjectRoot 'src/layout.json') -Raw | ConvertFrom-Json
if ($BridgeSourceLayout.schemaVersion -ne 1) { throw 'Unsupported bridge source layout.' }
function SourceFile([string]$Name) {
    $entry = $BridgeSourceLayout.files.PSObject.Properties[$Name]
    if (-not $entry) { throw "Unknown bridge source file: $Name" }
    $file = [IO.Path]::GetFullPath((Join-Path $ProjectRoot $entry.Value))
    if (-not $file.StartsWith(([IO.Path]::GetFullPath($ProjectRoot) + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) { throw 'Source path escapes bridge root.' }
    return $file
}
