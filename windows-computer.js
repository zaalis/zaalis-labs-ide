'use strict';

// Windows implementation of the shared computer contract.  All arguments are
// passed to PowerShell as base64 JSON, never interpolated into a shell command.
//
// IMPORTANT: this script runs under Windows PowerShell 5.1 (powershell.exe),
// not PowerShell 7.  Language features added in 7 -- `??`, `?.`, `? :` --
// are parse errors here, and PowerShell parses the *whole* script before
// running a single line, so one such token breaks every action, not just the
// one that contains it.  Keep this script to 5.1 syntax only.
const { execFile, spawn } = require('child_process');

let overlayProcess = null;

// Same palette, proportions and breathing cadence as macOS's Electron overlay.
// It is a separate click-through WPF process, so visual feedback never changes
// the real Windows input path used by the computer-control bridge.
function startOverlay() {
  if (overlayProcess && overlayProcess.exitCode == null) return { ok: true, pid: overlayProcess.pid };
  const script = String.raw`
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase,System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class ZaalisOverlayNative {
  [DllImport("user32.dll", SetLastError=true)] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll", SetLastError=true)] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
}
'@
[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" WindowStyle="None" AllowsTransparency="True" Background="Transparent" ShowInTaskbar="False" Topmost="True" ShowActivated="False" ResizeMode="NoResize" IsHitTestVisible="False">
  <Grid IsHitTestVisible="False" ClipToBounds="True">
    <Canvas Opacity="0.9">
      <Ellipse Width="1500" Height="1000" Canvas.Left="-260" Canvas.Top="-210" Opacity="0.28">
        <Ellipse.Fill><RadialGradientBrush><GradientStop Color="#479D59FF" Offset="0"/><GradientStop Color="#009D59FF" Offset="0.32"/><GradientStop Color="#00000000" Offset="1"/></RadialGradientBrush></Ellipse.Fill>
      </Ellipse>
      <Ellipse Width="1700" Height="1150" Canvas.Right="-360" Canvas.Bottom="-260" Opacity="0.28">
        <Ellipse.Fill><RadialGradientBrush><GradientStop Color="#47662DD2" Offset="0"/><GradientStop Color="#00662DD2" Offset="0.38"/><GradientStop Color="#00000000" Offset="1"/></RadialGradientBrush></Ellipse.Fill>
      </Ellipse>
    </Canvas>
    <Border BorderThickness="28" Opacity="0.9">
      <Border.BorderBrush><LinearGradientBrush StartPoint="0,0" EndPoint="1,1"><GradientStop Color="#94783EDE" Offset="0"/><GradientStop Color="#29AD57FF" Offset="0.5"/><GradientStop Color="#8A5B22AF" Offset="1"/></LinearGradientBrush></Border.BorderBrush>
      <Border.Effect><BlurEffect Radius="2"/></Border.Effect>
      <Border.Style><Style TargetType="Border"><Style.Triggers><EventTrigger RoutedEvent="Loaded"><BeginStoryboard><Storyboard AutoReverse="True" RepeatBehavior="Forever"><DoubleAnimation Storyboard.TargetProperty="Opacity" To="0.55" Duration="0:0:5.5"/><DoubleAnimation Storyboard.TargetProperty="Effect.Radius" To="5" Duration="0:0:5.5"/></Storyboard></BeginStoryboard></EventTrigger></Style.Triggers></Style></Border.Style>
    </Border>
  </Grid>
</Window>
'@
$reader = New-Object Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)
$screen = [Windows.Forms.SystemInformation]::VirtualScreen
$window.Left = $screen.Left; $window.Top = $screen.Top; $window.Width = $screen.Width; $window.Height = $screen.Height
$window.add_SourceInitialized({
  $source = [Windows.PresentationSource]::FromVisual($window)
  $extended = [ZaalisOverlayNative]::GetWindowLong($source.Handle, -20)
  [void][ZaalisOverlayNative]::SetWindowLong($source.Handle, -20, ($extended -bor 0x20 -bor 0x80000))
})
$window.ShowDialog() | Out-Null
`;
  overlayProcess = spawn('powershell.exe', ['-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    stdio: 'ignore', windowsHide: true,
  });
  overlayProcess.once('exit', () => { overlayProcess = null; });
  overlayProcess.once('error', () => { overlayProcess = null; });
  return { ok: true, pid: overlayProcess.pid };
}

function stopOverlay() {
  if (overlayProcess && overlayProcess.exitCode == null) {
    try { overlayProcess.kill(); } catch {}
  }
  overlayProcess = null;
}

function call(action) {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, error: 'unsupported-platform' });
  if (action && action.action === 'overlay_start') return Promise.resolve(startOverlay());
  if (action && action.action === 'overlay_stop') { stopOverlay(); return Promise.resolve({ ok: true }); }
  const payload = Buffer.from(JSON.stringify(action || {}), 'utf8').toString('base64');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch {}
Add-Type @'
using System;
using System.Runtime.InteropServices;
public struct ZaalisRect { public int Left; public int Top; public int Right; public int Bottom; }
public static class ZaalisInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out ZaalisRect r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
# A PowerShell child process is DPI-unaware by default.  On a 4K screen at
# 150% that makes every capture and every cursor coordinate land in scaled
# pixels instead of real ones, so clicks miss their target.  Must run before
# System.Drawing / System.Windows.Forms initialise the DPI context.
try { [void][ZaalisInput]::SetProcessDpiAwareness(2) } catch { try { [void][ZaalisInput]::SetProcessDPIAware() } catch {} }
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$a = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ZAALIS_COMPUTER_ACTION)) | ConvertFrom-Json
function Result($obj) { [Console]::Out.Write(($obj | ConvertTo-Json -Compress -Depth 8)); exit }
function ActiveTitle {
  $b = New-Object Text.StringBuilder 1024
  [void][ZaalisInput]::GetWindowText([ZaalisInput]::GetForegroundWindow(), $b, $b.Capacity)
  return $b.ToString()
}
function VirtualBounds {
  $s = [Windows.Forms.SystemInformation]::VirtualScreen
  return @{ x=$s.Left; y=$s.Top; width=$s.Width; height=$s.Height }
}
function WindowBounds {
  $handle = [ZaalisInput]::GetForegroundWindow()
  $rect = New-Object ZaalisRect
  if ($handle -ne [IntPtr]::Zero -and -not [ZaalisInput]::IsIconic($handle) -and [ZaalisInput]::GetWindowRect($handle, [ref]$rect)) {
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    if ($w -gt 40 -and $h -gt 40) { return @{ x=$rect.Left; y=$rect.Top; width=$w; height=$h } }
  }
  return (VirtualBounds)
}
function ClampBounds($b) {
  $v = VirtualBounds
  $x = [Math]::Max([int]$v.x, [int]$b.x)
  $y = [Math]::Max([int]$v.y, [int]$b.y)
  $right = [Math]::Min([int]$v.x + [int]$v.width, [int]$b.x + [int]$b.width)
  $bottom = [Math]::Min([int]$v.y + [int]$v.height, [int]$b.y + [int]$b.height)
  return @{ x=$x; y=$y; width=[Math]::Max(1, $right - $x); height=[Math]::Max(1, $bottom - $y) }
}
function Capture($bounds, $maxDimension) {
  $b = ClampBounds $bounds
  $bmp = New-Object Drawing.Bitmap -ArgumentList @([int]$b.width, [int]$b.height)
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen([int]$b.x, [int]$b.y, 0, 0, $bmp.Size)
  $g.Dispose()
  # A 4K screenshot costs a fortune in tokens for detail no model can use.
  # Downscale past maxDimension; the caller converts click coordinates back to
  # screen pixels, so the model never has to know this happened.
  $out = $bmp
  $limit = [int]$maxDimension
  if ($limit -gt 0) {
    $longest = [Math]::Max($bmp.Width, $bmp.Height)
    if ($longest -gt $limit) {
      $ratio = $limit / $longest
      $w = [Math]::Max(1, [int][Math]::Round($bmp.Width * $ratio))
      $h = [Math]::Max(1, [int][Math]::Round($bmp.Height * $ratio))
      $resized = New-Object Drawing.Bitmap -ArgumentList @($w, $h)
      $rg = [Drawing.Graphics]::FromImage($resized)
      $rg.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $rg.DrawImage($bmp, 0, 0, $w, $h)
      $rg.Dispose(); $bmp.Dispose()
      $out = $resized
    }
  }
  $stream = New-Object IO.MemoryStream
  $out.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
  $imageWidth = $out.Width; $imageHeight = $out.Height
  $out.Dispose()
  return @{
    image=[Convert]::ToBase64String($stream.ToArray())
    capture=@{x=$b.x;y=$b.y;width=$b.width;height=$b.height}
    image_width=$imageWidth
    image_height=$imageHeight
  }
}
if ($a.action -eq 'status' -or $a.action -eq 'request_permissions') { Result @{ok=$true; accessibility=$true; screenRecording=$true} }
if ($a.action -eq 'overlay_start' -or $a.action -eq 'overlay_stop') { Result @{ok=$true} }
if ($a.action -eq 'activate_app' -or $a.action -eq 'open_terminal') {
  $p = 'powershell.exe'
  if ($a.action -eq 'activate_app') {
    $p = [string]$a.path
    if ($p -notmatch '^(?:[A-Za-z]:\\|\\\\).+\.(exe|cmd|bat)$' -and $p -notmatch '^(?i:notepad|calc|mspaint|chrome|edge|msedge|firefox|code|explorer|cmd|powershell)(\.exe)?$') { Result @{ok=$false;error='invalid-application'} }
  }
  # Windows 11 puts Store "app execution aliases" on PATH for several of these
  # names.  Those are reparse points Start-Process cannot launch ("le systeme ne
  # trouve pas toutes les informations requises"), so resolve the well-known
  # ones to their real binary before launching.
  $known = @{
    notepad = (Join-Path $env:WINDIR 'System32\notepad.exe')
    calc = (Join-Path $env:WINDIR 'System32\calc.exe')
    mspaint = (Join-Path $env:WINDIR 'System32\mspaint.exe')
    explorer = (Join-Path $env:WINDIR 'explorer.exe')
    cmd = (Join-Path $env:WINDIR 'System32\cmd.exe')
    powershell = (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe')
  }
  $key = ($p -replace '\.exe$','').ToLower()
  if ($known.ContainsKey($key) -and (Test-Path $known[$key])) { $p = $known[$key] }
  try { Start-Process -FilePath $p }
  catch { Start-Process -FilePath (Join-Path $env:WINDIR 'System32\cmd.exe') -ArgumentList @('/c','start','',$p) -WindowStyle Hidden }
  Start-Sleep -Milliseconds 450
  Result @{ok=$true;application=(ActiveTitle)}
}
if ($a.action -eq 'move' -or $a.action -eq 'click') {
  [ZaalisInput]::SetCursorPos([int]$a.x,[int]$a.y) | Out-Null
  if ($a.action -eq 'click') { $down=if($a.button -eq 'right'){8}else{2};$up=if($a.button -eq 'right'){16}else{4};[ZaalisInput]::mouse_event($down,0,0,0,[UIntPtr]::Zero);[ZaalisInput]::mouse_event($up,0,0,0,[UIntPtr]::Zero) }
  Result @{ok=$true}
}
if ($a.action -eq 'scroll') { [ZaalisInput]::mouse_event(0x0800,0,0,[uint32]([int]$a.dy * 120),[UIntPtr]::Zero); Result @{ok=$true} }
if ($a.action -eq 'type') {
  # Paste rather than SendKeys: accents and long text survive intact.  The
  # previous clipboard text is put back so we do not clobber the user's.
  $previous = $null
  try { $previous = Get-Clipboard -Raw } catch {}
  Set-Clipboard -Value ([string]$a.text)
  [Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 140
  if ($null -ne $previous -and $previous -ne '') { try { Set-Clipboard -Value $previous } catch {} }
  Result @{ok=$true}
}
if ($a.action -eq 'key') {
  $k=[string]$a.key; $mods=@($a.modifiers)
  $prefix=''; if($mods -match 'ctrl|control'){$prefix+='^'}; if($mods -match 'alt|option'){$prefix+='%'}; if($mods -match 'shift'){$prefix+='+'}
  $winKey = [bool]($mods -match 'win|windows|cmd|command|meta|super')
  $map=@{enter='{ENTER}';tab='{TAB}';escape='{ESC}';esc='{ESC}';backspace='{BACKSPACE}';delete='{DELETE}';up='{UP}';down='{DOWN}';left='{LEFT}';right='{RIGHT}';home='{HOME}';end='{END}';pageup='{PGUP}';pagedown='{PGDN}';space=' '}
  if($map.ContainsKey($k)){$k=$map[$k]} elseif($k.Length -eq 1){$k=$k.ToUpper()} else {$k='{'+$k.ToUpper()+'}'}
  # SendKeys has no notation for the Windows key: hold it down natively.
  if ($winKey) { [ZaalisInput]::keybd_event(0x5B,0,0,[UIntPtr]::Zero) }
  [Windows.Forms.SendKeys]::SendWait($prefix+$k)
  if ($winKey) { Start-Sleep -Milliseconds 60; [ZaalisInput]::keybd_event(0x5B,0,2,[UIntPtr]::Zero) }
  Result @{ok=$true}
}
if ($a.action -eq 'observe' -or $a.action -eq 'inspect') {
  $target = 'active_window'
  if ($a.action -eq 'observe') { $target = 'display' }
  elseif ($a.target) { $target = [string]$a.target }
  if ($target -eq 'region') { $bounds = @{x=[int]$a.x;y=[int]$a.y;width=[int]$a.width;height=[int]$a.height} }
  elseif ($target -eq 'display') { $bounds = VirtualBounds }
  else { $bounds = WindowBounds }
  $maxDim = 1600
  if ($a.max_dimension) { $maxDim = [int]$a.max_dimension }
  $cap = Capture $bounds $maxDim
  $title = ActiveTitle
  Result @{ok=$true;image=$cap.image;mime='image/png';target=$target;capture=$cap.capture;image_width=$cap.image_width;image_height=$cap.image_height;application=$title;ocr=@();ui=@{application=$title;elements=@();truncated=$false}}
}
if ($a.action -eq 'menus') { Result @{ok=$true;application=(ActiveTitle);menus=@()} }
Result @{ok=$false;error='unsupported-action'}
`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      env: { ...process.env, ZAALIS_COMPUTER_ACTION: payload },
      timeout: 25000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) return resolve({ ok: false, error: (stderr || error.message || 'windows-computer-failed').slice(0, 1000) });
      try { resolve(JSON.parse(String(stdout || '').trim())); }
      catch { resolve({ ok: false, error: 'windows-computer-invalid-response' }); }
    });
  });
}

module.exports = { call };
