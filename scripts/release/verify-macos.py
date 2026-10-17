#!/usr/bin/env python3
"""Verify both built DMGs and record their payloads without account data."""
import hashlib
import json
import plistlib
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def digest(file):
    hasher = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(chunk)
    return hasher.hexdigest()


def verify(arch):
    dmg = ROOT / 'native/installer' / f'zaalis-macos-{arch}.dmg'
    run('hdiutil', 'verify', str(dmg))
    cpu = 'x86_64' if arch == 'x64' else 'arm64'
    with tempfile.TemporaryDirectory(prefix='zaalis-verify-') as directory:
        run('hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', directory, str(dmg))
        try:
            mount = Path(directory)
            app = mount / '.payload/zaalis IDE.app'
            setup = mount / 'Installer zaalis IDE.app'
            run('codesign', '--verify', '--deep', '--strict', str(setup))
            run('lipo', str(setup / 'Contents/MacOS/zaalis-setup'), '-verify_arch', cpu)
            assert (mount / '.DS_Store').is_file(), 'Installer Finder layout missing'
            assert digest(mount / '.DS_Store') == digest(ROOT / 'native/installer-macos/Finder.DS_Store'), 'Outdated Finder layout'
            run('codesign', '--verify', '--deep', '--strict', str(app))
            with (app / 'Contents/Info.plist').open('rb') as stream:
                info = plistlib.load(stream)
            assert info['CFBundleIdentifier'] == 'fr.zaalis.ide'
            original = ROOT / f'native/dist-macos-{arch}/zaalis IDE.app'
            for relative in ['Contents/Info.plist', 'Contents/MacOS/zaalis-ide', 'Contents/_CodeSignature/CodeResources']:
                assert digest(app / relative) == digest(original / relative), f'Application changed: {relative}'
            with (setup / 'Contents/Info.plist').open('rb') as stream:
                setup_info = plistlib.load(stream)
            assert setup_info['ZaalisVolumeToken'] == (mount / '.zaalis-install-id').read_text().strip()
            assert setup_info['ZaalisPayloadSeal'] == digest(app / 'Contents/_CodeSignature/CodeResources')
            assert setup_info['ZaalisPayloadCode'] == digest(app / 'Contents/MacOS/zaalis-ide')
            resources = app / 'Contents/Resources/app'
            bundle = resources / 'bundle'
            payloads = [app / 'Contents/MacOS/zaalis-ide',
                        app / 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
                        resources / 'macos-computer-bridge', resources / 'macos-speech-transcriber']
            payloads += [bundle / name for name in [
                'zaalis-server', 'zaalis-agentd', 'zaalis-sandbox', 'bin/zaalis', 'bin/zaalis-cli',
                'messenger-runtime/node', 'github/gh', 'cloudflared', 'whisper/whisper-cli',
                'node_modules/node-pty/build/Release/pty.node',
                'node_modules/node-pty/build/Release/spawn-helper']]
            architectures = {}
            for binary in payloads:
                run('lipo', str(binary), '-verify_arch', cpu)
                architectures[str(binary.relative_to(app))] = run('lipo', '-archs', str(binary))
            assets = list((ROOT / 'interface').rglob('*'))
            checked = 0
            for source in assets:
                if source.is_file():
                    relative = source.relative_to(ROOT / 'interface')
                    assert digest(source) == digest(bundle / 'interface' / relative), f'UI differs: {relative}'
                    checked += 1
            assert (bundle / 'native/blender/mcp-1.0.3.zip').stat().st_size > 0
            return {'architecture': arch, 'version': info['CFBundleShortVersionString'],
                    'dmg': dmg.name, 'bytes': dmg.stat().st_size, 'sha256': digest(dmg),
                    'signatureVerified': True, 'verifiedInterfaceFiles': checked,
                    'installerSignatureVerified': True, 'applicationPayloadUnchanged': True,
                    'payloadArchitectures': architectures}
        finally:
            run('hdiutil', 'detach', directory)


if __name__ == '__main__':
    report = {'sourceCommit': run('git', '-C', str(ROOT), 'rev-parse', 'HEAD'),
              'upstreamCommit': run('git', '-C', str(ROOT), 'rev-parse', 'origin/main'),
              'artifacts': [verify(arch) for arch in ['arm64', 'x64']]}
    output = ROOT / 'native/installer/validation-macos.json'
    output.write_text(json.dumps(report, indent=2) + '\n')
    print(f'Both DMGs verified: {output}')
