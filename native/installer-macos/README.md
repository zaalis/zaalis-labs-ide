# Native macOS setup assistant

`main.swift` implements the dark/violet Windows installer design with AppKit:
welcome, destination/options, installation progress and completion. It installs
into `/Applications` or the current account's `Applications`, preserves existing
account data, and opens the installed app only when selected on the final page.
The optional Terminal command uses the account's `.local/bin` and adds a guarded
entry to `.zprofile`; existing unrelated commands are preserved.

`background.png` is the existing Windows `wizard-background.png` from `main`.
`Finder.DS_Store` is a generated, path-independent Finder icon-view template
(720 × 460 points, 128-point centered installer icon, dark background). It was
generated with `ds-store` 1.3.3; this package is not required during builds.

Build a preview assistant without compiling or installing the IDE:

```sh
sh native/build_macos_setup.sh "$PWD" x64 "/tmp/Installer zaalis IDE.app"
"/tmp/Installer zaalis IDE.app/Contents/MacOS/zaalis-setup" --self-test
"/tmp/Installer zaalis IDE.app/Contents/MacOS/zaalis-setup" --preview /tmp/setup.png 0
```

Preview pages are 0 (welcome), 1 (destination), 2 (progress), 3 (finished).
`--verify-install <signed-source.app> <temporary-Applications-directory>` tests
the installation engine without launching the app or configuring Terminal.
Use a disposable destination when running this integration check.

`native/make_dmg.sh` packages the assistant and the existing signed IDE. The
hidden `.payload/zaalis IDE.app` remains discoverable by the current updater's
two-level search. A per-image token locates that payload even if
[Gatekeeper launches the assistant from an isolated location](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution).
The assistant binds the payload's executable and resource seal to hashes in its
signed Info.plist, verifies both signatures, copies to a staging directory on
the destination filesystem, and only then swaps the installation into place.
Failure during the final swap restores the previous app. The installer never
clears quarantine or re-signs the application payload.

Rebuild both DMGs with `native/make_dmg.sh`, then run
`python3 scripts/release/verify-macos.py` to check their mounted contents.
