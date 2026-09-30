# whisper.cpp — local speech-to-text engine

The dictation button and the browser's voice search transcribe with
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT, see `LICENSE`),
entirely on this PC. `voice-stt.js` runs `whisper-cli.exe`; the installer copies
this folder to `{app}\whisper`.

## What is here

| Files | Origin |
|---|---|
| `whisper-cli.exe`, `whisper.dll`, `ggml.dll`, `ggml-base.dll`, `ggml-cpu-*.dll` | `whisper-bin-x64.zip` of release **v1.9.4** (build tag `b5130`), sha256 `f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c` |
| `msvcp140.dll`, `vcruntime140.dll`, `vcruntime140_1.dll`, `vcomp140.dll` | Visual C++ redistributable 14.50 (x64), app-local so the engine starts on a PC that has no VC++ runtime installed |

The CPU build is used on purpose: the CUDA build weighs 640 MB. `ggml-cpu-*.dll`
are the same backend compiled for different processors; the engine picks one at
start, so all of them stay.

Only the files `whisper-cli.exe` needs were kept from the archive (no SDL2, no
other tools).

## The model is not here

The model, `ggml-small-q5_1.bin` (181 MB), is downloaded once into the data
folder (`%LOCALAPPDATA%\zaalis\server-data\voice`) from the official repository
`huggingface.co/ggerganov/whisper.cpp`, and checked against its sha256 before
use. It is too large for the repository and for the installer. Until it is
there, dictation falls back to Windows' own recognizer.

## Updating

Download `whisper-bin-x64.zip` from a newer release, check its sha256 against
the one GitHub publishes for the asset, replace the files of the first row, and
update this table. Then run `node --test test/voice-stt.test.js` and
`node test/package-smoke.js` after a build.
