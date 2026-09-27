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

// Overlay d'activité du contrôle de bureau.  Palette, proportions, cadence de
// respiration, dérive de la brume et barre de contrôle sont identiques aux
// éditions macOS (Electron) et Linux (GTK/cairo) : seul le moteur de rendu
// change.  C'est un processus WPF séparé et traversant (WS_EX_TRANSPARENT), donc
// il ne modifie jamais le chemin d'entrée réel utilisé par le pont de contrôle.
//
// La barre du bas porte le bouton « Arrêter le travail » : elle est, elle,
// cliquable, et appelle /api/automation/stop-bridge avec le secret tiré au
// lancement du serveur — jamais avec la session de l'utilisateur.
function startOverlay({ port, secret }) {
  if (overlayProcess && overlayProcess.exitCode == null) return { ok: true, pid: overlayProcess.pid };
  const script = String.raw`
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase,System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class ZaalisOverlayNative {
  [DllImport("user32.dll", SetLastError=true)] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll", SetLastError=true)] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
# Un powershell.exe lance depuis un service est DPI-unaware : sur un ecran 4K a
# 150%, la fenetre ne couvrirait qu'une partie du bureau. On declare donc la
# conscience par moniteur AVANT de creer la moindre fenetre, puis on positionne
# chaque fenetre en pixels physiques via SetWindowPos (WPF, lui, raisonne en
# unites logiques : les 28 px de bordure restent l'equivalent exact des 28 px
# CSS de macOS).
try { [void][ZaalisOverlayNative]::SetProcessDpiAwareness(2) } catch { try { [void][ZaalisOverlayNative]::SetProcessDPIAware() } catch {} }

$app = New-Object Windows.Application
$app.ShutdownMode = [Windows.ShutdownMode]::OnExplicitShutdown

# Une fenetre de bordure PAR ECRAN, comme l'overlay macOS : sur un poste
# multi-ecrans, chaque bureau recoit son propre cadre, au lieu d'un seul cadre
# autour du rectangle englobant qui laisserait les bords interieurs nus.
$overlays = @()
foreach ($display in [Windows.Forms.Screen]::AllScreens) {
$bounds = $display.Bounds
$w = [double]$bounds.Width
$h = [double]$bounds.Height

# Geometrie de la brume, transposee de la feuille de style macOS :
#   .mist { inset:-25% }  -> la couche mesure 150% du bureau, decalee de -25%
#   radial-gradient(ellipse at 15% 20%, rgba(157,89,255,.28), transparent 32%)
#   radial-gradient(ellipse at 80% 84%, rgba(102,45,210,.28), transparent 38%)
# Un degrade radial CSS sans taille explicite s'etend jusqu'au coin le plus
# eloigne : ramenes en coordonnees du bureau, les deux halos se logent donc dans
# les coins haut-gauche et bas-droit, et non au milieu de l'ecran. Ici l'ellipse
# WPF EST la zone coloree (opaque au centre, transparente au bord), ce qui
# reproduit exactement l'arret « transparent 32% / 38% ».
$e2w = 0.912 * $w; $e2h = 0.958 * $h; $e2x = 0.494 * $w; $e2y = 0.531 * $h
$driftX = 0.03 * $w; $driftY = -0.02 * $h
# Bord interieur du cadre en plumes : chaque bande fait 80 px (le double des
# 40 px du navigateur). $wm/$hm placent les bandes droite et basse.
$wm = $w - 80; $hm = $h - 80

# Bordure d'activite = portage WPF du halo « setAiControlBorder » du navigateur
# zaalis, en violet et deux fois plus epais :
#  - un rectangle plein rempli d'un degrade horizontal qui DEFILE (SpreadMethod
#    Repeat + TranslateTransform anime), exactement le background-position 0->200%
#    du navigateur ;
#  - un OpacityMask en « cadre plume » : 4 bandes (haut/bas/gauche/droite), chacune
#    transparente au ras du bord, opaque a 20 px, re-transparente a 80 px. C'est la
#    transposition du -webkit-mask du navigateur (transparent, #000 10px, transparent
#    40px) porte au double. Les geometries sont en px ecran ; DrawingBrush Stretch=Fill
#    les remet a l'echelle 1:1 quel que soit le DPI.
#  - un BlurEffect qui diffuse le tout (equivalent du filter:blur), pose sur le
#    conteneur pour que le flou s'applique APRES le masque, comme en CSS.
[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" WindowStyle="None" AllowsTransparency="True" Background="Transparent" ShowInTaskbar="False" Topmost="True" ShowActivated="False" ResizeMode="NoResize" IsHitTestVisible="False">
  <Grid IsHitTestVisible="False" ClipToBounds="True">
    <Canvas x:Name="Mist" RenderTransformOrigin="0.5,0.5">
      <Canvas.RenderTransform><TransformGroup><ScaleTransform x:Name="MistScale" ScaleX="1" ScaleY="1"/><TranslateTransform x:Name="MistShift" X="0" Y="0"/></TransformGroup></Canvas.RenderTransform>
      <Canvas.Effect><BlurEffect Radius="20"/></Canvas.Effect>
      <Ellipse Width="$e2w" Height="$e2h" Canvas.Left="$e2x" Canvas.Top="$e2y" Opacity="0.28">
        <Ellipse.Fill><RadialGradientBrush><GradientStop Color="#FF662DD2" Offset="0"/><GradientStop Color="#00662DD2" Offset="1"/></RadialGradientBrush></Ellipse.Fill>
      </Ellipse>
    </Canvas>
    <Grid Opacity="0.8">
      <Grid.Effect><BlurEffect Radius="28"/></Grid.Effect>
      <Rectangle x:Name="Glow">
        <Rectangle.Fill>
          <LinearGradientBrush StartPoint="0,0.5" EndPoint="0.5,0.5" SpreadMethod="Repeat">
            <LinearGradientBrush.RelativeTransform><TranslateTransform x:Name="FlowShift" X="0" Y="0"/></LinearGradientBrush.RelativeTransform>
            <GradientStop Color="#D95B22AF" Offset="0"/>
            <GradientStop Color="#D99D59FF" Offset="0.25"/>
            <GradientStop Color="#D9C78CFF" Offset="0.5"/>
            <GradientStop Color="#D99D59FF" Offset="0.75"/>
            <GradientStop Color="#D95B22AF" Offset="1"/>
          </LinearGradientBrush>
        </Rectangle.Fill>
        <Rectangle.OpacityMask>
          <DrawingBrush Stretch="Fill">
            <DrawingBrush.Drawing>
              <DrawingGroup>
                <GeometryDrawing>
                  <GeometryDrawing.Geometry><RectangleGeometry Rect="0,0,$w,80"/></GeometryDrawing.Geometry>
                  <GeometryDrawing.Brush><LinearGradientBrush StartPoint="0,0" EndPoint="0,1"><GradientStop Color="#00FFFFFF" Offset="0"/><GradientStop Color="#FFFFFFFF" Offset="0.25"/><GradientStop Color="#00FFFFFF" Offset="1"/></LinearGradientBrush></GeometryDrawing.Brush>
                </GeometryDrawing>
                <GeometryDrawing>
                  <GeometryDrawing.Geometry><RectangleGeometry Rect="0,$hm,$w,80"/></GeometryDrawing.Geometry>
                  <GeometryDrawing.Brush><LinearGradientBrush StartPoint="0,0" EndPoint="0,1"><GradientStop Color="#00FFFFFF" Offset="0"/><GradientStop Color="#FFFFFFFF" Offset="0.75"/><GradientStop Color="#00FFFFFF" Offset="1"/></LinearGradientBrush></GeometryDrawing.Brush>
                </GeometryDrawing>
                <GeometryDrawing>
                  <GeometryDrawing.Geometry><RectangleGeometry Rect="0,0,80,$h"/></GeometryDrawing.Geometry>
                  <GeometryDrawing.Brush><LinearGradientBrush StartPoint="0,0" EndPoint="1,0"><GradientStop Color="#00FFFFFF" Offset="0"/><GradientStop Color="#FFFFFFFF" Offset="0.25"/><GradientStop Color="#00FFFFFF" Offset="1"/></LinearGradientBrush></GeometryDrawing.Brush>
                </GeometryDrawing>
                <GeometryDrawing>
                  <GeometryDrawing.Geometry><RectangleGeometry Rect="$wm,0,80,$h"/></GeometryDrawing.Geometry>
                  <GeometryDrawing.Brush><LinearGradientBrush StartPoint="0,0" EndPoint="1,0"><GradientStop Color="#00FFFFFF" Offset="0"/><GradientStop Color="#FFFFFFFF" Offset="0.75"/><GradientStop Color="#00FFFFFF" Offset="1"/></LinearGradientBrush></GeometryDrawing.Brush>
                </GeometryDrawing>
              </DrawingGroup>
            </DrawingBrush.Drawing>
          </DrawingBrush>
        </Rectangle.OpacityMask>
      </Rectangle>
    </Grid>
  </Grid>
</Window>
"@
$window = [Windows.Markup.XamlReader]::Load((New-Object Xml.XmlNodeReader $xaml))

# Derive de la brume : 12 s aller-retour, translation de 3% / -2% et zoom 1.06,
# exactement l'animation « drift » de la feuille de style macOS.
$mistScale = $window.FindName('MistScale')
$mistShift = $window.FindName('MistShift')
$drift = New-Object Windows.Media.Animation.Storyboard
$driftDuration = New-Object Windows.Duration ([TimeSpan]::FromSeconds(12))
foreach ($item in @(
  @{ Target = $mistScale; Property = 'ScaleX'; To = 1.06 },
  @{ Target = $mistScale; Property = 'ScaleY'; To = 1.06 },
  @{ Target = $mistShift; Property = 'X'; To = $driftX },
  @{ Target = $mistShift; Property = 'Y'; To = $driftY }
)) {
  $animation = New-Object Windows.Media.Animation.DoubleAnimation
  $animation.To = $item.To
  $animation.Duration = $driftDuration
  $animation.AutoReverse = $true
  $animation.RepeatBehavior = [Windows.Media.Animation.RepeatBehavior]::Forever
  [Windows.Media.Animation.Storyboard]::SetTarget($animation, $item.Target)
  [Windows.Media.Animation.Storyboard]::SetTargetProperty($animation, (New-Object Windows.PropertyPath $item.Property))
  $drift.Children.Add($animation)
}

# Defilement du degrade de la bordure : le brush est repete deux fois sur la
# largeur (EndPoint 0.5), donc translater de 0.5 fait glisser d'une tuile
# complete et boucle sans couture. 7 s lineaire, comme le navigateur.
$flow = $window.FindName('FlowShift')
$flowAnim = New-Object Windows.Media.Animation.DoubleAnimation
$flowAnim.From = 0.0
$flowAnim.To = 0.5
$flowAnim.Duration = New-Object Windows.Duration ([TimeSpan]::FromSeconds(7))
$flowAnim.RepeatBehavior = [Windows.Media.Animation.RepeatBehavior]::Forever

# GetNewClosure fige $bounds et $drift pour CETTE iteration : sans cela, les
# gestionnaires liraient la derniere valeur de la boucle et tous les cadres se
# poseraient sur le meme ecran.
$window.add_SourceInitialized({
  $source = [Windows.PresentationSource]::FromVisual($this)
  # WS_EX_TRANSPARENT (0x20) + WS_EX_TOOLWINDOW (0x80000) : la fenetre laisse
  # passer clics et survol, et n'apparait ni dans la barre des taches ni en Alt+Tab.
  $extended = [ZaalisOverlayNative]::GetWindowLong($source.Handle, -20)
  [void][ZaalisOverlayNative]::SetWindowLong($source.Handle, -20, ($extended -bor 0x20 -bor 0x80000))
  # SWP_NOZORDER (0x4) + SWP_NOACTIVATE (0x10) : on ne fixe que la geometrie.
  [void][ZaalisOverlayNative]::SetWindowPos($source.Handle, [IntPtr]::Zero, $bounds.Left, $bounds.Top, $bounds.Width, $bounds.Height, 0x14)
}.GetNewClosure())
$window.add_ContentRendered({
  $drift.Begin()
  $flow.BeginAnimation([Windows.Media.TranslateTransform]::XProperty, $flowAnim)
}.GetNewClosure())
$overlays += $window
}

# Barre de controle : meme geometrie que le dock macOS (320 x 58, centree en bas
# de la zone de travail de l'ecran principal, 34 px de marge).
[xml]$dockXaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" WindowStyle="None" AllowsTransparency="True" Background="Transparent" ShowInTaskbar="False" Topmost="True" ShowActivated="False" ResizeMode="NoResize" Width="320" Height="58">
  <Border CornerRadius="18" Background="#E1180E2A" BorderBrush="#5CD6BBFF" BorderThickness="1" Margin="0,2,0,2">
    <Grid Margin="13,0,13,0">
      <Grid.ColumnDefinitions><ColumnDefinition Width="Auto"/><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
      <Ellipse Grid.Column="0" Width="9" Height="9" Fill="#B36CFF" VerticalAlignment="Center">
        <Ellipse.Style><Style TargetType="Ellipse"><Style.Triggers><EventTrigger RoutedEvent="Loaded"><BeginStoryboard><Storyboard AutoReverse="True" RepeatBehavior="Forever"><DoubleAnimation Storyboard.TargetProperty="Opacity" To="0.45" Duration="0:0:0.8"/></Storyboard></BeginStoryboard></EventTrigger></Style.Triggers></Style></Ellipse.Style>
      </Ellipse>
      <TextBlock Grid.Column="1" Margin="12,0,12,0" VerticalAlignment="Center" Foreground="#F4ECFF" FontSize="12" FontWeight="SemiBold" TextTrimming="CharacterEllipsis" Text="L'IA travaille sur ce PC"/>
      <Button x:Name="Stop" Grid.Column="2" VerticalAlignment="Center" Foreground="White" FontSize="12" FontWeight="Bold" BorderThickness="0" Padding="12,8,12,8" Cursor="Hand" Content="Arr&#234;ter le travail">
        <Button.Template>
          <ControlTemplate TargetType="Button">
            <Border x:Name="Chip" CornerRadius="11" Background="#DB3D56"><ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center" Margin="{TemplateBinding Padding}"/></Border>
            <ControlTemplate.Triggers><Trigger Property="IsMouseOver" Value="True"><Setter TargetName="Chip" Property="Background" Value="#F05068"/></Trigger></ControlTemplate.Triggers>
          </ControlTemplate>
        </Button.Template>
      </Button>
    </Grid>
  </Border>
</Window>
"@
$dock = [Windows.Markup.XamlReader]::Load((New-Object Xml.XmlNodeReader $dockXaml))
$dock.add_SourceInitialized({
  $source = [Windows.PresentationSource]::FromVisual($dock)
  $extended = [ZaalisOverlayNative]::GetWindowLong($source.Handle, -20)
  # WS_EX_NOACTIVATE seulement : la barre doit rester cliquable.
  [void][ZaalisOverlayNative]::SetWindowLong($source.Handle, -20, ($extended -bor 0x8000000))
  # Sonde M11 : facteur d'echelle reel de CE moniteur, pour convertir les 320x58
  # unites logiques en pixels physiques attendus par SetWindowPos.
  $scale = $source.CompositionTarget.TransformToDevice.M11
  if (-not $scale -or $scale -le 0) { $scale = 1 }
  $dockW = [int](320 * $scale)
  $dockH = [int](58 * $scale)
  $work = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $dockX = [int]($work.Left + ($work.Width - $dockW) / 2)
  $dockY = [int]($work.Bottom - $dockH - (34 * $scale))
  [void][ZaalisOverlayNative]::SetWindowPos($source.Handle, [IntPtr]::Zero, $dockX, $dockY, $dockW, $dockH, 0x14)
})
$dock.FindName('Stop').add_Click({
  try {
    $uri = "http://127.0.0.1:$($env:ZAALIS_OVERLAY_PORT)/api/automation/stop-bridge"
    Invoke-RestMethod -Method Post -Uri $uri -Headers @{ 'x-zaalis-computer' = $env:ZAALIS_OVERLAY_SECRET } -TimeoutSec 5 | Out-Null
  } catch {}
  $app.Shutdown()
})

foreach ($overlay in $overlays) { $overlay.Show() }
$dock.Show()
$app.Run() | Out-Null
`;
  overlayProcess = spawn('powershell.exe', ['-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    stdio: 'ignore', windowsHide: true,
    env: { ...process.env, ZAALIS_OVERLAY_PORT: String(port), ZAALIS_OVERLAY_SECRET: String(secret) },
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

function call(action, overlayConfig) {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, error: 'unsupported-platform' });
  if (action && action.action === 'overlay_start') return Promise.resolve(startOverlay(overlayConfig || {}));
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

// Même forme que `createLinuxComputerAction` : le serveur fournit son port et le
// secret d'arrêt une seule fois, et obtient un gestionnaire d'action utilisable
// tel quel par AutomationManager.
function createWindowsComputerAction({ port, secret }) {
  return function windowsComputerAction(action) { return call(action, { port, secret }); };
}

module.exports = { call, createWindowsComputerAction };
