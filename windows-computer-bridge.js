'use strict';

const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const PORT = Number(process.env.ZAALIS_PORT || process.env.PORT) || 3000;

// per-launch secret (the Windows equivalent of the macOS bridge secret).
const WINDOWS_FOG_SECRET = crypto.randomBytes(32).toString('hex');
let windowsFogProcess = null;

function stopWindowsActivityFog() {
  const child = windowsFogProcess;
  if (!child) return;
  try { child.kill(); } catch {}
  if (windowsFogProcess === child) windowsFogProcess = null;
}

async function startWindowsActivityFog() {
  if (process.platform !== 'win32') return { ok: false, error: 'unsupported-platform' };
  if (windowsFogProcess && windowsFogProcess.exitCode == null) return { ok: true, pid: windowsFogProcess.pid };
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ZaalisFogNative {
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int index, int value);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
}
'@
# powershell.exe spawné démarre DPI-unaware : sur un 4K à 150 %, les bornes
# écran sont virtualisées et la brume sort floue/décalée. On force le mode
# per-monitor puis on mesure l'échelle DIP->pixels réellement appliquée par
# WPF sur une fenêtre sonde (M11) — la seule source fiable.
try { [void][ZaalisFogNative]::SetProcessDpiAwareness(2) } catch {}
$probe = New-Object Windows.Window
$probe.WindowStyle = 'None'; $probe.ResizeMode = 'NoResize'; $probe.AllowsTransparency = $true
$probe.Background = [Windows.Media.Brushes]::Transparent; $probe.ShowInTaskbar = $false
$probe.Left = 0; $probe.Top = 0; $probe.Width = 1; $probe.Height = 1; $probe.Opacity = 0
$probe.Show()
$dip = [Windows.PresentationSource]::FromVisual($probe).CompositionTarget.TransformToDevice.M11
$probe.Close()
if (-not ($dip -gt 0)) { $dip = 1 }
foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
  $b = $screen.Bounds
  $win = New-Object Windows.Window
  $win.WindowStyle = 'None'; $win.ResizeMode = 'NoResize'; $win.AllowsTransparency = $true
  $win.Background = [Windows.Media.Brushes]::Transparent; $win.ShowInTaskbar = $false; $win.Topmost = $true
  $win.Left = $b.X / $dip; $win.Top = $b.Y / $dip; $win.Width = $b.Width / $dip; $win.Height = $b.Height / $dip
  $win.Add_SourceInitialized({
    $helper = New-Object Windows.Interop.WindowInteropHelper($this)
    $style = [ZaalisFogNative]::GetWindowLong($helper.Handle, -20)
    [void][ZaalisFogNative]::SetWindowLong($helper.Handle, -20, ($style -bor 0x20 -bor 0x80))
  })
  $border = New-Object Windows.Controls.Border
  $border.BorderThickness = 24; $border.CornerRadius = 8; $border.Opacity = .76
  $brush = New-Object Windows.Media.LinearGradientBrush
  $brush.StartPoint = New-Object Windows.Point 0,0; $brush.EndPoint = New-Object Windows.Point 1,1
  [void]$brush.GradientStops.Add((New-Object Windows.Media.GradientStop ([Windows.Media.Color]::FromRgb(109,40,217),0)))
  [void]$brush.GradientStops.Add((New-Object Windows.Media.GradientStop ([Windows.Media.Color]::FromRgb(216,180,254),.5)))
  [void]$brush.GradientStops.Add((New-Object Windows.Media.GradientStop ([Windows.Media.Color]::FromRgb(109,40,217),1)))
  $border.BorderBrush = $brush
  $border.Effect = New-Object Windows.Media.Effects.BlurEffect -Property @{ Radius = 24 }
  $win.Content = $border; $win.Show()
}
# Bouton « Stopper l'IA » : petit rectangle arrondi en bas au centre de
# l'écran principal. Cliquable (pas de click-through) ; il coupe la session
# d'automatisation côté serveur puis ferme l'overlay.
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$stopWin = New-Object Windows.Window
$stopWin.WindowStyle = 'None'; $stopWin.ResizeMode = 'NoResize'; $stopWin.AllowsTransparency = $true
$stopWin.Background = [Windows.Media.Brushes]::Transparent; $stopWin.ShowInTaskbar = $false; $stopWin.Topmost = $true
$stopWin.Width = 150; $stopWin.Height = 56
$stopWin.Left = ($wa.X + $wa.Width / 2) / $dip - 75
$stopWin.Top = ($wa.Y + $wa.Height) / $dip - 72
$stopButton = New-Object Windows.Controls.Border
$stopButton.CornerRadius = 12; $stopButton.Height = 40; $stopButton.VerticalAlignment = 'Center'
$stopButton.Cursor = [Windows.Input.Cursors]::Hand
$stopButton.Background = New-Object Windows.Media.SolidColorBrush ([Windows.Media.Color]::FromRgb(219,61,86))
$stopButton.BorderThickness = 1
$stopButton.BorderBrush = New-Object Windows.Media.SolidColorBrush ([Windows.Media.Color]::FromArgb(120,255,255,255))
$stopShadow = New-Object Windows.Media.Effects.DropShadowEffect
$stopShadow.Color = [Windows.Media.Color]::FromRgb(46,16,101); $stopShadow.BlurRadius = 18; $stopShadow.ShadowDepth = 2; $stopShadow.Opacity = .5
$stopButton.Effect = $stopShadow
$stopText = New-Object Windows.Controls.TextBlock
$stopText.Text = "Stopper l'IA"; $stopText.Foreground = [Windows.Media.Brushes]::White
$stopText.FontWeight = 'SemiBold'; $stopText.FontSize = 13
$stopText.HorizontalAlignment = 'Center'; $stopText.VerticalAlignment = 'Center'
$stopButton.Child = $stopText
$stopButton.Add_MouseEnter({ $this.Background = New-Object Windows.Media.SolidColorBrush ([Windows.Media.Color]::FromRgb(190,45,70)) })
$stopButton.Add_MouseLeave({ $this.Background = New-Object Windows.Media.SolidColorBrush ([Windows.Media.Color]::FromRgb(219,61,86)) })
$stopButton.Add_MouseLeftButtonDown({
  try { Invoke-WebRequest -UseBasicParsing -Method Post -Uri ("http://127.0.0.1:" + $env:ZAALIS_FOG_PORT + "/api/automation/stop-bridge") -Headers @{ 'x-zaalis-computer' = $env:ZAALIS_FOG_SECRET } -TimeoutSec 5 | Out-Null } catch {}
  [Windows.Threading.Dispatcher]::CurrentDispatcher.BeginInvokeShutdown([Windows.Threading.DispatcherPriority]::Background)
})
$stopWin.Content = $stopButton; $stopWin.Show()
[Windows.Threading.Dispatcher]::Run()
`;
  const child = spawn('powershell.exe', ['-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, ZAALIS_FOG_SECRET: WINDOWS_FOG_SECRET, ZAALIS_FOG_PORT: String(PORT) },
  });
  windowsFogProcess = child;
  child.once('exit', () => { if (windowsFogProcess === child) windowsFogProcess = null; });
  child.once('error', () => { if (windowsFogProcess === child) windowsFogProcess = null; });
  await new Promise((resolve) => setTimeout(resolve, 450));
  return child.exitCode == null ? { ok: true, pid: child.pid } : { ok: false, error: `fog-exited:${child.exitCode}` };
}

async function windowsComputerAction(action) {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, error: 'unsupported-platform' });
  if (action && action.action === 'overlay_start') return startWindowsActivityFog();
  if (action && action.action === 'overlay_stop') { stopWindowsActivityFog(); return Promise.resolve({ ok: true }); }
  const payload = Buffer.from(JSON.stringify(action || {}), 'utf8').toString('base64');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
if (-not ('ZaalisNative' -as [type])) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ZaalisNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
}
'@
}
# powershell.exe spawné démarre DPI-unaware : sur un écran 4K à 150 %, les
# métriques GDI (Screen.Bounds, GetWindowRect, SetCursorPos) sont virtualisées
# (2560x1440) alors que UI Automation renvoie des pixels physiques (3840x2160).
# Les clics guidés par inspect atterrissent alors 1,5x trop loin. On force le
# mode per-monitor AVANT toute lecture de métrique pour que capture, éléments
# UI et souris partagent le même repère physique.
try { [void][ZaalisNative]::SetProcessDpiAwareness(2) } catch {}
$a = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ZAALIS_COMPUTER_ACTION)) | ConvertFrom-Json
$ok = @{ ok = $true }
switch ($a.action) {
  'status' { $ok.accessibility = $true; $ok.screenRecording = $true }
  'request_permissions' { $ok.accessibility = $true; $ok.screenRecording = $true }
  'observe' {
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object Drawing.Bitmap $bounds.Width, $bounds.Height
    $g = [Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.Size)
    $stream = New-Object IO.MemoryStream
    $bmp.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
    $ok.image = [Convert]::ToBase64String($stream.ToArray()); $ok.mime = 'image/png'
    $stream.Dispose(); $g.Dispose(); $bmp.Dispose()
  }
  'inspect' {
    $handle = [ZaalisNative]::GetForegroundWindow()
    $title = New-Object Text.StringBuilder 1024
    [void][ZaalisNative]::GetWindowText($handle, $title, $title.Capacity)
    [uint32]$pidValue = 0; [void][ZaalisNative]::GetWindowThreadProcessId($handle, [ref]$pidValue)
    $processName = ''; try { $processName = (Get-Process -Id $pidValue -ErrorAction Stop).ProcessName } catch {}
    $ok.application = $title.ToString()
    $target = [string]$a.target; if ($target -notin @('active_window','display','region')) { $target = 'active_window' }
    $screens = @([System.Windows.Forms.Screen]::AllScreens)
    $displayIndex = 0; try { $displayIndex = [Math]::Max(0, [Math]::Min([int]$a.display_index, $screens.Count - 1)) } catch {}
    $captureBounds = $null
    if ($target -eq 'display') { $captureBounds = $screens[$displayIndex].Bounds }
    elseif ($target -eq 'region') { $captureBounds = [Drawing.Rectangle]::new([int]$a.x, [int]$a.y, [int]$a.width, [int]$a.height) }
    else {
      $rect = New-Object ZaalisNative+RECT
      if ([ZaalisNative]::GetWindowRect($handle, [ref]$rect) -and $rect.Right -gt $rect.Left -and $rect.Bottom -gt $rect.Top) {
        $captureBounds = [Drawing.Rectangle]::new($rect.Left, $rect.Top, $rect.Right - $rect.Left, $rect.Bottom - $rect.Top)
      } else { $captureBounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds }
    }
    $ok.target = $target
    $ok.capture = [PSCustomObject]@{ x=$captureBounds.X; y=$captureBounds.Y; width=$captureBounds.Width; height=$captureBounds.Height; displayIndex=$displayIndex }
    if ($a.include_image -ne $false) {
      try {
        $limit = 2560; try { $limit = [Math]::Max(800, [Math]::Min([int]$a.max_dimension, 4096)) } catch {}
        $scale = [Math]::Min(1.0, [Math]::Min($limit / [double]$captureBounds.Width, $limit / [double]$captureBounds.Height))
        $outputWidth = [Math]::Max(1, [int][Math]::Round($captureBounds.Width * $scale))
        $outputHeight = [Math]::Max(1, [int][Math]::Round($captureBounds.Height * $scale))
        $source = New-Object Drawing.Bitmap $captureBounds.Width, $captureBounds.Height
        $sourceGraphics = [Drawing.Graphics]::FromImage($source)
        $sourceGraphics.CopyFromScreen($captureBounds.Location, [Drawing.Point]::Empty, $captureBounds.Size)
        $bmp = if ($outputWidth -eq $captureBounds.Width -and $outputHeight -eq $captureBounds.Height) { $source } else { New-Object Drawing.Bitmap $outputWidth, $outputHeight }
        $g = if ($bmp -eq $source) { $sourceGraphics } else { [Drawing.Graphics]::FromImage($bmp) }
        if ($bmp -ne $source) { $g.DrawImage($source, 0, 0, $outputWidth, $outputHeight) }
        $stream = New-Object IO.MemoryStream
        $bmp.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
        $ok.image = [Convert]::ToBase64String($stream.ToArray()); $ok.mime = 'image/png'
        $ok.capture | Add-Member -NotePropertyName imageWidth -NotePropertyValue $outputWidth
        $ok.capture | Add-Member -NotePropertyName imageHeight -NotePropertyValue $outputHeight
        $stream.Dispose(); if ($g -ne $sourceGraphics) { $g.Dispose() }; $sourceGraphics.Dispose(); if ($bmp -ne $source) { $bmp.Dispose() }; $source.Dispose()
      } catch { $ok.captureError = $_.Exception.Message }
    }
    if ($a.include_ocr -ne $false -and $a.include_image -ne $false) {
      # UI Automation below supplies accessible text. Do not claim OCR unless a
      # packaged Windows OCR component is available in this build.
      $ok.ocr = @(); $ok.ocrError = 'ocr-not-available-on-this-windows-build'
    }
    if ($a.include_ui -ne $false) {
      try {
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes
        $root = [Windows.Automation.AutomationElement]::FromHandle($handle)
        $nodes = $root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
        $maxElements = 220; try { $maxElements = [Math]::Max(25, [Math]::Min([int]$a.max_elements, 400)) } catch {}
        $elements = @()
        for ($i=0; $i -lt [Math]::Min($nodes.Count, 1200) -and $elements.Count -lt $maxElements; $i++) {
          try {
            $node = $nodes.Item($i); $current = $node.Current; $box = $current.BoundingRectangle
            if ($box.Width -le 0 -or $box.Height -le 0) { continue }
            $isPassword = [bool]$current.IsPassword
            $value = $null
            if (-not $isPassword) {
              try { $pattern = $null; if ($node.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { $value = ([Windows.Automation.ValuePattern]$pattern).Current.Value } } catch {}
            }
            $elements += [PSCustomObject]@{
              role=($current.ControlType.ProgrammaticName -replace '^ControlType\\.',''); title=if ($isPassword) { '[secure field]' } else { $current.Name }; label=if ($isPassword) { $null } else { $current.AutomationId }; help=if ($isPassword) { $null } else { $current.HelpText }; value=$value
              frame=[PSCustomObject]@{ x=[int][Math]::Round($box.X); y=[int][Math]::Round($box.Y); width=[int][Math]::Round($box.Width); height=[int][Math]::Round($box.Height) }; enabled=[bool]$current.IsEnabled; offscreen=[bool]$current.IsOffscreen; secure=$isPassword
            }
          } catch {}
        }
        $ok.ui = [PSCustomObject]@{ application=$ok.application; bundleId=$processName; focusedWindow=[PSCustomObject]@{ x=$captureBounds.X; y=$captureBounds.Y; width=$captureBounds.Width; height=$captureBounds.Height }; truncated=($nodes.Count -gt $elements.Count); elements=$elements }
      } catch { $ok.uiError = $_.Exception.Message }
    }
  }
  'menus' {
    $title = New-Object Text.StringBuilder 1024
    $handle = [ZaalisNative]::GetForegroundWindow()
    [void][ZaalisNative]::GetWindowText($handle, $title, $title.Capacity)
    [uint32]$pidValue = 0; [void][ZaalisNative]::GetWindowThreadProcessId($handle, [ref]$pidValue)
    $processName = ''; try { $processName = (Get-Process -Id $pidValue -ErrorAction Stop).ProcessName } catch {}
    $ok.application = $title.ToString()
    $ok.process = $processName
    $items = @()
    try {
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      $root = [Windows.Automation.AutomationElement]::FromHandle($handle)
      $nodes = $root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
      for ($i=0; $i -lt [Math]::Min($nodes.Count,700) -and $items.Count -lt 120; $i++) {
        try {
          $node = $nodes.Item($i); $kind = $node.Current.ControlType.ProgrammaticName -replace '^ControlType\\.',''
          if ($kind -notin @('MenuBar','MenuItem','Button','Tab','TabItem','ToolBar','SplitButton')) { continue }
          $name = $node.Current.Name
          if ([string]::IsNullOrWhiteSpace($name)) { continue }
          $items += [PSCustomObject]@{ name=$name; type=$kind; shortcut=$node.Current.AcceleratorKey; accessKey=$node.Current.AccessKey }
        } catch {}
      }
    } catch {}
    if ($items.Count -eq 0 -and $processName -match 'chrome|msedge|firefox') {
      $items = @(
        [PSCustomObject]@{name='New tab';type='Shortcut';shortcut='Ctrl+T';source='browser-standard'},
        [PSCustomObject]@{name='Focus address bar';type='Shortcut';shortcut='Ctrl+L';source='browser-standard'},
        [PSCustomObject]@{name='New window';type='Shortcut';shortcut='Ctrl+N';source='browser-standard'},
        [PSCustomObject]@{name='Reopen closed tab';type='Shortcut';shortcut='Ctrl+Shift+T';source='browser-standard'},
        [PSCustomObject]@{name='Find in page';type='Shortcut';shortcut='Ctrl+F';source='browser-standard'},
        [PSCustomObject]@{name='Downloads';type='Shortcut';shortcut='Ctrl+J';source='browser-standard'},
        [PSCustomObject]@{name='History';type='Shortcut';shortcut='Ctrl+H';source='browser-standard'},
        [PSCustomObject]@{name='Close tab';type='Shortcut';shortcut='Ctrl+W';source='browser-standard'}
      )
    } elseif ($items.Count -eq 0 -and $processName -match 'notepad') {
      $items = @(
        [PSCustomObject]@{name='New tab';type='Shortcut';shortcut='Ctrl+N';source='notepad-standard'},
        [PSCustomObject]@{name='New window';type='Shortcut';shortcut='Ctrl+Shift+N';source='notepad-standard'},
        [PSCustomObject]@{name='Open';type='Shortcut';shortcut='Ctrl+O';source='notepad-standard'},
        [PSCustomObject]@{name='Save';type='Shortcut';shortcut='Ctrl+S';source='notepad-standard'},
        [PSCustomObject]@{name='Find';type='Shortcut';shortcut='Ctrl+F';source='notepad-standard'},
        [PSCustomObject]@{name='Replace';type='Shortcut';shortcut='Ctrl+H';source='notepad-standard'},
        [PSCustomObject]@{name='Close tab';type='Shortcut';shortcut='Ctrl+W';source='notepad-standard'}
      )
    } elseif ($items.Count -eq 0) {
      $items = @(
        [PSCustomObject]@{name='Select all';type='Shortcut';shortcut='Ctrl+A';source='windows-standard'},
        [PSCustomObject]@{name='Copy';type='Shortcut';shortcut='Ctrl+C';source='windows-standard'},
        [PSCustomObject]@{name='Paste';type='Shortcut';shortcut='Ctrl+V';source='windows-standard'},
        [PSCustomObject]@{name='Cut';type='Shortcut';shortcut='Ctrl+X';source='windows-standard'},
        [PSCustomObject]@{name='Undo';type='Shortcut';shortcut='Ctrl+Z';source='windows-standard'},
        [PSCustomObject]@{name='Redo';type='Shortcut';shortcut='Ctrl+Y';source='windows-standard'},
        [PSCustomObject]@{name='Save';type='Shortcut';shortcut='Ctrl+S';source='windows-standard'},
        [PSCustomObject]@{name='Find';type='Shortcut';shortcut='Ctrl+F';source='windows-standard'}
      )
    }
    $ok.menus = $items
  }
  'move' { [void][ZaalisNative]::SetCursorPos([int]$a.x, [int]$a.y) }
  'click' {
    [void][ZaalisNative]::SetCursorPos([int]$a.x, [int]$a.y)
    if ($a.button -eq 'right') { [ZaalisNative]::mouse_event(0x0008,0,0,0,[UIntPtr]::Zero); [ZaalisNative]::mouse_event(0x0010,0,0,0,[UIntPtr]::Zero) }
    else { [ZaalisNative]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero); [ZaalisNative]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero) }
  }
  'scroll' { [ZaalisNative]::mouse_event(0x0800,0,0,[uint32]([int]$a.dy * 120),[UIntPtr]::Zero) }
  'type' { Set-Clipboard -Value ([string]$a.text); [System.Windows.Forms.SendKeys]::SendWait('^v') }
  'key' {
    $mods = @($a.modifiers | ForEach-Object { $_.ToString().ToLowerInvariant() })
    $held = New-Object Collections.Generic.List[byte]
    function Hold-Key([byte]$vk) { [ZaalisNative]::keybd_event($vk,0,0,[UIntPtr]::Zero); $held.Add($vk) }
    if ($mods -match 'ctrl|control|cmd|command') { Hold-Key 0x11 }
    if ($mods -match 'alt|option|opt') { Hold-Key 0x12 }
    if ($mods -match 'shift') { Hold-Key 0x10 }
    if ($mods -match 'meta|super|win|windows') { Hold-Key 0x5B }
    $name = $a.key.ToString().ToLowerInvariant()
    $keys = @{ enter=0x0D; return=0x0D; tab=0x09; escape=0x1B; esc=0x1B; backspace=0x08; delete=0x2E; insert=0x2D; space=0x20; up=0x26; down=0x28; left=0x25; right=0x27; home=0x24; end=0x23; pageup=0x21; pagedown=0x22; pgup=0x21; pgdn=0x22; printscreen=0x2C; prtsc=0x2C; pause=0x13; capslock=0x14; numlock=0x90; scrolllock=0x91; menu=0x5D; apps=0x5D; win=0x5B; windows=0x5B; volumeup=0xAF; volumedown=0xAE; volumemute=0xAD; medianext=0xB0; mediaprev=0xB1; mediastop=0xB2; mediaplaypause=0xB3 }
    [byte]$vk = 0
    if ($keys.ContainsKey($name)) { $vk = $keys[$name] }
    elseif ($name -match '^f([1-9]|1[0-9]|2[0-4])$') { $vk = [byte](0x6F + [int]$Matches[1]) }
    elseif ($name.Length -eq 1) { $vk = [byte][char]$name.ToUpperInvariant() }
    else { throw "unsupported-key:$name" }
    [ZaalisNative]::keybd_event($vk,0,0,[UIntPtr]::Zero); [ZaalisNative]::keybd_event($vk,0,2,[UIntPtr]::Zero)
    for ($i=$held.Count-1; $i -ge 0; $i--) { [ZaalisNative]::keybd_event($held[$i],0,2,[UIntPtr]::Zero) }
  }
  'open_terminal' { Start-Process -FilePath $(if ($env:ComSpec) { $env:ComSpec } else { 'cmd.exe' }) }
  'activate_app' {
    $target = [string]$a.path
    $alias = $target.ToLowerInvariant()
    $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    if ($alias -in @('chrome','chrome.exe')) {
      $target = @("$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe", "$pf86\\Google\\Chrome\\Application\\chrome.exe", "$env:LOCALAPPDATA\\Google\\Chrome\\Application\\chrome.exe") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
      if (-not $target) { throw 'chrome-not-found' }
    } elseif ($alias -in @('edge','msedge','msedge.exe')) {
      $target = @("$pf86\\Microsoft\\Edge\\Application\\msedge.exe", "$env:ProgramFiles\\Microsoft\\Edge\\Application\\msedge.exe") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
      if (-not $target) { throw 'edge-not-found' }
    } elseif ($alias -in @('notepad','notepad.exe')) {
      # Sur Windows 11, « notepad » du PATH est un app-execution-alias (point de
      # réanalyse) que Start-Process refuse de lancer. Le stub System32 relaie
      # correctement vers le Bloc-notes du Store.
      $target = Join-Path $env:WINDIR 'System32\\notepad.exe'
    }
    $baseName = [IO.Path]::GetFileNameWithoutExtension($target)
    if ($alias -match 'chrome') { $baseName = 'chrome' }
    elseif ($alias -match 'edge|msedge') { $baseName = 'msedge' }
    elseif ($alias -match 'notepad') { $baseName = 'notepad' }
    $proc = $null
    try { $proc = Start-Process -FilePath $target -PassThru }
    catch {
      # Dernier recours pour les app-execution-aliases : cmd start sait les
      # résoudre là où Start-Process échoue.
      Start-Process -FilePath (Join-Path $env:WINDIR 'System32\\cmd.exe') -ArgumentList @('/c','start','""',('"' + $target + '"')) -WindowStyle Hidden
    }
    if ($proc) { try { [void]$proc.WaitForInputIdle(1800) } catch { Start-Sleep -Milliseconds 500 } } else { Start-Sleep -Milliseconds 700 }
    $focusProc = $proc
    for ($attempt=0; $attempt -lt 8; $attempt++) {
      Start-Sleep -Milliseconds 180
      $candidate = Get-Process -Name $baseName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object StartTime -Descending | Select-Object -First 1
      if ($candidate) { $focusProc = $candidate; break }
      try { $focusProc.Refresh() } catch {}
    }
    if (-not $focusProc) { throw "activate-app-window-not-found:$baseName" }
    try {
      $shell = New-Object -ComObject WScript.Shell
      if (-not $shell.AppActivate($focusProc.Id)) {
        if ($alias -match 'chrome') { [void]$shell.AppActivate('Google Chrome') }
        elseif ($alias -match 'edge|msedge') { [void]$shell.AppActivate('Microsoft Edge') }
        elseif ($alias -match 'notepad') { if (-not $shell.AppActivate('Bloc-notes')) { [void]$shell.AppActivate('Notepad') } }
      }
    } catch {}
    if ($focusProc.MainWindowHandle) {
      [void][ZaalisNative]::ShowWindowAsync($focusProc.MainWindowHandle, 9)
      [ZaalisNative]::keybd_event(0x12,0,0,[UIntPtr]::Zero); [ZaalisNative]::keybd_event(0x12,0,2,[UIntPtr]::Zero)
      [void][ZaalisNative]::BringWindowToTop($focusProc.MainWindowHandle)
      [void][ZaalisNative]::SetForegroundWindow($focusProc.MainWindowHandle)
      [ZaalisNative]::SwitchToThisWindow($focusProc.MainWindowHandle, $true)
    }
    Start-Sleep -Milliseconds 180
    $ok.processId = $focusProc.Id
    $ok.windowTitle = $focusProc.MainWindowTitle
    $ok.windowHandle = [int64]$focusProc.MainWindowHandle
  }
  default { throw "unsupported-action:$($a.action)" }
}
$ok | ConvertTo-Json -Compress -Depth 7
`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      timeout: 30_000, windowsHide: true, maxBuffer: 24 * 1024 * 1024,
      env: { ...process.env, ZAALIS_COMPUTER_ACTION: payload },
    }, (error, stdout, stderr) => {
      if (error) return resolve({ ok: false, error: (stderr || error.message || 'windows-computer-failed').trim().slice(0, 1000) });
      try { resolve(JSON.parse(String(stdout).trim())); }
      catch { resolve({ ok: false, error: 'windows-computer-invalid-response' }); }
    });
  });
}

module.exports = { windowsComputerAction };
