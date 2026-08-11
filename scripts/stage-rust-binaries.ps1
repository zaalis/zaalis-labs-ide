[CmdletBinding()]
param([switch]$CliOnly)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $projectRoot 'rust\target\release'
$distDir = Join-Path $projectRoot 'native\dist'

New-Item -ItemType Directory -Force -Path $distDir | Out-Null

$cliSource = Join-Path $releaseDir 'zaalis.exe'
if (-not (Test-Path -LiteralPath $cliSource -PathType Leaf)) {
    throw "Rust CLI missing: $cliSource"
}
Copy-Item -LiteralPath $cliSource -Destination (Join-Path $distDir 'zaalis-cli.exe') -Force

if (-not $CliOnly) {
    $daemonSource = Join-Path $releaseDir 'zaalis-agentd.exe'
    if (-not (Test-Path -LiteralPath $daemonSource -PathType Leaf)) {
        throw "Rust daemon missing: $daemonSource"
    }
    Copy-Item -LiteralPath $daemonSource -Destination (Join-Path $distDir 'zaalis-agentd.exe') -Force
}

Write-Host 'Rust binaries staged in native\dist.'
