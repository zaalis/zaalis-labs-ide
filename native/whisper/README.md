# Local dictation

`sh native/build_whisper.sh` builds whisper.cpp v1.9.4 from the pinned upstream tag.
Linux ships an x64 CPU binary. macOS ships a universal arm64/x86_64 binary with Metal.
The packaged executable is `bundle/whisper/whisper-cli`.
The multilingual model is downloaded once into the user's voice data directory
and checked by SHA-256 in voice-stt.js. Audio is processed locally.
Build prerequisites: curl, tar, CMake, C/C++ compiler; Xcode tools on macOS.
