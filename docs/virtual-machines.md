# Virtual machines in the Windows IDE

The right sidebar opens distinct VM sessions. Linux has a real SSH/PT​Y terminal with xterm. Windows Sandbox provides a persistent PowerShell console for navigation and commands, without full-screen editors, program-level interactive input, or Ctrl+C interruption of an already running command. Stop closes the whole Sandbox.

The native `vm` tool offers `list`, `create`, `status`, `import_project`, `exec`, `export_file`, `reset`, and `stop` without desktop clicks. Owned-VM actions are autonomous even when host desktop actions require supervision. Plan mode still prohibits mutations; the VM permission does not grant host commands or Windows feature activation.

## Use

1. Select Debian Linux or Windows Sandbox and start a VM. Up to three Linux VMs and one Sandbox can run at once.
2. Wait for Ready, then use the terminal or ask the agent to work in the VM.
3. Copy project imports a copy of the active project, excluding `.env`, common keys and credential directories, `.git`, `node_modules`, `target`, and symlinks. The transfer is limited to 256 MiB and 12,000 files.
4. The guest workspace is `/home/zaalis/workspace` on Linux or `C:\workspace` on Windows. Linux agent `exec` calls use separate shells; include `cd /home/zaalis/workspace && ...` as needed.
5. Export file returns a download link for a guest file up to 32 MiB. Guest results are never applied automatically to the local project.
6. Reset stops the session and starts a clean environment. Old overlays remain in local data; this version does not automatically delete them or restore snapshots.

Networking is disabled by default. Internet + host network also allows local-network access; it is not an internet-only filter. Agent commands have a two-minute limit and bounded output. Stopping a VM interrupts guest processes. Windows Sandbox uses `wsb`, a read-only shared input directory, and a separate writable result directory because the API does not provide stdout/stderr. A guest watchdog stops the Sandbox after 30 seconds without an IDE heartbeat. The IDE does not adopt or stop a Sandbox started elsewhere.

## Preparation and distribution

The installer bundles QEMU x86-64, libraries, firmware, and an official Debian 12 genericcloud image. Guest disks are 24 GiB qcow2 overlays over an unchanged base. Each VM gets an SSH key; password login is disabled and the host SSH port binds to loopback. On a new Windows x64 machine, Windows Hypervisor Platform, OpenSSH Client, and hardware virtualization may need enabling. Settings check Sandbox edition, component state, and `wsb` separately. UAC activation may require a restart; the IDE does not force one.

```powershell
# Run only on the build machine, not on end-user computers.
powershell -File scripts/prepare-vm-assets.ps1 -Download
npm run build:server
npm run build:rust
cmd /c native\build_shell.bat
cmd /c native\build_installer.bat
```

QEMU license files are redistributed; Debian licenses remain under `/usr/share/doc`. Provenance and SHA-512 values are recorded in `vm/provenance.json`. Preparation binaries are ignored by Git.

## Repeatable validation

```powershell
npm test
cargo test --manifest-path rust/Cargo.toml -p zaalis-guard -p zaalis-extensions
node scripts/vm-smoke.js linux windows
node scripts/vm-mistral-smoke.js --fixture
node scripts/vm-mistral-smoke.js
```

The fixture uses the real Rust engine and a real Sandbox with a scripted provider. It proves import, C# compilation, and result retrieval without host permission; it does not measure model skill. The last command calls Mistral Small with an already configured key. An HTTP 429 response does not validate model behavior.
