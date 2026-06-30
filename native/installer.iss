; =====================================================================
;  Installateur zaalis IDE (Inno Setup)
;  - Installe l'app dans %LOCALAPPDATA%\Programs\zaalis (sans admin)
;  - Cree un raccourci Bureau + Menu Demarrer (chemin absolu de l'exe)
;  - Cree un desinstalleur
; =====================================================================
[Setup]
AppName=zaalis IDE
AppVersion=v1.0.13
AppVerName=zaalis IDE v1.0.13
VersionInfoVersion=1.0.13
VersionInfoProductVersion=1.0.13
AppPublisher=zaalis
DefaultDirName={localappdata}\Programs\zaalis
DefaultGroupName=zaalis IDE
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
OutputDir=installer
OutputBaseFilename=zaalis-setup
SetupIconFile=app.ico
UninstallDisplayIcon={app}\zaalis.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
WizardImageFile=wizard-image.bmp
WizardSmallImageFile=wizard-small.bmp
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Le CLI ajoute {app}\bin au PATH utilisateur : prevenir les processus en cours.
ChangesEnvironment=yes

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"

[Files]
Source: "dist\zaalis.exe";        DestDir: "{app}"; Flags: ignoreversion
Source: "dist\zaalis-server.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\pickfolder.exe";    DestDir: "{app}"; Flags: ignoreversion
Source: "dist\cloudflared.exe";   DestDir: "{app}"; Flags: ignoreversion
Source: "dist\interface\*";       DestDir: "{app}\interface"; Flags: ignoreversion recursesubdirs createallsubdirs
; CLI : depose dans {app}\bin et renomme zaalis.exe -> commande `zaalis` dans le terminal.
; (La GUI {app}\zaalis.exe n'est PAS sur le PATH ; seul {app}\bin l'est.)
Source: "dist\zaalis-cli.exe";    DestDir: "{app}\bin"; DestName: "zaalis.exe"; Flags: ignoreversion

[Icons]
; Desktop shortcut — the .lnk stores the absolute path of the exe,
; so it launches the app wherever the shortcut itself is moved.
Name: "{userdesktop}\zaalis IDE";              Filename: "{app}\zaalis.exe"; WorkingDir: "{app}"
Name: "{group}\zaalis IDE";                    Filename: "{app}\zaalis.exe"; WorkingDir: "{app}"
Name: "{group}\Desinstaller zaalis IDE";       Filename: "{uninstallexe}"

[Run]
; Lancement manuel (installation interactive) — case a cocher en fin d'assistant.
; En mise a jour silencieuse, c'est le script de l'app (bat) qui relance l'IDE.
Filename: "{app}\zaalis.exe"; Description: "Lancer zaalis IDE"; Flags: nowait postinstall skipifsilent

[Registry]
; Ajoute {app}\bin au PATH utilisateur (HKCU, sans admin) pour la commande `zaalis`.
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; \
  ValueData: "{olddata};{app}\bin"; Flags: preservestringtype; Check: NeedsAddPath(ExpandConstant('{app}\bin'))

[Code]
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
