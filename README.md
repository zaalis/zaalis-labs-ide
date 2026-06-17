# zaalis labs IDE

Local IDE by zaalis labs with a web interface, local Node.js server, and native Windows application powered by WebView2.

## Launch with the Windows installer

Download and run:

[zaalis-setup.exe](https://github.com/zaalis/zaalis-labs-ide/raw/main/native/installer/zaalis-setup.exe)

The installer adds the application to Windows and creates launch shortcuts.

## Launch manually

Prerequisite: Node.js.

```bash
npm install
npm start
```

Then open:

```text
http://localhost:3000
```

## Rebuild the Windows application

Prerequisites:

- Node.js
- Visual Studio with the Desktop C++ workload
- Inno Setup 6

```bat
native\build_server.bat
native\build_shell.bat
native\build_installer.bat
```

The generated installer can be found here:

```text
native\installer\zaalis-setup.exe
```
