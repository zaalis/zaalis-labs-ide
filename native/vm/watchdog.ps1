# Guest-only watchdog: an abruptly closed IDE must not leave an owned Sandbox.
while ($true) {
    try {
        $heartbeat = Get-Item -LiteralPath 'C:\ZaalisInput\heartbeat'
        if (([DateTime]::UtcNow - $heartbeat.LastWriteTimeUtc).TotalSeconds -gt 30) {
            & shutdown.exe /s /t 0
            break
        }
    } catch { }
    Start-Sleep -Seconds 3
}
