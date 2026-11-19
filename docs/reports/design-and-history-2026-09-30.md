# Design and history report — September 30, 2026

API key and MCP settings gained spacing, rounded cards, separators, and readable text. Folder icons remained; chat icons were removed. The conversation menu gained confirmed deletion, including memory cleanup for an active chat. Running work must stop before a chat is removed.

The QR animation shows a drawing of the Z and then a complete code, with a temporary pointer trail. Reduced-motion settings are respected. Tool blocks retain HTML formatting after saving and reopening; older plain-text blocks are collapsed because their original layout cannot be reconstructed fully.

Project restoration happens before chat loading. The Rust session checks its project folder when resuming, and `workspace` can list and open known projects. A chat without a project uses its own workspace rather than the installation directory.

Historical validation: 37 Node tests passed; 25 Rust tests passed and 7 network tests were skipped. The packaged Windows server was checked for project selection, terminal working directory, session replacement, and resumption. Visual checks covered settings, menus, chat reloading, QR animation, and a 375 px viewport. The QR used a test URL without a public tunnel. The server, Rust binaries, interface, and installer were rebuilt. Packaging reported nonfatal missing Electron references in the bundled browser.
