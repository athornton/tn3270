#!/usr/bin/env bash
# SPIKE (store-probe plan Task 0): REMOVED IN TASK 8. Measures the App Sandbox on an ad-hoc-signed
# copy of the universal app, launched from the runner's shell. Run from the repository root after
# `npm run package:gui -- --mac`.
#
# IT NEVER STOPS EARLY: no `set -e`. Every measurement prints a `SPIKE: <question>: <answer>` line
# whatever happens, so one run answers every question (`grep '^SPIKE'` on the job log). Every launch
# is bounded (`bounded`, below): macOS has no timeout(1). The script exits 0; the answers are the
# result, not the exit code.
set -uxo pipefail

ROOT="$PWD"
W="${RUNNER_TEMP:-/tmp}/spike"
BUNDLE_ID=io.github.athornton.tn3270
C="$HOME/Library/Containers/$BUNDLE_ID"
TRACE="$ROOT/packages/fixtures/traces/synthetic-ispf-like.trace"
WANT="$(cat "$ROOT/packages/gui/test/golden/synthetic-ispf.sha256" 2>/dev/null || echo 'golden-missing')"
# shot.mjs case 1's argv, as package-smoke drawsGolden passes it (switches + CAPTURE_SWITCHES).
SHOT_ARGS=(--disable-gpu --force-device-scale-factor=1 --force-color-profile=srgb)
HOST_ARGS=(-insecure -model 3278-2-E 127.0.0.1:1)

T_ALL=$(date +%s)
T=0
begin() { T=$(date +%s); echo "SPIKE-PHASE: begin $1 at $T"; }
end() { echo "SPIKE: duration $1: $(( $(date +%s) - T ))s"; }

# Runs "$@" in the background, kill -9 after $1 seconds; returns its exit status (137 if killed).
bounded() {
  local secs=$1; shift
  "$@" & local p=$!
  ( sleep "$secs"; kill -9 "$p" 2>/dev/null && echo "SPIKE-NOTE: killed pid $p after ${secs}s" ) & local k=$!
  wait "$p"; local rc=$?
  kill "$k" 2>/dev/null || true
  return $rc
}

# Kills (by PID) every process whose executable is inside our copy: Electron helpers that outlive
# a kill -9'd browser process. Matched on the full path of THIS run's copy, never on a name.
reap() {
  local pids
  pids=$(ps -ww -axo pid=,comm= | awk -v d="$W/" 'index($2, d) == 1 { print $1 }')
  if [ -n "$pids" ]; then echo "SPIKE-NOTE: reaping $pids"; kill -9 $pids 2>/dev/null || true; fi
}

# The sha256 a shot seam wrote (`<shot>.sha256`, main.ts maybeCapture) against the golden.
judge() {
  local label=$1 shot=$2 got
  got="$(cat "$shot.sha256" 2>/dev/null || echo 'no-sha256-file')"
  echo "SPIKE: $label golden: $([ "$got" = "$WANT" ] && echo MATCH || echo DIFFERS) got=$got want=$WANT"
  ls -la "$shot" "$shot.sha256" 2>&1 || true
}

# The `probe:` line (TN3270_GUI_PROBE=1, main.ts) and the `shot:` line from a launch's output.
lines() {
  local label=$1 out=$2
  echo "SPIKE: $label probe line: $(grep -m1 '^probe: ' "$out" || echo 'NONE')"
  echo "SPIKE: $label shot line: $(grep -m1 'shot: ' "$out" || echo 'NONE')"
  echo "::group::$label output"; cat "$out"; echo "::endgroup::"
}

# ---------------------------------------------------------------------------------------------
begin unpack-and-sign
rm -rf "$W" "$C"; mkdir -p "$W"
sw_vers || true
ZIP=$(ls "$ROOT"/artifacts/gui/TN3270-*-mac-universal.zip 2>/dev/null | head -1)
echo "SPIKE: universal zip: ${ZIP:-NONE}"
ditto -x -k "$ZIP" "$W" || echo "SPIKE: ditto failed rc=$?"
APP="$W/TN3270.app"; EXE="$APP/Contents/MacOS/TN3270"
ls -la "$APP/Contents/MacOS" "$APP/Contents/Frameworks" || true
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist" || true

# A second copy of the trace INSIDE the bundle, before signing (the sandbox lets an app read its
# own bundle): the fallback input route if staging into the container from outside is refused.
mkdir -p "$APP/Contents/Resources/spike" && cp "$TRACE" "$APP/Contents/Resources/spike/" || echo "SPIKE: bundle staging failed rc=$?"

cat > "$W/main.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.app-sandbox</key><true/>
<key>com.apple.security.network.client</key><true/>
<key>com.apple.security.files.user-selected.read-write</key><true/>
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>
EOF
cat > "$W/inherit.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.app-sandbox</key><true/>
<key>com.apple.security.inherit</key><true/>
</dict></plist>
EOF
# Inside-out: dylibs and frameworks plain, helper apps with inherit, the app last with main.
find "$APP/Contents/Frameworks" -name '*.dylib' -print0 | xargs -0 -n1 codesign --force -s - || echo "SPIKE: dylib signing rc=$?"
# --deep on frameworks only: Electron Framework.framework nests executables (Helpers/chrome_crashpad_handler).
find "$APP/Contents/Frameworks" -maxdepth 1 -name '*.framework' -print0 | xargs -0 -n1 codesign --force --deep -s - || echo "SPIKE: framework signing rc=$?"
find "$APP/Contents/Frameworks" -maxdepth 1 -name '*.app' -print0 | xargs -0 -n1 codesign --force -s - --entitlements "$W/inherit.plist" || echo "SPIKE: helper signing rc=$?"
codesign --force -s - --entitlements "$W/main.plist" "$APP" || echo "SPIKE: app signing rc=$?"
codesign -d --entitlements :- "$APP" > "$W/ent.txt" 2>&1 || true
cat "$W/ent.txt"
echo "SPIKE: codesign -d shows app-sandbox: $(grep -q 'com.apple.security.app-sandbox' "$W/ent.txt" && echo YES || echo NO)"
for h in "$APP"/Contents/Frameworks/*.app; do
  # Captured first, not piped into grep -q: under pipefail an early-exiting grep can SIGPIPE codesign.
  he="$(codesign -d --entitlements :- "$h" 2>&1)"
  echo "SPIKE: helper $(basename "$h") inherits: $(case "$he" in *com.apple.security.inherit*) echo YES;; *) echo NO;; esac)"
done
codesign --verify --deep --strict --verbose=2 "$APP" 2>&1; echo "SPIKE: codesign --verify --deep --strict rc=$?"
codesign -dv "$APP" 2>&1 | grep -E '^(Identifier|Signature|Format)=' || true
end unpack-and-sign

# ---------------------------------------------------------------------------------------------
# 1: launch with nothing to do (the Connect dialog), kill after 20 s; does the container appear?
begin first-launch
# Not in a subshell: $! must be the app itself, so the kill -9 below reaches it.
TN3270_GUI_PROBE=1 "$EXE" --disable-gpu > "$W/first.out" 2>&1 & P=$!
sleep 20; kill -9 "$P" 2>/dev/null || true; wait "$P" 2>/dev/null; reap
lines first-launch "$W/first.out"
ls -la "$C" "$C/Data" 2>&1 || true
if [ -d "$C/Data" ]; then echo "SPIKE: container appeared (direct exec): YES $C"; else echo "SPIKE: container appeared (direct exec): NO"; fi
end first-launch

# 1b: ONLY if direct exec made no container -- does a LaunchServices launch (`open`) make one?
if [ ! -d "$C/Data" ]; then
  begin open-launch
  open -n "$APP" --args --disable-gpu || echo "SPIKE: open rc=$?"
  sleep 20; reap
  if [ -d "$C/Data" ]; then echo "SPIKE: container appeared (open): YES"; else echo "SPIKE: container appeared (open): NO"; fi
  end open-launch
fi

# ---------------------------------------------------------------------------------------------
# 2: the golden, with the trace and the user data staged INSIDE the container from the shell.
begin golden-in-container
mkdir -p "$C/Data" 2>&1 || true
if cp "$TRACE" "$C/Data/"; then echo "SPIKE: staging into the container from the shell: OK"; else echo "SPIKE: staging into the container from the shell: FAILED rc=$?"; fi
TN3270_GUI_PROBE=1 TN3270_GUI_REPLAY="$C/Data/synthetic-ispf-like.trace" TN3270_GUI_SHOT="$C/Data/shot.png" TN3270_GUI_SHOT_MS=2500 \
  bounded 120 "$EXE" "${SHOT_ARGS[@]}" --user-data-dir="$C/Data/ud" "${HOST_ARGS[@]}" > "$W/golden.out" 2>&1
echo "SPIKE: golden launch exit: rc=$?"; reap
lines golden "$W/golden.out"
judge "sandboxed (inputs in container)" "$C/Data/shot.png"
end golden-in-container

# 2b: the same, the trace read from INSIDE THE BUNDLE (the fallback input route); shot in the container.
begin golden-from-bundle
TN3270_GUI_PROBE=1 TN3270_GUI_REPLAY="$APP/Contents/Resources/spike/synthetic-ispf-like.trace" TN3270_GUI_SHOT="$C/Data/shot-bundle.png" TN3270_GUI_SHOT_MS=2500 \
  bounded 120 "$EXE" "${SHOT_ARGS[@]}" --user-data-dir="$C/Data/ud-bundle" "${HOST_ARGS[@]}" > "$W/bundle.out" 2>&1
echo "SPIKE: bundle-trace launch exit: rc=$?"; reap
lines bundle-trace "$W/bundle.out"
judge "sandboxed (trace in bundle)" "$C/Data/shot-bundle.png"
end golden-from-bundle

# ---------------------------------------------------------------------------------------------
# 3: NEGATIVE -- the same trace OUTSIDE the container must NOT be readable if the sandbox is real.
begin outside-read
T_LOG="$(date '+%Y-%m-%d %H:%M:%S')"
TN3270_GUI_PROBE=1 TN3270_GUI_REPLAY="$TRACE" TN3270_GUI_SHOT="$C/Data/shot2.png" TN3270_GUI_SHOT_MS=2500 \
  bounded 120 "$EXE" "${SHOT_ARGS[@]}" --user-data-dir="$C/Data/ud2" "${HOST_ARGS[@]}" > "$W/outside.out" 2>&1
echo "SPIKE: outside launch exit: rc=$?"; reap
lines outside "$W/outside.out"
judge "outside read (MUST NOT match)" "$C/Data/shot2.png"
DENIED=$(grep -m1 -E 'EPERM|Operation not permitted|EACCES' "$W/outside.out" || true)
echo "SPIKE: outside read denied in app output: ${DENIED:-NO such line}"
# The kernel's own record: Sandbox deny lines for our process since this phase began.
log show --style compact --start "$T_LOG" --predicate 'sender == "Sandbox"' 2>/dev/null \
  | grep -i 'deny' | grep -i 'tn3270' | head -20 > "$W/deny.txt" || true
cat "$W/deny.txt"
echo "SPIKE: Sandbox deny log lines for TN3270: $(wc -l < "$W/deny.txt" | tr -d ' ')"
end outside-read

ls -la "$C/Data" 2>&1 || true
rm -rf "$C" || true
reap
echo "SPIKE: duration mac-sandbox.sh total: $(( $(date +%s) - T_ALL ))s"
exit 0
