; =====================================================================
;  Installateur zaalis IDE (Inno Setup)
;  - Installe l'app dans %LOCALAPPDATA%\Programs\zaalis (sans admin)
;  - Cree un raccourci Bureau + Menu Demarrer (chemin absolu de l'exe)
;  - Cree un desinstalleur
; =====================================================================
[Setup]
AppName=zaalis IDE
AppVersion=v1.0.17
AppVerName=zaalis IDE v1.0.17
VersionInfoVersion=1.0.17
VersionInfoProductVersion=1.0.17
AppPublisher=zaalis
DefaultDirName={localappdata}\Programs\zaalis
DefaultGroupName=zaalis IDE
DisableProgramGroupPage=yes
ChangesEnvironment=yes
DisableDirPage=yes
DisableWelcomePage=no
PrivilegesRequired=lowest
OutputDir=installer
OutputBaseFilename=zaalis-setup
SetupIconFile=app.ico
UninstallDisplayIcon={app}\zaalis.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern dark hidebevels includetitlebar
WizardSizePercent=130,130
WizardBackColor=#09090b
WizardBackImageFile=wizard-background.png
WizardImageFile=wizard-image.png
WizardImageBackColor=#09090b
WizardSmallImageFile=wizard-small.png
WizardSmallImageBackColor=#09090b
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Le CLI ajoute {app}\bin au PATH utilisateur : prevenir les processus en cours.

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
french.WelcomeLabel1=Bienvenue dans zaalis IDE
french.WelcomeLabel2=Votre espace de création, de code et d'agents IA est prêt à prendre place sur ce PC.%n%nContinuez pour installer l'application et ses composants dans votre dossier utilisateur.
french.ClickNext=Cliquez sur Continuer pour poursuivre ou sur Annuler pour quitter l'installation.
french.WizardReady=Votre espace est prêt
french.ReadyLabel1=zaalis IDE peut maintenant être installé.
french.ReadyLabel2b=Les raccourcis seront créés sur le Bureau et dans le menu Démarrer. Cliquez sur Installer pour continuer.
french.WizardInstalling=Installation de zaalis IDE
french.InstallingLabel=Nous mettons en place votre espace de travail. Cela peut prendre quelques instants.
french.FinishedHeadingLabel=zaalis IDE est prêt
french.FinishedLabel=Installation terminée. Lancez zaalis IDE depuis le Bureau ou le menu Démarrer pour commencer.
french.ButtonNext=&Continuer >
english.WelcomeLabel1=Welcome to zaalis IDE
english.WelcomeLabel2=Install the tools you need to code and work with AI agents.%n%nContinue to install zaalis IDE and its components in your user folder.
english.ClickNext=Click Continue to proceed, or Cancel to exit Setup.
english.WizardReady=Ready to install
english.ReadyLabel1=zaalis IDE is ready to install.
english.ReadyLabel2b=Setup will create shortcuts on the desktop and Start menu. Click Install to continue.
english.WizardInstalling=Installing zaalis IDE
english.InstallingLabel=Setting up your workspace. This may take a moment.
english.FinishedHeadingLabel=zaalis IDE is ready
english.FinishedLabel=Installation is complete. Launch zaalis IDE from the desktop or Start menu.
english.ButtonNext=&Continue >

[CustomMessages]
french.LaunchIDE=Lancer zaalis IDE
english.LaunchIDE=Launch zaalis IDE
french.UninstallIDE=Desinstaller zaalis IDE
english.UninstallIDE=Uninstall zaalis IDE

[Files]
Source: "dist\zaalis.exe";        DestDir: "{app}"; Flags: ignoreversion
Source: "dist\zaalis-server.exe"; DestDir: "{app}"; Flags: ignoreversion
; Core Rust partage par Chat, Agents et le CLI.
Source: "dist\zaalis-agentd.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\pickfolder.exe";    DestDir: "{app}"; Flags: ignoreversion
Source: "dist\cloudflared.exe";   DestDir: "{app}"; Flags: ignoreversion
; node-pty : addon natif du terminal integre. Un .node ne peut pas vivre dans le
; snapshot pkg, il doit rester sur le disque a cote de zaalis-server.exe.
Source: "dist\node_modules\node-pty\*"; DestDir: "{app}\node_modules\node-pty"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "dist\interface\*";       DestDir: "{app}\interface"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "dist\github\*";          DestDir: "{app}\github"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "dist\messenger-runtime\*"; DestDir: "{app}\messenger-runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
; Integrated Linux guest and QEMU are ordinary files, not inside pkg's snapshot.
Source: "dist\vm\*"; DestDir: "{app}\vm"; Flags: ignoreversion recursesubdirs createallsubdirs
; whisper.cpp : moteur local de dictee vocale (le modele est telecharge a part,
; dans le dossier de donnees, a la premiere utilisation).
Source: "dist\whisper\*";         DestDir: "{app}\whisper"; Flags: ignoreversion recursesubdirs createallsubdirs
; Pont Blender Zaalis (GPL) : installe dans Blender
; seulement a la demande de l'utilisateur, depuis Reglages > MCP > Blender.
Source: "dist\blender\*";         DestDir: "{app}\blender"; Flags: ignoreversion recursesubdirs createallsubdirs
; CLI Rust : depose dans {app}\bin et renomme zaalis.exe -> commande `zaalis` dans le terminal.
; (La GUI {app}\zaalis.exe n'est PAS sur le PATH ; seul {app}\bin l'est.)
Source: "dist\zaalis-terminal.exe";    DestDir: "{app}\bin"; DestName: "zaalis.exe"; Flags: ignoreversion

[Icons]
; Desktop shortcut — the .lnk stores the absolute path of the exe,
; so it launches the app wherever the shortcut itself is moved.
Name: "{userdesktop}\zaalis IDE";              Filename: "{app}\zaalis.exe"; WorkingDir: "{app}"
Name: "{group}\zaalis IDE";                    Filename: "{app}\zaalis.exe"; WorkingDir: "{app}"
Name: "{group}\{cm:UninstallIDE}";       Filename: "{uninstallexe}"

[Run]
; Lancement manuel (installation interactive) — case a cocher en fin d'assistant.
; En mise a jour silencieuse, c'est le script de l'app (bat) qui relance l'IDE.
Filename: "{app}\zaalis.exe"; Description: "{cm:LaunchIDE}"; Flags: nowait postinstall skipifsilent

[Registry]
; Ajoute {app}\bin au PATH utilisateur (HKCU, sans admin) pour la commande `zaalis`.
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; \
  ValueData: "{olddata};{app}\bin"; Flags: preservestringtype; Check: NeedsAddPath(ExpandConstant('{app}\bin'))

[Code]
function SetFileAttributes(lpFileName: String; dwFileAttributes: Cardinal): Boolean;
  external 'SetFileAttributesW@kernel32.dll stdcall';

// A shortcut left read-only (e.g. a Desktop with the attribute applied
// recursively) makes IPersistFile::Save fail with 0x80070005 when Setup
// rewrites it. Clear the attribute and remove the old link first.
procedure ReleaseShortcut(const Path: String);
begin
  if FileExists(Path) then
  begin
    SetFileAttributes(Path, FILE_ATTRIBUTE_NORMAL);
    DeleteFile(Path);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
  begin
    ReleaseShortcut(ExpandConstant('{userdesktop}\zaalis IDE.lnk'));
    ReleaseShortcut(ExpandConstant('{group}\zaalis IDE.lnk'));
    ReleaseShortcut(ExpandConstant('{group}\{cm:UninstallIDE}.lnk'));
  end;
end;

function NeedsAddPath(Param: string): Boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then
  begin
    Result := True;
    exit;
  end;
  // Ne pas dupliquer si {app}\bin est deja present.
  Result := Pos(';' + Lowercase(Param) + ';', ';' + Lowercase(OrigPath) + ';') = 0;
end;

function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{cmd}'), '/C taskkill /F /T /IM zaalis.exe >NUL 2>NUL', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{cmd}'), '/C taskkill /F /T /IM zaalis-server.exe >NUL 2>NUL', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := True;
end;

// Retire {app}\bin du PATH utilisateur a la desinstallation.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  OrigPath, BinPath: string;
begin
  if CurUninstallStep = usUninstall then
  begin
    if RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then
    begin
      BinPath := ExpandConstant('{app}\bin');
      StringChangeEx(OrigPath, ';' + BinPath, '', True);
      StringChangeEx(OrigPath, BinPath + ';', '', True);
      StringChangeEx(OrigPath, BinPath, '', True);
      RegWriteStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath);
    end;
  end;
end;
