# Custom macOS installer — 2026-10-17

This change replaces the plain drag-to-Applications DMG with a native AppKit installation assistant matching the Windows setup design: near-black dotted background, violet accent, the same sidebar message and welcome/install/finish sequence. macOS receives native window controls, destination selection (system or personal Applications), an indeterminate installation progress bar and an optional launch checkbox. The optional Terminal command is explicitly selected by the user.

Only the installer was compiled. Both signed IDE applications from `ad419c1bb2667150319d975ecd2a5e2864ad99a0` were reused without modification. Installer source: `42939a8`.

## Validation

- All four visual pages were rendered and inspected. Captures: [welcome](assets/macos-installer-2026-10-17/welcome.png), [destination](assets/macos-installer-2026-10-17/ready.png), [completion](assets/macos-installer-2026-10-17/completed.png).
- Swift checks passed: first installation, replacement, preservation on invalid copy, rollback after a failed swap, staging cleanup, protection of an unrelated application, idempotent Terminal configuration, protection of an existing command, and correct image lookup from an isolated launch location.
- The actual Intel installer inside the mounted final DMG passed its own checks, copied the signed IDE into a disposable Applications directory, and verified the installed copy. The user's installed applications and shell settings were not changed by these tests.
- The four existing macOS updater tests passed. `.payload/zaalis IDE.app` remains at depth two in the DMG, as expected by the existing updater.
- Both DMGs passed independent `hdiutil verify`, read-only mounting, strict signatures for the assistant and IDE, all target-architecture checks, payload/source signature-seal and executable hash comparisons, and comparison of all 151 interface files. Finder metadata matches the bundled template and opens an icon view centered on the assistant.

## Final DMGs

- `zaalis-macos-arm64.dmg`: 329194605 bytes, SHA-256 `defed8343e43a1e723517e7c33b23dd3c56f0174aae3068dafdc46e4349d32ce`.
- `zaalis-macos-x64.dmg`: 346240639 bytes, SHA-256 `68c8ac80a0fe3edcd5fc1634267282fdba457202e55a89d93deac52e388cc6ef`.

The application payload and installer use local ad-hoc signatures, not notarization. Apple Silicon execution remains untested on this Intel host; its compiled wizard, application, signatures, metadata and architecture were checked statically.

[Machine-readable validation](macos-custom-installer-validation-2026-10-17.json). Rebuild instructions are in [README_MACOS.md](../../README_MACOS.md) and [the installer notes](../../native/installer-macos/README.md).
