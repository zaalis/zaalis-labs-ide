param(
  [string]$Source = "image\logo-zaalis.ico",
  [string]$OutDir = "native\image"
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

if (!(Test-Path -LiteralPath $OutDir)) {
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
}

$pngPath = Join-Path $OutDir "logo-zaalis.png"
$sourcePath = Resolve-Path -LiteralPath $Source

$icon = New-Object System.Drawing.Icon($sourcePath.Path, 256, 256)
$bitmap = $icon.ToBitmap()
$bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
$icon.Dispose()

Write-Host "Electron icon written to $pngPath"
