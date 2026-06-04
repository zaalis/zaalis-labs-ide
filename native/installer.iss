; =====================================================================
;  Installateur zaalis IDE (Inno Setup)
;  - Installe l'app dans %LOCALAPPDATA%\Programs\zaalis (sans admin)
;  - Cree un raccourci Bureau + Menu Demarrer (chemin absolu de l'exe)
;  - Cree un desinstalleur
; =====================================================================
[Setup]
AppName=zaalis IDE
AppVersion=1.0
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
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"

[Files]
Source: "dist\zaalis.exe";        DestDir: "{app}"; Flags: ignoreversion
Source: "dist\zaalis-server.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\pickfolder.exe";    DestDir: "{app}"; Flags: ignoreversion
Source: "dist\interface\*";       DestDir: "{app}\interface"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; Desktop shortcut — the .lnk stores the absolute path of the exe,
; so it launches the app wherever the shortcut itself is moved.
Name: "{userdesktop}\zaalis IDE";              Filename: "{app}\zaalis.exe"; WorkingDir: "{app}"
Name: "{group}\zaalis IDE";                    Filename: "{app}\zaalis.exe"; WorkingDir: "{app}"
Name: "{group}\Desinstaller zaalis IDE";       Filename: "{uninstallexe}"

[Run]
Filename: "{app}\zaalis.exe"; Description: "Lancer zaalis IDE"; Flags: nowait postinstall skipifsilent
