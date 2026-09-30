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
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
$e1w = 0.820 * $w; $e1h = 0.768 * $h; $e1x = -0.435 * $w; $e1y = -0.334 * $h
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
      <Ellipse Width="$e1w" Height="$e1h" Canvas.Left="$e1x" Canvas.Top="$e1y" Opacity="0.28">
        <Ellipse.Fill><RadialGradientBrush><GradientStop Color="#FF9D59FF" Offset="0"/><GradientStop Color="#009D59FF" Offset="1"/></RadialGradientBrush></Ellipse.Fill>
      </Ellipse>
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

// The action bridge, run by Windows PowerShell 5.1 for each action.
const BRIDGE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch {}
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public struct ZaalisRect { public int Left; public int Top; public int Right; public int Bottom; }
[StructLayout(LayoutKind.Sequential)] public struct ZaalisMouseInput { public int Dx; public int Dy; public uint Data; public uint Flags; public uint Time; public IntPtr Extra; }
[StructLayout(LayoutKind.Sequential)] public struct ZaalisKeyInput { public ushort Vk; public ushort Scan; public uint Flags; public uint Time; public IntPtr Extra; }
[StructLayout(LayoutKind.Explicit)] public struct ZaalisInputData { [FieldOffset(0)] public ZaalisMouseInput Mouse; [FieldOffset(0)] public ZaalisKeyInput Key; }
[StructLayout(LayoutKind.Sequential)] public struct ZaalisInputRecord { public uint Type; public ZaalisInputData Data; }
public static class ZaalisInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out ZaalisRect r);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attribute, out ZaalisRect r, int size);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern short VkKeyScanW(char ch);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, ZaalisInputRecord[] inputs, int size);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern uint RealGetWindowClass(IntPtr h, StringBuilder name, uint size);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] static extern int GetWindowStyle(IntPtr h, int index);
  [StructLayout(LayoutKind.Sequential)] struct GuiThreadInfo { public int Size; public uint Flags; public IntPtr Active; public IntPtr Focus; public IntPtr Capture; public IntPtr MenuOwner; public IntPtr MoveSize; public IntPtr Caret; public ZaalisRect CaretRect; }
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  // A classic Win32 edit box that masks what is typed (ES_PASSWORD): UI
  // Automation does not always report those as password fields.
  public static bool IsPasswordEdit(IntPtr h) {
    if (h == IntPtr.Zero) return false;
    StringBuilder name = new StringBuilder(256);
    RealGetWindowClass(h, name, 256);
    return name.ToString().IndexOf("edit", StringComparison.OrdinalIgnoreCase) >= 0 && (GetWindowStyle(h, -16) & 0x20) != 0;
  }
  public static bool FocusIsPasswordEdit() {
    uint pid;
    GuiThreadInfo info = new GuiThreadInfo();
    info.Size = Marshal.SizeOf(typeof(GuiThreadInfo));
    if (!GetGUIThreadInfo(GetWindowThreadProcessId(GetForegroundWindow(), out pid), ref info)) return false;
    return IsPasswordEdit(info.Focus);
  }

  static ZaalisInputRecord KeyRecord(ushort vk, ushort scan, uint flags) {
    ZaalisInputRecord record = new ZaalisInputRecord();
    record.Type = 1;
    record.Data.Key.Vk = vk; record.Data.Key.Scan = scan; record.Data.Key.Flags = flags;
    return record;
  }
  static void Flush(List<ZaalisInputRecord> batch) {
    if (batch.Count == 0) return;
    SendInput((uint)batch.Count, batch.ToArray(), Marshal.SizeOf(typeof(ZaalisInputRecord)));
    batch.Clear();
  }
  // Navigation keys live on the extended part of the keyboard: without the
  // flag, some applications read the arrows as the numeric keypad.
  static uint Extended(ushort vk) {
    return ((vk >= 0x21 && vk <= 0x28) || vk == 0x2C || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5D) ? 1u : 0u;
  }
  // Every character is sent as itself (KEYEVENTF_UNICODE), whatever the
  // keyboard layout: accents and symbols arrive intact and the user's
  // clipboard is never touched.
  public static int TypeText(string text) {
    List<ZaalisInputRecord> batch = new List<ZaalisInputRecord>();
    int typed = 0;
    foreach (char c in text) {
      if (c == '\r') continue;
      if (c == '\n' || c == '\t') {
        ushort vk = (ushort)(c == '\n' ? 0x0D : 0x09);
        batch.Add(KeyRecord(vk, 0, 0)); batch.Add(KeyRecord(vk, 0, 2));
      } else {
        batch.Add(KeyRecord(0, c, 4)); batch.Add(KeyRecord(0, c, 6));
      }
      typed++;
      if (batch.Count >= 64) { Flush(batch); Thread.Sleep(12); }
    }
    Flush(batch);
    return typed;
  }
  public static void Press(ushort[] modifiers, bool up) {
    List<ZaalisInputRecord> batch = new List<ZaalisInputRecord>();
    if (up) { for (int i = modifiers.Length - 1; i >= 0; i--) batch.Add(KeyRecord(modifiers[i], 0, Extended(modifiers[i]) | 2)); }
    else { foreach (ushort vk in modifiers) batch.Add(KeyRecord(vk, 0, Extended(vk))); }
    Flush(batch);
  }
  public static void Chord(ushort[] modifiers, ushort vk, int repeat) {
    Press(modifiers, false);
    List<ZaalisInputRecord> batch = new List<ZaalisInputRecord>();
    for (int i = 0; i < repeat; i++) { batch.Add(KeyRecord(vk, 0, Extended(vk))); batch.Add(KeyRecord(vk, 0, Extended(vk) | 2)); }
    Flush(batch);
    Press(modifiers, true);
  }
  // Wheel notches, in the unsigned field Windows expects.
  public static void Wheel(int notches, bool horizontal) {
    mouse_event(horizontal ? 0x1000u : 0x0800u, 0, 0, unchecked((uint)(notches * 120)), UIntPtr.Zero);
  }
  public static bool Focus(IntPtr window) {
    if (window == IntPtr.Zero) return false;
    if (IsIconic(window)) ShowWindow(window, 9);
    uint pid;
    uint foreground = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint self = GetCurrentThreadId();
    bool attached = foreground != 0 && foreground != self && AttachThreadInput(self, foreground, true);
    BringWindowToTop(window);
    SetForegroundWindow(window);
    if (attached) AttachThreadInput(self, foreground, false);
    if (GetForegroundWindow() == window) return true;
    // Windows hands the foreground only to the process behind the last input:
    // a lone Alt tap makes this process that one.
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(window);
    Thread.Sleep(60);
    return GetForegroundWindow() == window;
  }
  // A 64x36 grey thumbnail of the capture, as hex: enough to tell whether the
  // screen changed after an action, even when no text or control did.
  public static string Signature(System.Drawing.Bitmap source) {
    using (System.Drawing.Bitmap small = new System.Drawing.Bitmap(64, 36)) {
      using (System.Drawing.Graphics g = System.Drawing.Graphics.FromImage(small)) {
        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBilinear;
        g.DrawImage(source, 0, 0, 64, 36);
      }
      StringBuilder hex = new StringBuilder(64 * 36 * 2);
      for (int y = 0; y < 36; y++) {
        for (int x = 0; x < 64; x++) {
          System.Drawing.Color c = small.GetPixel(x, y);
          hex.Append(((c.R * 299 + c.G * 587 + c.B * 114) / 1000).ToString("x2"));
        }
      }
      return hex.ToString();
    }
  }
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
function Ui { Add-Type -AssemblyName WindowsBase, UIAutomationClient, UIAutomationTypes }
function VirtualBounds {
  $s = [Windows.Forms.SystemInformation]::VirtualScreen
  return @{ x=$s.Left; y=$s.Top; width=$s.Width; height=$s.Height }
}
# Index 0 is the main screen, then left to right: the order the model sees.
function Displays {
  $list = @()
  $i = 0
  foreach ($s in @([Windows.Forms.Screen]::AllScreens | Sort-Object @{ Expression = { -not $_.Primary } }, @{ Expression = { $_.Bounds.Left } }, @{ Expression = { $_.Bounds.Top } })) {
    $list += @{ index=$i; primary=[bool]$s.Primary; x=$s.Bounds.Left; y=$s.Bounds.Top; width=$s.Bounds.Width; height=$s.Bounds.Height }
    $i++
  }
  return ,$list
}
function WindowBounds {
  $handle = [ZaalisInput]::GetForegroundWindow()
  $rect = New-Object ZaalisRect
  if ($handle -ne [IntPtr]::Zero -and -not [ZaalisInput]::IsIconic($handle)) {
    # The DWM frame excludes the invisible resize borders GetWindowRect counts.
    $found = $false
    try { $found = ([ZaalisInput]::DwmGetWindowAttribute($handle, 9, [ref]$rect, 16) -eq 0) } catch {}
    if (-not $found) { $found = [ZaalisInput]::GetWindowRect($handle, [ref]$rect) }
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    if ($found -and $w -gt 40 -and $h -gt 40) { return @{ x=$rect.Left; y=$rect.Top; width=$w; height=$h } }
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
  return @{ bitmap=$out; capture=@{x=$b.x;y=$b.y;width=$b.width;height=$b.height}; image_width=$out.Width; image_height=$out.Height }
}
# Windows' own OCR (Windows.Media.Ocr, in the user's languages) on the image
# the model receives, so every frame is already in that image's pixels.
function Ocr($png, $limit) {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) { throw 'ocr-unavailable: aucune langue OCR installée' }
  $asTask = @([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -match '^IAsyncOperation.1$' })[0]
  $await = {
    param($operation, $type)
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
    if (-not $task.Wait(8000)) { throw 'ocr-timeout' }
    return $task.Result
  }
  $memory = New-Object IO.MemoryStream -ArgumentList (,$png)
  $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($memory)
  $decoder = & $await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = & $await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $recognized = & $await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = @()
  foreach ($line in $recognized.Lines) {
    if ($lines.Count -ge $limit) { break }
    $left = [double]::MaxValue; $top = [double]::MaxValue; $right = 0.0; $bottom = 0.0
    foreach ($word in $line.Words) {
      $r = $word.BoundingRect
      $left = [Math]::Min($left, $r.X); $top = [Math]::Min($top, $r.Y)
      $right = [Math]::Max($right, $r.X + $r.Width); $bottom = [Math]::Max($bottom, $r.Y + $r.Height)
    }
    if ($right -le 0) { continue }
    $lines += @{ text=$line.Text; frame=@([int]$left, [int]$top, [int]($right - $left), [int]($bottom - $top)); center=@([int](($left + $right) / 2), [int](($top + $bottom) / 2)) }
  }
  return ,$lines
}
# The role of an element, without the ControlType. prefix. Legacy WinForms
# and Win32 controls come through as bare panes: their window class still says
# what they are.
function RoleOf($info) {
  $role = $info.ControlType.ProgrammaticName -replace '^ControlType\.', ''
  if ($role -eq 'Pane' -and $info.ClassName) {
    $class = [string]$info.ClassName
    if ($class -match '(^|\.)(EDIT|RichEdit\w*)(\.|$)') { return 'Edit' }
    if ($class -match '(^|\.)BUTTON(\.|$)') { return 'Button' }
    if ($class -match '(^|\.)STATIC(\.|$)') { return 'Text' }
    if ($class -match '(^|\.)(LISTBOX|SysListView32)(\.|$)') { return 'List' }
    if ($class -match '(^|\.)COMBOBOX(\.|$)') { return 'ComboBox' }
    if ($class -match '(^|\.)SysTreeView32(\.|$)') { return 'Tree' }
  }
  return $role
}
# The foreground window's controls through UI Automation, breadth first under
# a time budget, with frames converted to the pixels of the captured image.
function UiTree($handle, $shot, $limit) {
  Ui
  $A = [System.Windows.Automation.AutomationElement]
  $valueProperty = [System.Windows.Automation.ValuePattern]::ValueProperty
  $request = New-Object System.Windows.Automation.CacheRequest
  foreach ($p in @($A::NameProperty, $A::ControlTypeProperty, $A::BoundingRectangleProperty, $A::IsEnabledProperty, $A::IsOffscreenProperty, $A::AutomationIdProperty, $A::HasKeyboardFocusProperty, $A::IsPasswordProperty, $A::ClassNameProperty, $A::NativeWindowHandleProperty, $valueProperty)) { $request.Add($p) }
  $request.TreeFilter = [System.Windows.Automation.Automation]::ControlViewCondition
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $cap = $shot.capture
  $scaleX = [double]$cap.width / [double]$shot.image_width
  $scaleY = [double]$cap.height / [double]$shot.image_height
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $elements = @()
  $queue = New-Object System.Collections.Queue
  $activation = $request.Activate()
  try {
    $queue.Enqueue(@($A::FromHandle($handle).GetUpdatedCache($request), 0))
    $visited = 0
    while ($queue.Count -gt 0 -and $elements.Count -lt $limit -and $visited -lt 5000 -and $clock.ElapsedMilliseconds -lt 2500) {
      $item = $queue.Dequeue()
      $element = $item[0]; $depth = [int]$item[1]
      $visited++
      $c = $element.Cached
      $r = $c.BoundingRectangle
      if (-not $c.IsOffscreen -and -not $r.IsEmpty -and $r.Width -ge 2 -and $r.Height -ge 2) {
        $role = RoleOf $c
        $name = [string]$c.Name
        $interactive = $role -match '^(Button|SplitButton|Edit|CheckBox|RadioButton|ComboBox|MenuItem|TabItem|ListItem|TreeItem|DataItem|Hyperlink|Slider|Spinner|HeaderItem|Document|List|Tree|Table)$'
        $left = [Math]::Max(0.0, ($r.X - $cap.x) / $scaleX)
        $top = [Math]::Max(0.0, ($r.Y - $cap.y) / $scaleY)
        $right = [Math]::Min([double]$shot.image_width, ($r.X + $r.Width - $cap.x) / $scaleX)
        $bottom = [Math]::Min([double]$shot.image_height, ($r.Y + $r.Height - $cap.y) / $scaleY)
        if (($name -or $interactive) -and $right - $left -ge 1 -and $bottom - $top -ge 1 -and $depth -gt 0) {
          if ($name.Length -gt 240) { $name = $name.Substring(0, 240) }
          $entry = @{ role=$role; label=$name; frame=@([int]$left, [int]$top, [int]($right - $left), [int]($bottom - $top)); center=@([int](($left + $right) / 2), [int](($top + $bottom) / 2)) }
          if ($c.AutomationId -and $c.AutomationId -notmatch '^\d+$') { $entry.id = [string]$c.AutomationId }
          if (-not $c.IsEnabled) { $entry.enabled = $false }
          if ($c.HasKeyboardFocus) { $entry.focused = $true }
          if ($c.IsPassword -or ($role -eq 'Edit' -and [ZaalisInput]::IsPasswordEdit([IntPtr][int64]$c.NativeWindowHandle))) { $entry.password = $true }
          else {
            $value = $element.GetCachedPropertyValue($valueProperty)
            if ($value -is [string] -and $value -and $value -ne $name) { if ($value.Length -gt 300) { $value = $value.Substring(0, 300) }; $entry.value = $value }
          }
          $elements += $entry
        }
      }
      if ($depth -lt 40) {
        $child = $walker.GetFirstChild($element, $request)
        while ($null -ne $child) { $queue.Enqueue(@($child, ($depth + 1))); $child = $walker.GetNextSibling($child, $request) }
      }
    }
  } finally { $activation.Dispose() }
  return @{ application=(ActiveTitle); focusedWindow=(ActiveTitle); elements=$elements; truncated=($queue.Count -gt 0) }
}
function OpenWindows {
  $list = @()
  foreach ($p in @(Get-Process | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle })) {
    if ($list.Count -ge 25) { break }
    $list += @{ title=$p.MainWindowTitle; app=$p.ProcessName }
  }
  return ,$list
}
# The name of the control an action would trigger, when it is a button, menu
# entry or link whose label matches the pattern of irreversible actions.
function SensitiveName($element, $pattern) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  for ($i = 0; $i -lt 4 -and $null -ne $element; $i++) {
    $info = $element.Current
    $name = [string]$info.Name
    if ((RoleOf $info) -match '^(Button|SplitButton|MenuItem|Hyperlink)$' -and $name -and $name -match $pattern) { return $name }
    $element = $walker.GetParent($element)
  }
  return $null
}
function GuardPoint($x, $y) {
  if (-not $a.guard) { return }
  $name = $null
  try {
    Ui
    $point = New-Object System.Windows.Point -ArgumentList ([double]$x), ([double]$y)
    $name = SensitiveName ([System.Windows.Automation.AutomationElement]::FromPoint($point)) ([string]$a.guard)
  } catch {}
  if ($name) { Result @{ok=$false;error='sensitive-target';target=$name} }
}
function GuardFocus {
  if (-not $a.guard) { return }
  $name = $null
  try { Ui; $name = SensitiveName ([System.Windows.Automation.AutomationElement]::FocusedElement) ([string]$a.guard) } catch {}
  if ($name) { Result @{ok=$false;error='sensitive-target';target=$name} }
}
function ModifierKeys($names) {
  $keys = New-Object 'System.Collections.Generic.List[uint16]'
  foreach ($m in @($names)) {
    $vk = 0
    switch -regex ([string]$m) {
      '^(ctrl|control)$' { $vk = 0x11 }
      '^(alt|option|opt)$' { $vk = 0x12 }
      '^shift$' { $vk = 0x10 }
      '^(win|windows|cmd|command|meta|super)$' { $vk = 0x5B }
    }
    if ($vk -and -not $keys.Contains([uint16]$vk)) { $keys.Add([uint16]$vk) }
  }
  return ,$keys
}
function MouseFlags($button) {
  if ($button -eq 'right') { return @(0x08, 0x10) }
  if ($button -eq 'middle') { return @(0x20, 0x40) }
  return @(0x02, 0x04)
}
# Brings the top-level window of an application already open to the front.
function OpenWindowFor($name) {
  $key = ($name -replace '\.exe$', '').ToLower()
  $aliases = @{ edge='msedge'; calc='calculatorapp' }
  $process = $key
  if ($aliases.ContainsKey($key)) { $process = $aliases[$key] }
  $windows = @(Get-Process | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle })
  $match = $null
  if ($name -match '^[A-Za-z]:\\|^\\\\') { $match = $windows | Where-Object { $_.Path -eq $name } | Select-Object -First 1 }
  else {
    $match = $windows | Where-Object { $_.ProcessName -eq $process } | Select-Object -First 1
    if (-not $match -and $name.Length -ge 3) {
      $match = $windows | Where-Object { $t = $_.MainWindowTitle; $t -eq $name -or $t -like ('* - ' + $name) -or $t -like ($name + ' *') } | Select-Object -First 1
    }
  }
  return $match
}
function Plain($s) {
  $d = ([string]$s).Normalize([Text.NormalizationForm]::FormD)
  return (($d.ToCharArray() | Where-Object { [Globalization.CharUnicodeInfo]::GetUnicodeCategory($_) -ne [Globalization.UnicodeCategory]::NonSpacingMark }) -join '').ToLower().Trim()
}
# An application from the Start menu, by the name it shows there.
function StartApp($name) {
  $wanted = Plain $name
  $apps = @()
  try { $apps = @(Get-StartApps | ForEach-Object { @{ name=$_.Name; id=$_.AppID; link=$null } }) } catch {}
  if ($apps.Count -eq 0) {
    foreach ($dir in @((Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))) {
      if (Test-Path $dir) { $apps += @(Get-ChildItem -Path $dir -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object { @{ name=$_.BaseName; id=$null; link=$_.FullName } }) }
    }
  }
  $pick = $null
  foreach ($rule in @('exact', 'prefix', 'word')) {
    foreach ($app in $apps) {
      $n = Plain $app.name
      if (($rule -eq 'exact' -and $n -eq $wanted) -or ($rule -eq 'prefix' -and $n.StartsWith($wanted)) -or ($rule -eq 'word' -and (' ' + $n + ' ').Contains(' ' + $wanted + ' '))) { $pick = $app; break }
    }
    if ($pick) { break }
  }
  $suggestions = @()
  if (-not $pick) {
    $first = ($wanted -split '\s+')[0]
    if ($first.Length -ge 3) { $suggestions = @($apps | Where-Object { (Plain $_.name).Contains($first.Substring(0, 3)) } | Select-Object -First 8 | ForEach-Object { $_.name }) }
  }
  return @{ app=$pick; suggestions=$suggestions }
}
function WaitForeground($previous) {
  for ($i = 0; $i -lt 16; $i++) {
    Start-Sleep -Milliseconds 250
    $now = [ZaalisInput]::GetForegroundWindow()
    if ($now -ne $previous -and (ActiveTitle)) { return }
  }
}
if ($a.action -eq 'status' -or $a.action -eq 'request_permissions') { Result @{ok=$true; accessibility=$true; screenRecording=$true} }
if ($a.action -eq 'overlay_start' -or $a.action -eq 'overlay_stop') { Result @{ok=$true} }
if ($a.action -eq 'activate_app' -or $a.action -eq 'open_terminal') {
  $p = 'powershell.exe'
  $known = @{
    notepad = (Join-Path $env:WINDIR 'System32\notepad.exe')
    calc = (Join-Path $env:WINDIR 'System32\calc.exe')
    mspaint = (Join-Path $env:WINDIR 'System32\mspaint.exe')
    explorer = (Join-Path $env:WINDIR 'explorer.exe')
    cmd = (Join-Path $env:WINDIR 'System32\cmd.exe')
    powershell = (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe')
  }
  $isPath = $false
  $isKnown = $false
  if ($a.action -eq 'activate_app') {
    $p = [string]$a.path
    $isPath = $p -match '^(?:[A-Za-z]:\\|\\\\).+\.(exe|cmd|bat)$'
    $isKnown = $p -match '^(?i:notepad|calc|mspaint|chrome|edge|msedge|firefox|code|explorer|cmd|powershell)(\.exe)?$'
    if (-not $isPath -and -not $isKnown -and $p -notmatch '^[\p{L}\p{N}][\p{L}\p{N} ._+&''()-]{0,79}$') { Result @{ok=$false;error='invalid-application'} }
    # System administration tools stay out of reach of the agent.
    if ($p -match '(?i)regedit|registre|registry|diskpart|diskmgmt|gpedit|secpol|bcdedit|\bmmc\b') { Result @{ok=$false;error='application-refused'} }
    $open = OpenWindowFor $p
    if ($open) {
      [void][ZaalisInput]::Focus($open.MainWindowHandle)
      Start-Sleep -Milliseconds 150
      Result @{ok=$true;activated=$true;application=(ActiveTitle)}
    }
  }
  $previous = [ZaalisInput]::GetForegroundWindow()
  if ($a.action -eq 'open_terminal' -or $isPath -or $isKnown) {
    # Windows 11 puts Store "app execution aliases" on PATH for several of these
    # names.  Those are reparse points Start-Process cannot launch ("le systeme ne
    # trouve pas toutes les informations requises"), so resolve the well-known
    # ones to their real binary before launching.
    $key = ($p -replace '\.exe$','').ToLower()
    if ($known.ContainsKey($key) -and (Test-Path $known[$key])) { $p = $known[$key] }
    try { Start-Process -FilePath $p }
    catch { Start-Process -FilePath (Join-Path $env:WINDIR 'System32\cmd.exe') -ArgumentList @('/c','start','',$p) -WindowStyle Hidden }
    $resolved = $p
  } else {
    $found = StartApp $p
    if (-not $found.app) { Result @{ok=$false;error='application-not-found';suggestions=$found.suggestions} }
    if ($found.app.id) { Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') -ArgumentList ('shell:AppsFolder\' + $found.app.id) }
    else { Start-Process -FilePath $found.app.link }
    $resolved = $found.app.name
  }
  WaitForeground $previous
  Result @{ok=$true;launched=$true;resolved=$resolved;application=(ActiveTitle)}
}
if ($a.action -eq 'move') {
  [void][ZaalisInput]::SetCursorPos([int]$a.x,[int]$a.y)
  Result @{ok=$true}
}
if ($a.action -eq 'click' -or $a.action -eq 'double_click') {
  GuardPoint $a.x $a.y
  $flags = MouseFlags ([string]$a.button)
  $mods = (ModifierKeys $a.modifiers).ToArray()
  [void][ZaalisInput]::SetCursorPos([int]$a.x,[int]$a.y)
  Start-Sleep -Milliseconds 40
  [ZaalisInput]::Press($mods, $false)
  $count = 1
  if ($a.action -eq 'double_click') { $count = 2 }
  for ($i = 0; $i -lt $count; $i++) {
    if ($i -gt 0) { Start-Sleep -Milliseconds 70 }
    [ZaalisInput]::mouse_event($flags[0],0,0,0,[UIntPtr]::Zero)
    [ZaalisInput]::mouse_event($flags[1],0,0,0,[UIntPtr]::Zero)
  }
  [ZaalisInput]::Press($mods, $true)
  Result @{ok=$true}
}
if ($a.action -eq 'drag') {
  $steps = 16
  $pause = 25
  if ($a.duration) { $pause = [Math]::Max(5, [int]([double]$a.duration * 1000 / $steps)) }
  [void][ZaalisInput]::SetCursorPos([int]$a.x,[int]$a.y)
  Start-Sleep -Milliseconds 60
  [ZaalisInput]::mouse_event(0x02,0,0,0,[UIntPtr]::Zero)
  for ($i = 1; $i -le $steps; $i++) {
    Start-Sleep -Milliseconds $pause
    [void][ZaalisInput]::SetCursorPos([int]([double]$a.x + ([double]$a.to_x - [double]$a.x) * $i / $steps), [int]([double]$a.y + ([double]$a.to_y - [double]$a.y) * $i / $steps))
  }
  Start-Sleep -Milliseconds 60
  [ZaalisInput]::mouse_event(0x04,0,0,0,[UIntPtr]::Zero)
  Result @{ok=$true}
}
if ($a.action -eq 'scroll') {
  if ($null -ne $a.x -and $null -ne $a.y) { [void][ZaalisInput]::SetCursorPos([int]$a.x,[int]$a.y); Start-Sleep -Milliseconds 40 }
  # dy > 0 goes down the page, dx > 0 to the right: the wheel's own sign is
  # the opposite for vertical scrolling.
  if ([int]$a.dy -ne 0) { [ZaalisInput]::Wheel((0 - [int]$a.dy), $false) }
  if ([int]$a.dx -ne 0) { [ZaalisInput]::Wheel([int]$a.dx, $true) }
  Result @{ok=$true}
}
if ($a.action -eq 'type') {
  # Never type into a password field, whatever the text.
  $secret = [ZaalisInput]::FocusIsPasswordEdit()
  if (-not $secret) { try { Ui; $focused = [System.Windows.Automation.AutomationElement]::FocusedElement; $secret = ($null -ne $focused -and $focused.Current.IsPassword) } catch {} }
  if ($secret) { Result @{ok=$false;error='password-field'} }
  $typed = [ZaalisInput]::TypeText([string]$a.text)
  Result @{ok=$true;typed=$typed}
}
if ($a.action -eq 'key') {
  $k = ([string]$a.key).ToLower()
  $named = @{ enter=0x0D; return=0x0D; tab=0x09; escape=0x1B; esc=0x1B; backspace=0x08; delete=0x2E; del=0x2E; insert=0x2D; up=0x26; down=0x28; left=0x25; right=0x27; home=0x24; end=0x23; pageup=0x21; pagedown=0x22; space=0x20; printscreen=0x2C; capslock=0x14; menu=0x5D; apps=0x5D; win=0x5B; windows=0x5B }
  $mods = ModifierKeys $a.modifiers
  $vk = 0
  if ($named.ContainsKey($k)) { $vk = $named[$k] }
  elseif ($k -match '^f([1-9]|1[0-9]|2[0-4])$') { $vk = 0x6F + [int]$Matches[1] }
  elseif ($k.Length -eq 1) {
    $scan = [int][ZaalisInput]::VkKeyScanW([char]$k)
    if ($scan -eq -1) {
      # Not on this keyboard layout: the character itself is sent instead.
      if ($mods.Count -gt 0) { Result @{ok=$false;error='unknown-key'} }
      [void][ZaalisInput]::TypeText($k)
      Result @{ok=$true}
    }
    $vk = $scan -band 0xFF
    $state = ($scan -shr 8) -band 0xFF
    if (($state -band 1) -and -not $mods.Contains([uint16]0x10)) { $mods.Add([uint16]0x10) }
    if (($state -band 2) -and -not $mods.Contains([uint16]0x11)) { $mods.Add([uint16]0x11) }
    if (($state -band 4) -and -not $mods.Contains([uint16]0x12)) { $mods.Add([uint16]0x12) }
  }
  else { Result @{ok=$false;error='unknown-key'} }
  if ($vk -eq 0x0D -or $vk -eq 0x20) { GuardFocus }
  $repeat = 1
  if ($a.repeat) { $repeat = [Math]::Max(1, [Math]::Min(30, [int]$a.repeat)) }
  [ZaalisInput]::Chord($mods.ToArray(), [uint16]$vk, $repeat)
  Result @{ok=$true}
}
if ($a.action -eq 'observe' -or $a.action -eq 'inspect') {
  $target = 'active_window'
  if ($a.action -eq 'observe') { $target = 'display' }
  elseif ($a.target) { $target = [string]$a.target }
  $displays = Displays
  $handle = [ZaalisInput]::GetForegroundWindow()
  if ($target -eq 'region') { $bounds = @{x=[int]$a.x;y=[int]$a.y;width=[int]$a.width;height=[int]$a.height} }
  elseif ($target -eq 'display') {
    $bounds = VirtualBounds
    if ($null -ne $a.display_index -and [int]$a.display_index -lt $displays.Count) { $bounds = $displays[[int]$a.display_index] }
  }
  else { $bounds = WindowBounds }
  $maxDim = 1600
  if ($a.max_dimension) { $maxDim = [int]$a.max_dimension }
  $shot = Capture $bounds $maxDim
  $stream = New-Object IO.MemoryStream
  $shot.bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
  $png = $stream.ToArray()
  $signature = [ZaalisInput]::Signature($shot.bitmap)
  $shot.bitmap.Dispose()
  $title = ActiveTitle
  $out = @{ok=$true;mime='image/png';target=$target;capture=$shot.capture;image_width=$shot.image_width;image_height=$shot.image_height;application=$title;displays=$displays;signature=$signature}
  if ($a.include_image -ne $false) { $out.image = [Convert]::ToBase64String($png) }
  if ($a.action -eq 'inspect') {
    $out.ocr = @()
    $out.ui = @{application=$title;focusedWindow=$title;elements=@();truncated=$false}
    if ($a.include_ocr -ne $false) { try { $out.ocr = Ocr $png 100 } catch { $out.ocrError = $_.Exception.Message } }
    if ($a.include_ui -ne $false -and $handle -ne [IntPtr]::Zero) {
      $limit = 220
      if ($a.max_elements) { $limit = [int]$a.max_elements }
      try { $out.ui = UiTree $handle $shot $limit } catch { $out.uiError = $_.Exception.Message }
    }
    try { $out.open_windows = OpenWindows } catch {}
  }
  Result $out
}
if ($a.action -eq 'menus') {
  Ui
  $A = [System.Windows.Automation.AutomationElement]
  $C = [System.Windows.Automation.ControlType]
  $root = $A::FromHandle([ZaalisInput]::GetForegroundWindow())
  $menus = @()
  $bars = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition -ArgumentList $A::ControlTypeProperty, $C::MenuBar))
  foreach ($bar in $bars) {
    foreach ($item in $bar.FindAll([System.Windows.Automation.TreeScope]::Children, (New-Object System.Windows.Automation.PropertyCondition -ArgumentList $A::ControlTypeProperty, $C::MenuItem))) {
      if ($item.Current.Name) { $menus += [string]$item.Current.Name }
    }
  }
  Result @{ok=$true;application=(ActiveTitle);menus=$menus}
}
Result @{ok=$false;error='unsupported-action'}
`;

let bridgeFile = null;

// The bridge is longer than a Windows command line allows (32 767
// characters), so it runs from a file in the user's temp folder, named after
// its content: every run of the same version shares it and nothing piles up.
// UTF-8 with a BOM: without it PowerShell 5.1 reads the file in the ANSI code
// page and mangles every accent. The content is checked before each run and
// rewritten (atomically, for a second server running at the same time) if
// anything changed it.
function bridgeScriptFile() {
  const content = '\uFEFF' + BRIDGE_SCRIPT;
  if (!bridgeFile) {
    const hash = crypto.createHash('sha256').update(BRIDGE_SCRIPT).digest('hex').slice(0, 16);
    bridgeFile = path.join(os.tmpdir(), `zaalis-computer-${hash}.ps1`);
  }
  let current = null;
  try { current = fs.readFileSync(bridgeFile, 'utf8'); } catch {}
  if (current !== content) {
    const partial = `${bridgeFile}.${process.pid}.tmp`;
    fs.writeFileSync(partial, content, 'utf8');
    fs.renameSync(partial, bridgeFile);
  }
  return bridgeFile;
}

function call(action, overlayConfig) {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, error: 'unsupported-platform' });
  if (action && action.action === 'overlay_start') return Promise.resolve(startOverlay(overlayConfig || {}));
  if (action && action.action === 'overlay_stop') { stopOverlay(); return Promise.resolve({ ok: true }); }
  const payload = Buffer.from(JSON.stringify(action || {}), 'utf8').toString('base64');
  let file;
  try { file = bridgeScriptFile(); } catch (error) { return Promise.resolve({ ok: false, error: `windows-computer-script: ${error.message}` }); }
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', file], {
      env: { ...process.env, ZAALIS_COMPUTER_ACTION: payload },
      timeout: 25000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
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
