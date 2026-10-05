# Build-time asset preparation; nothing is installed on the user's machine.
param([switch]$Download)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1')
$taskRoot = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $taskRoot 'native\vm'
$downloads = Join-Path $assets 'downloads'
New-Item -ItemType Directory -Force $downloads,(Join-Path $assets 'images'),(Join-Path $assets 'qemu') | Out-Null
if ($Download) {
    Invoke-WebRequest 'https://qemu.weilnetz.de/w64/qemu-w64-setup-20260811.exe' -OutFile (Join-Path $downloads 'qemu.exe')
    Invoke-WebRequest 'https://qemu.weilnetz.de/w64/qemu-w64-setup-20260811.sha512' -OutFile (Join-Path $downloads 'qemu.sha512')
    Invoke-WebRequest 'https://cloud.debian.org/images/cloud/bookworm/20260923-2610/debian-12-genericcloud-amd64-20260923-2610.qcow2' -OutFile (Join-Path $assets 'images\debian.qcow2')
    Invoke-WebRequest 'https://cloud.debian.org/images/cloud/bookworm/20260923-2610/SHA512SUMS' -OutFile (Join-Path $downloads 'SHA512SUMS')
}
$qemuHash = (Get-Content -LiteralPath (Join-Path $downloads 'qemu.sha512')).Split(' ')[0].ToUpper()
if ($qemuHash -ne '5BCF9EED634E8575A37B74F445AF41A2FE4106DA512D0C30C368301D4C105037FDFAB40A5287367A28A957624CDDEBBC8C07E16C88AB6634F554CDF3D16BF543') { throw 'Unexpected QEMU release checksum' }
if ((Get-FileHash -LiteralPath (Join-Path $downloads 'qemu.exe') -Algorithm SHA512).Hash -ne $qemuHash) { throw 'QEMU checksum mismatch' }
$debianEntry = Get-Content -LiteralPath (Join-Path $downloads 'SHA512SUMS') | Where-Object { $_ -match ' debian-12-genericcloud-amd64(?:-20260923-2610)?.qcow2$' }
if ($debianEntry.Split(' ')[0].ToUpper() -ne '3D94C9DD66D8A283FDE060B8810373B7AE04038B956EE00D553D1AE564F6FBDEAA2FD6E7404E87E53348B5A9509170F3EA7C0731BA737590C5C4CB8D559A47F8') { throw 'Unexpected Debian release checksum' }
if ((Get-FileHash -LiteralPath (Join-Path $assets 'images\debian.qcow2') -Algorithm SHA512).Hash -ne $debianEntry.Split(' ')[0].ToUpper()) { throw 'Debian checksum mismatch' }
if (!(Test-Path -LiteralPath (Join-Path $assets 'qemu\qemu-system-x86_64.exe'))) {
    $sevenZip = Join-Path $env:ProgramFiles '7-Zip\7z.exe'
    if (!(Test-Path -LiteralPath $sevenZip)) { throw '7-Zip is needed only on the build machine to extract QEMU.' }
    & $sevenZip x (Join-Path $downloads 'qemu.exe') "-o$(Join-Path $assets 'qemu')" -y | Out-Null
    if ($LASTEXITCODE) { throw 'QEMU extraction failed' }
}
$stage = Join-Path $taskRoot 'native\dist\vm'
New-Item -ItemType Directory -Force $stage,(Join-Path $stage 'qemu'),(Join-Path $stage 'qemu\share'),(Join-Path $stage 'images') | Out-Null
Copy-Item -LiteralPath (Join-Path $assets 'guest-bridge.ps1') -Destination $stage -Force
Copy-Item -LiteralPath (Join-Path $assets 'watchdog.ps1') -Destination $stage -Force
foreach ($name in @('qemu-system-x86_64.exe','qemu-img.exe','COPYING','COPYING.LIB')) { Copy-Item -LiteralPath (Join-Path $assets "qemu\$name") -Destination (Join-Path $stage 'qemu') -Force }
Get-ChildItem -LiteralPath (Join-Path $assets 'qemu') -Filter '*.dll' | Copy-Item -Destination (Join-Path $stage 'qemu') -Force
$shareStage = [IO.Path]::GetFullPath((Join-Path $stage 'qemu\share'))
$expectedStage = [IO.Path]::GetFullPath((Join-Path $taskRoot 'native\dist\vm\qemu\share'))
if ($shareStage -ne $expectedStage -or !(Test-Path -LiteralPath $shareStage -PathType Container)) { throw 'Invalid generated firmware stage path' }
# Only clear this generated firmware staging directory, never the source assets.
Get-ChildItem -LiteralPath $shareStage -File | Remove-Item -Force
foreach ($pattern in @('bios*.bin','vgabios*.bin','kvmvapic.bin','linuxboot*.bin','multiboot.bin','pvh.bin','pxe-*.rom','efi-*.rom')) { Get-ChildItem -LiteralPath (Join-Path $assets 'qemu\share') -Filter $pattern -File | Copy-Item -Destination $shareStage -Force }
Copy-Item -LiteralPath (Join-Path $assets 'images\debian.qcow2') -Destination (Join-Path $stage 'images') -Force
@{qemuSha512=$qemuHash;debianSha512=$debianEntry.Split(' ')[0];qemuSource='https://qemu.weilnetz.de/w64/qemu-w64-setup-20260811.exe';debianSource='https://cloud.debian.org/images/cloud/bookworm/20260923-2610/debian-12-genericcloud-amd64-20260923-2610.qcow2';qemuSourceCode='https://qemu.weilnetz.de/';debianLicense='https://www.debian.org/legal/licenses/'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'provenance.json') -Encoding UTF8
$size = (Get-ChildItem -LiteralPath $stage -Recurse -File | Measure-Object Length -Sum).Sum
Write-Output "VM pack staged: $([math]::Round($size / 1MB)) MiB"
