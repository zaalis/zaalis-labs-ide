'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ZAALIS_BUNDLE_ID = 'fr.zaalis.ide';

function shellQuote(value) {
  const text = String(value == null ? '' : value);
  if (text.includes('\0')) throw new Error('NUL byte in updater argument.');
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function validPid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 1 ? pid : 0;
}

function resolveMacosAppBundle(explicitPath, appDir) {
  const raw = String(explicitPath || '').trim()
    || (appDir ? path.resolve(appDir, '..', '..', '..', '..') : '');
  if (!raw || !raw.toLowerCase().endsWith('.app')) return null;

  let candidate;
  try { candidate = fs.realpathSync(raw); } catch { return null; }
  if (!candidate.toLowerCase().endsWith('.app')) return null;

  const plist = path.join(candidate, 'Contents', 'Info.plist');
  const macos = path.join(candidate, 'Contents', 'MacOS');
  try {
    if (!fs.statSync(candidate).isDirectory()) return null;
    if (!fs.statSync(plist).isFile()) return null;
    if (!fs.statSync(macos).isDirectory()) return null;
  } catch { return null; }
  return candidate;
}

function buildMacosUpdateScript(options) {
  const installerPath = path.resolve(String(options.installerPath || ''));
  const appBundlePath = path.resolve(String(options.appBundlePath || ''));
  const logPath = path.resolve(String(options.logPath || ''));
  const lastTagFile = path.resolve(String(options.lastTagFile || ''));
  const expectedVersion = String(options.expectedVersion || '');
  const expectedArch = options.expectedArch === 'arm64' ? 'arm64' : 'x86_64';
  const serverPid = validPid(options.serverPid);
  const shellPid = validPid(options.shellPid);

  if (!installerPath.toLowerCase().endsWith('.dmg')) throw new Error('Updater payload must be a DMG.');
  if (!appBundlePath.toLowerCase().endsWith('.app')) throw new Error('Updater target must be an app bundle.');

  return `#!/bin/sh
set -u

DMG=${shellQuote(installerPath)}
DEST_APP=${shellQuote(appBundlePath)}
LOG_FILE=${shellQuote(logPath)}
LAST_TAG_FILE=${shellQuote(lastTagFile)}
EXPECTED_VERSION=${shellQuote(expectedVersion)}
EXPECTED_ARCH=${shellQuote(expectedArch)}
SERVER_PID=${serverPid}
SHELL_PID=${shellPid}
RUNNER_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MOUNT_POINT="$RUNNER_DIR/mount"
STAGE_APP="$(dirname -- "$DEST_APP")/.zaalis-update-stage-$$.app"
BACKUP_APP="$(dirname -- "$DEST_APP")/.zaalis-update-backup-$$.app"
MOUNTED=0
REPLACED=0

mkdir -p "$(dirname -- "$LOG_FILE")"
exec >>"$LOG_FILE" 2>&1

log() { printf '[%s] %s\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }

detach_image() {
  if [ "$MOUNTED" -eq 1 ]; then
    /usr/bin/hdiutil detach "$MOUNT_POINT" -quiet || /usr/bin/hdiutil detach "$MOUNT_POINT" -force -quiet || true
    MOUNTED=0
  fi
}

restore_previous_app() {
  if [ "$REPLACED" -eq 1 ] && [ -d "$BACKUP_APP" ]; then
    FAILED_APP="$(dirname -- "$DEST_APP")/.zaalis-update-failed-$$.app"
    if [ -d "$DEST_APP" ]; then /bin/mv "$DEST_APP" "$FAILED_APP" || true; fi
    /bin/mv "$BACKUP_APP" "$DEST_APP" || true
    if [ -d "$FAILED_APP" ]; then /bin/rm -rf "$FAILED_APP"; fi
    REPLACED=0
  fi
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  detach_image
  if [ -d "$STAGE_APP" ]; then /bin/rm -rf "$STAGE_APP"; fi
  if [ "$REPLACED" -eq 0 ] && [ -d "$BACKUP_APP" ]; then /bin/rm -rf "$BACKUP_APP"; fi
  /bin/rm -f "$0"
  /bin/rmdir "$RUNNER_DIR" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

fallback() {
  log "Automatic update failed: $*"
  restore_previous_app
  detach_image
  if [ -d "$DEST_APP" ]; then /usr/bin/open "$DEST_APP" || true; fi
  /usr/bin/open "$DMG" || true
  exit 1
}

case "$DEST_APP" in
  /*.app) ;;
  *) fallback "invalid destination bundle path" ;;
esac

[ -f "$DMG" ] || fallback "downloaded DMG is missing"
[ -d "$DEST_APP" ] || fallback "installed application bundle is missing"

log "Verifying disk image"
/usr/bin/hdiutil verify "$DMG" || fallback "DMG verification failed"
/bin/mkdir -p "$MOUNT_POINT" || fallback "cannot create mount point"
/usr/bin/hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT_POINT" "$DMG" || fallback "cannot mount DMG"
MOUNTED=1

SOURCE_APP=$(/usr/bin/find "$MOUNT_POINT" -maxdepth 2 -type d -name 'zaalis IDE.app' -print -quit)
[ -n "$SOURCE_APP" ] && [ -d "$SOURCE_APP" ] || fallback "zaalis IDE.app is missing from DMG"

SOURCE_ID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$SOURCE_APP/Contents/Info.plist" 2>/dev/null || true)
[ "$SOURCE_ID" = ${shellQuote(ZAALIS_BUNDLE_ID)} ] || fallback "unexpected bundle identifier: $SOURCE_ID"

SOURCE_VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$SOURCE_APP/Contents/Info.plist" 2>/dev/null || true)
if [ -n "$EXPECTED_VERSION" ] && [ "$SOURCE_VERSION" != "$EXPECTED_VERSION" ]; then
  fallback "DMG version $SOURCE_VERSION does not match release $EXPECTED_VERSION"
fi

SOURCE_EXECUTABLE=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$SOURCE_APP/Contents/Info.plist" 2>/dev/null || true)
[ -n "$SOURCE_EXECUTABLE" ] && [ -f "$SOURCE_APP/Contents/MacOS/$SOURCE_EXECUTABLE" ] || fallback "bundle executable is missing"
/usr/bin/file "$SOURCE_APP/Contents/MacOS/$SOURCE_EXECUTABLE" | /usr/bin/grep -q "$EXPECTED_ARCH" || fallback "DMG architecture does not match this installation"
/usr/bin/codesign --verify --deep --strict "$SOURCE_APP" || fallback "application signature is invalid"
CURRENT_SIGNER=$(/usr/bin/codesign -d --verbose=4 "$DEST_APP" 2>&1 | /usr/bin/awk '/^(Authority|TeamIdentifier)=/{print}' || true)
SOURCE_SIGNER=$(/usr/bin/codesign -d --verbose=4 "$SOURCE_APP" 2>&1 | /usr/bin/awk '/^(Authority|TeamIdentifier)=/{print}' || true)
if [ -n "$CURRENT_SIGNER" ] && [ "$CURRENT_SIGNER" != "$SOURCE_SIGNER" ]; then
  fallback "application signing identity does not match the installed version"
fi

log "Staging zaalis IDE $SOURCE_VERSION"
[ ! -e "$STAGE_APP" ] || /bin/rm -rf "$STAGE_APP"
/usr/bin/ditto "$SOURCE_APP" "$STAGE_APP" || fallback "cannot stage application bundle"
/usr/bin/codesign --verify --deep --strict "$STAGE_APP" || fallback "staged application signature is invalid"
detach_image

log "Stopping running application"
if [ "$SHELL_PID" -gt 1 ]; then /bin/kill -TERM "$SHELL_PID" 2>/dev/null || true; fi
if [ "$SHELL_PID" -le 1 ] && [ "$SERVER_PID" -gt 1 ]; then /bin/kill -TERM "$SERVER_PID" 2>/dev/null || true; fi

attempt=0
while [ "$attempt" -lt 80 ]; do
  shell_alive=0
  server_alive=0
  if [ "$SHELL_PID" -gt 1 ] && /bin/kill -0 "$SHELL_PID" 2>/dev/null; then shell_alive=1; fi
  if [ "$SERVER_PID" -gt 1 ] && /bin/kill -0 "$SERVER_PID" 2>/dev/null; then server_alive=1; fi
  if [ "$shell_alive" -eq 0 ] && [ "$server_alive" -eq 0 ]; then break; fi
  /bin/sleep 0.25
  attempt=$((attempt + 1))
done

if [ "$SHELL_PID" -gt 1 ] && /bin/kill -0 "$SHELL_PID" 2>/dev/null; then /bin/kill -KILL "$SHELL_PID" 2>/dev/null || true; fi
if [ "$SERVER_PID" -gt 1 ] && /bin/kill -0 "$SERVER_PID" 2>/dev/null; then /bin/kill -KILL "$SERVER_PID" 2>/dev/null || true; fi
/bin/sleep 1

log "Replacing application bundle"
[ ! -e "$BACKUP_APP" ] || /bin/rm -rf "$BACKUP_APP"
/bin/mv "$DEST_APP" "$BACKUP_APP" || fallback "cannot move current application; reinstall manually"
REPLACED=1
if ! /bin/mv "$STAGE_APP" "$DEST_APP"; then
  fallback "cannot place updated application"
fi

/usr/bin/codesign --verify --deep --strict "$DEST_APP" || fallback "installed application signature is invalid"
if ! /usr/bin/open "$DEST_APP"; then
  fallback "cannot relaunch updated application"
fi

if [ -n "$EXPECTED_VERSION" ]; then
  /bin/mkdir -p "$(dirname -- "$LAST_TAG_FILE")" || true
  /usr/bin/printf 'v%s' "$EXPECTED_VERSION" >"$LAST_TAG_FILE" || true
fi

/bin/rm -rf "$BACKUP_APP"
REPLACED=0
log "Update installed and application relaunched successfully"
exit 0
`;
}

function launchMacosUpdater(options) {
  const runnerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaalis-updater-'));
  const scriptPath = path.join(runnerDir, 'install-update.sh');
  const script = buildMacosUpdateScript(options);
  fs.writeFileSync(scriptPath, script, { encoding: 'utf8', mode: 0o700 });

  const child = spawn('/bin/sh', [scriptPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { pid: child.pid, scriptPath };
}

module.exports = {
  ZAALIS_BUNDLE_ID,
  buildMacosUpdateScript,
  launchMacosUpdater,
  resolveMacosAppBundle,
  shellQuote,
};
