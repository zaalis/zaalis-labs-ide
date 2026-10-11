# Runs ONLY inside Windows Sandbox. The host maps a dedicated session directory.
$ErrorActionPreference = 'Continue'
$inputDir = 'C:\ZaalisInput'
$bridge = 'C:\ZaalisBridge'
$completed = @{}
Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File C:\ZaalisInput\watchdog.ps1'
Set-Location 'C:\'
Set-Content -LiteralPath "$bridge\ready" -Value 'ready'
while ($true) {
    try { $request = Get-Content -LiteralPath "$inputDir\request.json" -Raw | ConvertFrom-Json } catch { Start-Sleep -Milliseconds 80; continue }
    if ($request.id -and !$completed.ContainsKey([string]$request.id)) {
        try {
            $global:LASTEXITCODE = 0
            $output = & ([scriptblock]::Create([string]$request.command)) 2>&1 | Out-String -Width 240
            $code = if ($?) { $global:LASTEXITCODE } else { 1 }
            $result = @{ output = $output; exitCode = $code; cwd = (Get-Location).Path }
        } catch { $result = @{ output = $_.Exception.Message; exitCode = 1; cwd = (Get-Location).Path } }
        $target = Join-Path $bridge ([string]$request.id + '.result.json')
        $result | ConvertTo-Json -Compress | Set-Content -LiteralPath "$target.tmp" -Encoding UTF8
        Move-Item -LiteralPath "$target.tmp" -Destination $target -Force
        $completed[[string]$request.id] = $true
    }
    Start-Sleep -Milliseconds 80
}
