#!/usr/bin/env bash
# SPIKE (store-probe plan Task 0, round 2): REMOVED IN TASK 8. Measures the App Sandbox on
# ad-hoc-signed copies of the app, launched from the runner's shell. Run from the repository root
# after the spike job's two package steps (`--mac`, and `--mac mas --universal`).
#
# ROUND 1 (run 43110403997): the sandbox was enforced, but EVERY launch died within ~1 s on a
# Chromium CHECK -- `bootstrap_check_in <bundle id>.MachPortRendezvousServer.<pid>: Permission
# denied (1100)`, kernel `deny(1) mach-register` -- the bare launch included (its output held the
# same FATAL). Round 2 runs three variants, each on its OWN fresh copy and a fresh container:
#   A  ordinary Electron, round-1 entitlements;
#   B  ordinary Electron + com.apple.security.application-groups [TEAM.bundle id];
#   C  Electron's MAS build (electron-builder `mas` target, unsigned) + B's entitlements + the
#      ElectronTeamID Info.plist key Electron's MAS-submission guide pairs with that group.
# and per variant four launches, to separate what triggers a crash: bare, --user-data-dir only,
# replay/shot env only, the full golden; plus the outside-read NEGATIVE only when the golden matched.
#
# IT NEVER STOPS EARLY: no `set -e`. Every answer is a `SPIKE: ...` line (`grep '^SPIKE'`). Every
# launch is bounded by polling (macOS has no timeout(1)). The script exits 0.
#
# BASH 3.2 (macOS /bin/bash): no `case` inside `$(...)` (3.2 misparses it -- round 1's broken
# "inherits" lines), no associative arrays, no empty "${arr[@]}" under set -u.
set -uxo pipefail

ROOT="$PWD"
W="${RUNNER_TEMP:-/tmp}/spike"
BUNDLE_ID=io.github.athornton.tn3270
TEAM_ID=H68TN685J4   # the user's Apple Team ID (Developer ID certificate); not a secret
C="$HOME/Library/Containers/$BUNDLE_ID"
TRACE="$ROOT/packages/fixtures/traces/synthetic-ispf-like.trace"
WANT="$(cat "$ROOT/packages/gui/test/golden/synthetic-ispf.sha256" 2>/dev/null || echo 'golden-missing')"
DIAG="$HOME/Library/Logs/DiagnosticReports"
SHOT_SWITCHES="--disable-gpu --force-device-scale-factor=1 --force-color-profile=srgb"
HOST_ARGS="-insecure -model 3278-2-E 127.0.0.1:1"

T_ALL=$(date +%s)
T=0
rm -rf "$W"; mkdir -p "$W"
begin() { T=$(date +%s); echo "SPIKE-PHASE: begin $1 at $T"; }
end() { echo "SPIKE: duration $1: $(( $(date +%s) - T ))s"; }
has() { grep -q -- "$1" "$2" 2>/dev/null && echo YES || echo NO; }

# rm -rf the container, ONLY at its exact path.
rm_container() {
  if [ "$C" = "$HOME/Library/Containers/io.github.athornton.tn3270" ] && [ -n "$HOME" ] && [ "$HOME" != "/" ]; then
    rm -rf -- "$C"
  fi
  if [ -e "$C" ]; then echo "SPIKE: container removal: FAILED ($C still exists)"; fi
}

# Running and not a zombie (kill -0 succeeds on an unreaped zombie).
alive() { local s; s=$(ps -p "$1" -o stat= 2>/dev/null | tr -d ' '); [ -n "$s" ] && [ "${s#Z}" = "$s" ]; }

# Kills (by PID) every process whose executable is inside this run's copies, never by name.
reap() {
  local pids
  pids=$(ps -ww -axo pid=,comm= | awk -v d="$W/" 'index($2, d) == 1 { print $1 }')
  if [ -n "$pids" ]; then echo "SPIKE-NOTE: reaping $pids"; kill -9 $pids 2>/dev/null || true; fi
}

# Summarises one .ips crash report: exception, termination, crashed thread's first 40 frames.
cat > "$W/ips.py" <<'EOF'
import json, sys
text = open(sys.argv[1], encoding='utf-8', errors='replace').read()
head, _, body = text.partition('\n')
try:
    h = json.loads(head)
    print('  report:', h.get('app_name'), h.get('bug_type'), h.get('timestamp'))
    d = json.loads(body)
except Exception as e:
    print('  not JSON .ips (%s); first 60 lines:' % e)
    print('\n'.join(text.splitlines()[:60]))
    sys.exit(0)
print('  process:', d.get('procName'), d.get('procPath'))
print('  exception:', json.dumps(d.get('exception')))
print('  termination:', json.dumps(d.get('termination')))
asi = d.get('asi')
if asi: print('  asi:', json.dumps(asi)[:600])
images = d.get('usedImages', [])
i = d.get('faultingThread', 0)
threads = d.get('threads', [])
if i < len(threads):
    t = threads[i]
    print('  crashed thread %d %s %s' % (i, t.get('name', ''), t.get('queue', '')))
    for n, f in enumerate(t.get('frames', [])[:40]):
        img = images[f['imageIndex']].get('name', '?') if f.get('imageIndex', -1) < len(images) else '?'
        print('    %2d %-28s %s + %s' % (n, img, f.get('symbol', '?'), f.get('symbolLocation', f.get('imageOffset'))))
EOF

# The crash reports this launch made (newer than its mark), newest summarised.
crash_reports() {
  local label=$1 mark=$2 i newest=''
  # ReportCrash writes asynchronously: wait up to 10 s. Names have spaces ("TN3270 Helper (GPU)").
  for i in 1 2 3 4 5 6 7 8 9 10; do
    find "$DIAG" -maxdepth 1 \( -name 'TN3270*.ips' -o -name 'TN3270*.crash' \) -newer "$mark" -print0 2>/dev/null > "$W/reports.lst"
    if [ -s "$W/reports.lst" ]; then newest=$(xargs -0 ls -t < "$W/reports.lst" | head -1); break; fi
    sleep 1
  done
  find "$DIAG" -maxdepth 1 -name 'TN3270*' -newer "$mark" 2>/dev/null | sed 's/^/  new report: /'
  if [ -z "$newest" ]; then echo "SPIKE: $label crash report: NONE"; return; fi
  echo "SPIKE: $label crash report: $newest"
  case "$newest" in
    *.ips) python3 "$W/ips.py" "$newest" ;;
    *) head -80 "$newest" ;;
  esac
}

# This launch's Sandbox deny lines, de-duplicated (timestamps and pids stripped).
deny_lines() {
  local label=$1 start=$2
  log show --style compact --start "$start" \
    --predicate 'eventMessage CONTAINS "Sandbox" AND eventMessage CONTAINS "TN3270"' 2>/dev/null \
    | grep 'deny' | sed -E 's/^.*Sandbox: //; s/\([0-9]+\)//; s/\.[0-9]+$//' | sort | uniq -c | sort -rn > "$W/deny.txt" || true
  echo "SPIKE: $label sandbox denies: $(wc -l < "$W/deny.txt" | tr -d ' ') distinct"
  sed 's/^/    /' "$W/deny.txt"
}

# One launch. kind `stay`: should still be running after $secs (then killed). kind `exit`: should
# exit 0 by itself within $secs (the shot seam quits). Env assignments, then `--`, then argv.
launch() {
  local v=$1 l=$2 kind=$3 secs=$4; shift 4
  local envs=()
  while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  local label="$v $l" out="$W/$v-$l.out" mark="$W/$v-$l.mark" start n=0 p rc state
  touch "$mark"; sleep 1
  start="$(date '+%Y-%m-%d %H:%M:%S')"
  local t0; t0=$(date +%s)
  env "${envs[@]}" "$EXE" "$@" > "$out" 2>&1 &
  p=$!
  while [ $n -lt "$secs" ] && alive "$p"; do sleep 1; n=$((n + 1)); done
  if alive "$p"; then
    kill -9 "$p" 2>/dev/null; wait "$p" 2>/dev/null
    if [ "$kind" = stay ]; then state="alive"; else state="hung (killed after ${secs}s)"; fi
  else
    wait "$p"; rc=$?
    if [ "$kind" = exit ] && [ "$rc" = 0 ]; then state="exited rc=0"; else state="crashed rc=$rc after ~${n}s"; fi
  fi
  reap
  echo "SPIKE: duration $label: $(( $(date +%s) - t0 ))s"
  local probe golden got shot=''
  probe="$(grep -m1 '^probe: ' "$out" || echo NONE)"
  for e in "${envs[@]}"; do case "$e" in TN3270_GUI_SHOT=*) shot="${e#TN3270_GUI_SHOT=}" ;; esac; done
  if [ -n "$shot" ]; then
    got="$(cat "$shot.sha256" 2>/dev/null || echo '')"
    if [ -z "$got" ]; then golden=none; elif [ "$got" = "$WANT" ]; then golden=MATCH; else golden=DIFFERS; fi
    echo "SPIKE: $label sha256: got=${got:-no-sha256-file} want=$WANT"
    echo "SPIKE: $label shot line: $(grep -m1 'shot: ' "$out" || echo NONE)"
  else
    golden=none
  fi
  echo "SPIKE: $label FATAL line: $(grep -m1 'FATAL' "$out" || echo NONE)"
  echo "::group::$label output"; cat "$out"; echo "::endgroup::"
  case "$state" in crashed*) crash_reports "$label" "$mark" ;; esac
  deny_lines "$label" "$start"
  echo "SPIKE: $v $l: $state, probe=$probe, golden=$golden"
  LAST_GOLDEN=$golden
}

plist() { # file, then extra <key>...</key><...> lines
  local f=$1; shift
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0"><dict>'
    for k in "$@"; do echo "$k"; done
    echo '</dict></plist>'
  } > "$f"
  plutil -lint "$f" || echo "SPIKE: plutil -lint $f FAILED"
}
SANDBOX='<key>com.apple.security.app-sandbox</key><true/>'
MAIN_KEYS="<key>com.apple.security.network.client</key><true/>
<key>com.apple.security.files.user-selected.read-write</key><true/>
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>"
INHERIT='<key>com.apple.security.inherit</key><true/>'
GROUPS="<key>com.apple.security.application-groups</key><array><string>$TEAM_ID.$BUNDLE_ID</string></array>"

# A fresh copy of $2 as variant $1, signed inside-out with $3 (main) and $4 (inherit); a 5th
# argument `teamid` also sets ElectronTeamID in Info.plist BEFORE signing. Sets APP and EXE.
prepare() {
  local v=$1 src=$2 main=$3 inherit=$4 extra=${5:-}
  rm_container
  rm -rf "$W/$v"; mkdir -p "$W/$v"
  APP="$W/$v/TN3270.app"; EXE="$APP/Contents/MacOS/TN3270"
  ditto "$src" "$APP" || echo "SPIKE: $v copy of $src FAILED rc=$?"
  echo "SPIKE: $v source: $src"
  echo "SPIKE: $v ElectronTeamID before: $(/usr/libexec/PlistBuddy -c 'Print :ElectronTeamID' "$APP/Contents/Info.plist" 2>&1)"
  if [ "$extra" = teamid ]; then
    /usr/libexec/PlistBuddy -c "Add :ElectronTeamID string $TEAM_ID" "$APP/Contents/Info.plist" 2>/dev/null \
      || /usr/libexec/PlistBuddy -c "Set :ElectronTeamID $TEAM_ID" "$APP/Contents/Info.plist"
    echo "SPIKE: $v ElectronTeamID set: $(/usr/libexec/PlistBuddy -c 'Print :ElectronTeamID' "$APP/Contents/Info.plist" 2>&1)"
  fi
  echo "SPIKE: $v Frameworks: $(ls "$APP/Contents/Frameworks" | tr '\n' ' ')"
  find "$APP/Contents/Frameworks" -name '*.dylib' -print0 | xargs -0 -n1 codesign --force -s - || echo "SPIKE: $v dylib signing rc=$?"
  # --deep on frameworks only: Electron Framework.framework nests executables (Helpers/chrome_crashpad_handler).
  find "$APP/Contents/Frameworks" -maxdepth 1 -name '*.framework' -print0 | xargs -0 -n1 codesign --force --deep -s - || echo "SPIKE: $v framework signing rc=$?"
  find "$APP/Contents/Frameworks" -maxdepth 1 -name '*.app' -print0 | xargs -0 -n1 codesign --force -s - --entitlements "$inherit" || echo "SPIKE: $v helper signing rc=$?"
  codesign --force -s - --entitlements "$main" "$APP" || echo "SPIKE: $v app signing rc=$?"
  codesign -d --entitlements :- "$APP" > "$W/$v.ent" 2>&1 || true
  cat "$W/$v.ent"
  echo "SPIKE: $v app-sandbox in signature: $(has com.apple.security.app-sandbox "$W/$v.ent")"
  echo "SPIKE: $v application-groups in signature: $(has com.apple.security.application-groups "$W/$v.ent")"
  local h
  for h in "$APP"/Contents/Frameworks/*.app; do
    codesign -d --entitlements :- "$h" > "$W/$v.hent" 2>&1 || true
    echo "SPIKE: $v helper $(basename "$h") inherit: $(has com.apple.security.inherit "$W/$v.hent") application-groups: $(has com.apple.security.application-groups "$W/$v.hent")"
  done
  codesign --verify --deep --strict --verbose=2 "$APP" 2>&1; echo "SPIKE: $v codesign --verify --deep --strict rc=$?"
  codesign -dv "$APP" 2>&1 | grep -E '^(Identifier|Signature|Format)=' || true
}

# The variant's launches, in order. The bare launch makes the container; the trace is staged into it.
launches() {
  local v=$1 D="$C/Data"
  launch "$v" bare stay 20 TN3270_GUI_PROBE=1 -- --disable-gpu
  if [ -d "$D" ]; then echo "SPIKE: $v container appeared: YES"; else echo "SPIKE: $v container appeared: NO"; mkdir -p "$D"; fi
  if cp "$TRACE" "$D/"; then echo "SPIKE: $v staging into the container: OK"; else echo "SPIKE: $v staging into the container: FAILED rc=$?"; fi
  launch "$v" user-data-dir stay 20 TN3270_GUI_PROBE=1 -- --disable-gpu "--user-data-dir=$D/ud"
  launch "$v" replay-env exit 60 TN3270_GUI_PROBE=1 "TN3270_GUI_REPLAY=$D/synthetic-ispf-like.trace" "TN3270_GUI_SHOT=$D/shot-env.png" TN3270_GUI_SHOT_MS=2500 \
    -- $SHOT_SWITCHES $HOST_ARGS
  launch "$v" golden exit 120 TN3270_GUI_PROBE=1 "TN3270_GUI_REPLAY=$D/synthetic-ispf-like.trace" "TN3270_GUI_SHOT=$D/shot.png" TN3270_GUI_SHOT_MS=2500 \
    -- $SHOT_SWITCHES "--user-data-dir=$D/ud-golden" $HOST_ARGS
  if [ "$LAST_GOLDEN" = MATCH ]; then
    # NEGATIVE: the repository's trace, OUTSIDE the container, must not be readable.
    launch "$v" outside exit 60 TN3270_GUI_PROBE=1 "TN3270_GUI_REPLAY=$TRACE" "TN3270_GUI_SHOT=$D/shot-outside.png" TN3270_GUI_SHOT_MS=2500 \
      -- $SHOT_SWITCHES "--user-data-dir=$D/ud-outside" $HOST_ARGS
    echo "SPIKE: $v outside read denied (EPERM in output): $(grep -m1 -E 'EPERM|Operation not permitted|EACCES' "$W/$v-outside.out" || echo 'NO such line')"
  else
    echo "SPIKE: $v outside launch: SKIPPED (golden was $LAST_GOLDEN)"
  fi
  ls -la "$D" 2>&1 || true
}

# ---------------------------------------------------------------------------------------------
begin setup
sw_vers || true; bash --version | head -1
ZIP=$(ls "$ROOT"/artifacts/gui/TN3270-*-mac-universal.zip 2>/dev/null | head -1)
echo "SPIKE: universal zip: ${ZIP:-NONE}"
mkdir -p "$W/zip" && ditto -x -k "$ZIP" "$W/zip" || echo "SPIKE: ditto -x -k failed rc=$?"
MAS_SRC="$ROOT/artifacts/gui/mas-universal/TN3270.app"
echo "SPIKE: mas app built: $([ -d "$MAS_SRC" ] && echo "YES $MAS_SRC" || echo NO)"
ls -la "$ROOT/artifacts/gui" "$ROOT/artifacts/gui/mas-universal" 2>&1 || true
# Which Electron zips the cache holds: a `mas` one means the mas target downloaded Electron's MAS build.
echo "SPIKE: electron cache zips: $(ls "$HOME/Library/Caches/electron" 2>/dev/null | grep -i 'zip' | tr '\n' ' ')"
find "$HOME/Library/Caches/electron" -name '*mas*' 2>/dev/null | sed 's/^/  mas in cache: /'
for a in "$W/zip/TN3270.app" "$MAS_SRC"; do
  [ -d "$a" ] || continue
  echo "SPIKE: $a Frameworks: $(ls "$a/Contents/Frameworks" | tr '\n' ' ')"
  echo "SPIKE: $a Squirrel.framework present (absent in MAS Electron): $([ -d "$a/Contents/Frameworks/Squirrel.framework" ] && echo YES || echo NO)"
done
plist "$W/A-main.plist" "$SANDBOX" "$MAIN_KEYS"
plist "$W/A-inherit.plist" "$SANDBOX" "$INHERIT"
plist "$W/B-main.plist" "$SANDBOX" "$MAIN_KEYS" "$GROUPS"
plist "$W/B-inherit.plist" "$SANDBOX" "$INHERIT" "$GROUPS"
end setup

# ---------------------------------------------------------------------------------------------
begin variant-A
prepare A "$W/zip/TN3270.app" "$W/A-main.plist" "$W/A-inherit.plist"
launches A
end variant-A

begin variant-B
prepare B "$W/zip/TN3270.app" "$W/B-main.plist" "$W/B-inherit.plist"
launches B
end variant-B

begin variant-C
if [ -d "$MAS_SRC" ]; then
  prepare C "$MAS_SRC" "$W/B-main.plist" "$W/B-inherit.plist" teamid
  launches C
else
  echo "SPIKE: variant C: SKIPPED (no mas app; see the mas package step)"
fi
end variant-C

rm_container
reap
echo "SPIKE: duration mac-sandbox.sh total: $(( $(date +%s) - T_ALL ))s"
exit 0
