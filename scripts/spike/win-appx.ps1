# SPIKE (store-probe plan Task 0): REMOVED IN TASK 8. Measures the appx built by the spike job's
# package:gui step (`-c.win.target=appx` and the placeholder identity): self-signed, installed, and
# launched through its uap5 app execution alias and directly. Run from the repository root under
# Windows PowerShell 5.1 (`powershell.exe`, which has the Appx module natively; PowerShell 7 needs
# `Import-Module Appx -UseWindowsPowerShell` on some images).
#
# ROUND 2: signs with the Windows SDK's newest signtool (round 1's kit signtool could not sign),
# keeps the kit attempt as a comparison, and measures BOTH packages end to end: the default
# (MinVersion 10.0.14316.0) and the 10.0.17763.0 variant, each installed, launched and removed.
#
# ALL OUTPUT IS Write-Host, never Write-Output: inside a function (Install, AliasCheck) Write-Output
# would become part of the function's return value instead of reaching the log.
#
# IT NEVER STOPS EARLY: $ErrorActionPreference = 'Continue', every phase in try/catch, and every
# measurement prints a `SPIKE: <question>: <answer>` line whatever happens (`grep '^SPIKE'` on the
# job log). Every launch is bounded: Start-Process -PassThru, Wait-Process -Timeout 120, then a kill
# by process Id. The script exits 0; the answers are the result, not the exit code.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$Root = (Get-Location).Path
$Temp = Join-Path $env:RUNNER_TEMP 'spike'
Remove-Item -Recurse -Force $Temp -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $Temp | Out-Null
$Trace = Join-Path $Root 'packages\fixtures\traces\synthetic-ispf-like.trace'
$Want = (Get-Content -Raw (Join-Path $Root 'packages\gui\test\golden\synthetic-ispf.sha256')).Trim()
$Subject = 'CN=TN3270 Store Probe'
$PkgName = 'TN3270.Probe'
$TAll = Get-Date
$script:T = Get-Date

function Say([string]$s) { Write-Host "SPIKE: $s" }
function PhaseStart([string]$name) { $script:T = Get-Date; Write-Host "SPIKE-PHASE: begin $name at $($script:T.ToString('o'))" }
function PhaseEnd([string]$name) { Say ("duration {0}: {1:N1}s" -f $name, ((Get-Date) - $script:T).TotalSeconds) }

# The package full name of a live process (GetPackageFullName), independent of what the app says:
# the spec's fallback identity check, measured in the same run.
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class SpikePkg {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetPackageFullName(IntPtr h, ref uint len, StringBuilder name);
  public static string Of(int pid) {
    IntPtr h = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
    if (h == IntPtr.Zero) return "OpenProcess failed, error " + Marshal.GetLastWin32Error();
    try {
      uint len = 0;
      int rc = GetPackageFullName(h, ref len, null);
      if (rc == 15700) return "none (APPMODEL_ERROR_NO_PACKAGE)";
      if (rc != 122) return "GetPackageFullName rc=" + rc;
      StringBuilder sb = new StringBuilder((int)len);
      rc = GetPackageFullName(h, ref len, sb);
      return rc == 0 ? sb.ToString() : "GetPackageFullName rc=" + rc;
    } finally { CloseHandle(h); }
  }
}
'@
} catch { Say "Add-Type SpikePkg failed: $($_.Exception.Message)" }

# PIDs of processes whose executable is under $dir (as package-smoke's winProcessesUnder does).
function ProcsUnder([string]$dir) {
  if (-not $dir) { return @() }
  @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) })
}

# One bounded launch: stdout/stderr to files, package identity sampled while it runs, the shot
# judged. $exe is the alias or the installed exe; the env seams are set for this launch only.
function Launch([string]$label, [string]$exe, [string]$installDir) {
  $dir = Join-Path $Temp $label
  New-Item -ItemType Directory -Force $dir | Out-Null
  $shot = Join-Path $dir 'shot.png'
  $out = Join-Path $dir 'stdout.txt'; $err = Join-Path $dir 'stderr.txt'
  $ud = Join-Path $dir 'user-data'
  $env:TN3270_GUI_PROBE = '1'; $env:TN3270_GUI_REPLAY = $Trace; $env:TN3270_GUI_SHOT = $shot; $env:TN3270_GUI_SHOT_MS = '2500'
  # shot.mjs case 1's argv, as package-smoke drawsGolden passes it. No argument contains a space.
  $argv = @('--disable-gpu', '--force-device-scale-factor=1', '--force-color-profile=srgb', "--user-data-dir=$ud", '-insecure', '-model', '3278-2-E', '127.0.0.1:1')
  $p = $null
  try {
    $p = Start-Process -FilePath $exe -ArgumentList $argv -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
    $null = $p.Handle  # cache the handle, or ExitCode reads back empty after exit
    Say "$label started: pid $($p.Id)"
  } catch { Say "$label Start-Process FAILED: $($_.Exception.Message)" }
  foreach ($k in 'TN3270_GUI_PROBE', 'TN3270_GUI_REPLAY', 'TN3270_GUI_SHOT', 'TN3270_GUI_SHOT_MS') { Remove-Item "Env:\$k" -ErrorAction SilentlyContinue }
  if ($p) {
    # Identity from outside, sampled while it lives: the started pid, and everything under the install dir.
    $ident = 'never sampled (exited first)'
    $deadline = (Get-Date).AddSeconds(30)
    while (-not $p.HasExited -and (Get-Date) -lt $deadline) {
      try { $ident = [SpikePkg]::Of($p.Id) } catch { $ident = "query failed: $($_.Exception.Message)" }
      $under = @(ProcsUnder $installDir)
      if ($under.Count -gt 0) {
        $first = $under[0]
        $underIdent = $(try { [SpikePkg]::Of([int]$first.ProcessId) } catch { "query failed: $($_.Exception.Message)" })
        Say "$label package of pid $($first.ProcessId) ($($first.ExecutablePath)): $underIdent"
        break
      }
      Start-Sleep -Milliseconds 300
    }
    Say "$label package of started pid $($p.Id): $ident"
    # Decided on HasExited alone: Wait-Process also errors when the process has ALREADY gone.
    try { Wait-Process -Id $p.Id -Timeout 120 -ErrorAction Stop } catch { }
    if (-not $p.HasExited) {
      Say "$label still running after 120 s: killing pid $($p.Id)"
      Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    } else { Say "$label exit code: $($p.ExitCode)" }
    Start-Sleep -Seconds 2
    foreach ($q in (ProcsUnder $installDir)) { Say "$label reaping pid $($q.ProcessId) $($q.ExecutablePath)"; Stop-Process -Id $q.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  $o = if (Test-Path $out) { Get-Content -Raw $out } else { '' }
  $e = if (Test-Path $err) { Get-Content -Raw $err } else { '' }
  if ($o -eq $null) { $o = '' }; if ($e -eq $null) { $e = '' }
  $probe = ($o -split "`r?`n" | Where-Object { $_ -like 'probe: *' } | Select-Object -First 1)
  $shotLine = ($o -split "`r?`n" | Where-Object { $_ -like '*shot: *' } | Select-Object -First 1)
  Say "$label probe line: $(if ($probe) { $probe } else { 'NONE' })"
  Say "$label shot line: $(if ($shotLine) { $shotLine } else { 'NONE' })"
  $got = if (Test-Path "$shot.sha256") { (Get-Content -Raw "$shot.sha256").Trim() } else { 'no-sha256-file' }
  Say "$label golden: $(if ($got -eq $Want) { 'MATCH' } else { 'DIFFERS' }) got=$got want=$Want"
  # The args reached the app iff the user-data dir it was given exists (and the shot used the model).
  Say "$label --user-data-dir created (args passed): $(if (Test-Path $ud) { 'YES' } else { 'NO' })"
  Say "$label env passed (probe line present AND shot written): $(if ($probe -and (Test-Path $shot)) { 'YES' } else { 'NO' })"
  Write-Host "::group::$label stdout"; Write-Host $o; Write-Host '::endgroup::'
  Write-Host "::group::$label stderr"; Write-Host $e; Write-Host '::endgroup::'
}

# ---------------------------------------------------------------------------------------------
PhaseStart 'find-appx'
[Environment]::OSVersion.Version | Format-List | Out-String | Write-Host
Get-ChildItem (Join-Path $Root 'artifacts\gui') -ErrorAction SilentlyContinue | Format-Table Name, Length -AutoSize | Out-String | Write-Host
$Appx = Get-ChildItem (Join-Path $Root 'artifacts\gui') -Filter 'TN3270-*-win-x64.appx' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($Appx) { $Appx = $Appx.FullName; Say "appx built (makeappx accepted the inline-namespaced uap5 alias): YES $Appx" }
else { Say 'appx built (makeappx accepted the inline-namespaced uap5 alias): NO (no TN3270-*-win-x64.appx; see the package:gui step)' }
# The manifest electron-builder generated, as packed: does the alias survive, and which versions?
if ($Appx) {
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($Appx)
    $entry = $zip.Entries | Where-Object { $_.FullName -eq 'AppxManifest.xml' } | Select-Object -First 1
    $reader = New-Object IO.StreamReader($entry.Open())
    $manifest = $reader.ReadToEnd(); $reader.Close(); $zip.Dispose()
    Write-Host '::group::AppxManifest.xml (packed)'; Write-Host $manifest; Write-Host '::endgroup::'
    Say "packed manifest has the alias: $(if ($manifest -match 'tn3270-gui\.exe') { 'YES' } else { 'NO' })"
    $tdf = [regex]::Match($manifest, '<TargetDeviceFamily[^>]*>').Value
    Say "packed manifest TargetDeviceFamily: $tdf"
    Say "packed manifest Identity: $([regex]::Match($manifest, '<Identity[^>]*>').Value -replace '\s+', ' ')"
  } catch { Say "reading the packed manifest FAILED: $($_.Exception.Message)" }
}
PhaseEnd 'find-appx'

# ---------------------------------------------------------------------------------------------
PhaseStart 'certificate'
$Cert = $null; $Pfx = Join-Path $Temp 'probe.pfx'; $Cer = Join-Path $Temp 'probe.cer'
$Pw = [Guid]::NewGuid().ToString('N')
try {
  $Cert = New-SelfSignedCertificate -Type Custom -Subject $Subject -KeyUsage DigitalSignature -CertStoreLocation Cert:\CurrentUser\My -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}') -FriendlyName 'TN3270 store probe spike'
  Say "certificate created: $($Cert.Thumbprint) $($Cert.Subject)"
  Export-PfxCertificate -Cert "Cert:\CurrentUser\My\$($Cert.Thumbprint)" -FilePath $Pfx -Password (ConvertTo-SecureString -String $Pw -Force -AsPlainText) | Out-Null
  Export-Certificate -Cert "Cert:\CurrentUser\My\$($Cert.Thumbprint)" -FilePath $Cer | Out-Null
  Import-Certificate -FilePath $Cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null
  Say "certificate public part in LocalMachine\TrustedPeople: $(if (Test-Path "Cert:\LocalMachine\TrustedPeople\$($Cert.Thumbprint)") { 'YES' } else { 'NO' })"
} catch { Say "certificate FAILED: $($_.Exception.Message)" }
PhaseEnd 'certificate'

# ---------------------------------------------------------------------------------------------
# ROUND 1 (run 43110403997): the winCodeSign-2.6.0 kit's signtool failed ("SignTool Error: A
# required function is not present"), so Add-AppxPackage refused both packages (0x800B0100).
# Round 2 signs with the Windows SDK's newest signtool and keeps the kit attempt as a comparison.
PhaseStart 'tools'
$EbCache = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache'
$tools = @(Get-ChildItem $EbCache -Recurse -Include 'signtool.exe', 'makeappx.exe' -ErrorAction SilentlyContinue)
foreach ($t in $tools) { Write-Host "  found: $($t.FullName)" }
function KitTool([string]$name) {
  $hit = $tools | Where-Object { $_.Name -eq $name -and $_.FullName -like '*\windows-10\x64\*' } | Select-Object -First 1
  if ($hit) { return $hit.FullName } else { return $null }
}
# The newest SDK bin\10.*\x64\<name>, by version (not by string order).
function SdkTool([string]$name) {
  $bin = 'C:\Program Files (x86)\Windows Kits\10\bin'
  $dirs = @(Get-ChildItem $bin -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^10\.\d+\.\d+\.\d+$' } | Sort-Object { [version]$_.Name } -Descending)
  foreach ($d in $dirs) { $f = Join-Path $d.FullName "x64\$name"; if (Test-Path $f) { return $f } }
  return $null
}
function ToolVersion([string]$f) { if ($f) { (Get-Item $f).VersionInfo.FileVersion } else { 'n/a' } }
$KitSignTool = KitTool 'signtool.exe'
$SdkSignTool = SdkTool 'signtool.exe'
$MakeAppx = KitTool 'makeappx.exe'
if (-not $MakeAppx) { $MakeAppx = SdkTool 'makeappx.exe' }
Say "signtool (electron-builder kit): $(if ($KitSignTool) { "$KitSignTool version $(ToolVersion $KitSignTool)" } else { 'NONE' })"
Say "signtool (Windows SDK, newest): $(if ($SdkSignTool) { "$SdkSignTool version $(ToolVersion $SdkSignTool)" } else { 'NONE' })"
Say "makeappx (for the variant): $(if ($MakeAppx) { "$MakeAppx version $(ToolVersion $MakeAppx)" } else { 'NONE' })"
PhaseEnd 'tools'

# ---------------------------------------------------------------------------------------------
# The 10.0.17763.0 variant, ALWAYS built (round 1 built it only as a fallback): the default
# package, unsigned, unpacked, TargetDeviceFamily raised, repacked. uap5 is documented from build
# 16299; electron-builder's x64 default is 10.0.14316.0 (AppxTarget.js:174).
PhaseStart 'variant-build'
$Appx2 = $null
if ($Appx -and $MakeAppx) {
  $un = Join-Path $Temp 'unpacked'; $cand = Join-Path $Temp 'TN3270-minversion.appx'
  & $MakeAppx unpack /p $Appx /d $un /o 2>&1 | Select-Object -Last 5 | Write-Host
  Say "makeappx unpack: rc=$LASTEXITCODE"
  $mf = Join-Path $un 'AppxManifest.xml'
  # The footprint files makeappx writes itself; -LiteralPath, because [ ] are wildcards to -Path.
  foreach ($f in 'AppxSignature.p7x', 'AppxBlockMap.xml', '[Content_Types].xml') { Remove-Item -LiteralPath (Join-Path $un $f) -Force -ErrorAction SilentlyContinue }
  $m = Get-Content -Raw $mf
  $m = [regex]::Replace($m, 'MinVersion="[^"]*"', 'MinVersion="10.0.17763.0"')
  $m = [regex]::Replace($m, 'MaxVersionTested="[^"]*"', 'MaxVersionTested="10.0.22621.0"')
  [IO.File]::WriteAllText($mf, $m)
  Say "variant TargetDeviceFamily: $([regex]::Match($m, '<TargetDeviceFamily[^>]*>').Value)"
  & $MakeAppx pack /d $un /p $cand /o 2>&1 | Select-Object -Last 5 | Write-Host
  Say "makeappx pack (variant): rc=$LASTEXITCODE"
  if (Test-Path $cand) { $Appx2 = $cand }
} else { Say 'variant build: SKIPPED (no appx or no makeappx)' }
PhaseEnd 'variant-build'

# ---------------------------------------------------------------------------------------------
PhaseStart 'sign'
function SignWith([string]$tool, [string]$file, [string]$label) {
  if (-not ($tool -and $Cert -and $file)) { Say "signtool sign ($label): SKIPPED (signtool, certificate or appx missing)"; return $false }
  & $tool sign /fd SHA256 /f $Pfx /p $Pw $file 2>&1 | Write-Host
  $rc = $LASTEXITCODE
  Say "signtool sign ($label) $(Split-Path -Leaf $file): rc=$rc"
  return ($rc -eq 0)
}
# The comparison: the kit's signtool on a COPY, so its failure cannot touch the packages installed below.
if ($Appx) {
  $kitCopy = Join-Path $Temp 'kit-signtool-copy.appx'
  Copy-Item $Appx $kitCopy -Force
  $null = SignWith $KitSignTool $kitCopy 'kit signtool, comparison'
}
$SignTool = if ($SdkSignTool) { $SdkSignTool } else { $KitSignTool }
Say "signing with: $SignTool"
$null = SignWith $SignTool $Appx 'default'
$null = SignWith $SignTool $Appx2 'minversion'
PhaseEnd 'sign'

# ---------------------------------------------------------------------------------------------
function Install([string]$file, [string]$label) {
  PhaseStart "install-$label"
  try {
    Add-AppxPackage -Path $file -ErrorAction Stop
    Say "Add-AppxPackage ($label): OK"
  } catch {
    Say "Add-AppxPackage ($label): FAILED $($_.Exception.Message)"
    $aid = [regex]::Match($_.Exception.Message, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}').Value
    if ($aid) { Get-AppPackageLog -ActivityID $aid -ErrorAction SilentlyContinue | Select-Object -First 40 | Format-List | Out-String | Write-Host }
  }
  $pkg = Get-AppxPackage $PkgName
  $pkg | Format-List * | Out-String | Write-Host
  if ($pkg) { Say "Get-AppxPackage ($label): $($pkg.PackageFullName) family=$($pkg.PackageFamilyName) at $($pkg.InstallLocation)" }
  else { Say "Get-AppxPackage ($label): NOT INSTALLED" }
  PhaseEnd "install-$label"
  return $pkg
}

function AliasCheck([string]$label) {
  $wa = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps'
  $aliasFile = Join-Path $wa 'tn3270-gui.exe'
  $cmd = Get-Command tn3270-gui.exe -ErrorAction SilentlyContinue
  Say "alias on PATH ($label, Get-Command tn3270-gui.exe): $(if ($cmd) { "YES $($cmd.Source)" } else { 'NO' })"
  Say "alias file $aliasFile exists ($label): $(if (Test-Path $aliasFile) { 'YES' } else { 'NO' })"
  Say "WindowsApps on this process's PATH: $(if (($env:PATH -split ';') -contains $wa) { 'YES' } else { 'NO' })"
  Get-ChildItem $wa -ErrorAction SilentlyContinue | Format-Table Name, Length -AutoSize | Out-String | Write-Host
  if ($cmd) { return $cmd.Source }
  if (Test-Path $aliasFile) { return $aliasFile }
  return $null
}

# ---------------------------------------------------------------------------------------------
# Each package in turn: install, Get-AppxPackage (also as the compressed JSON store-probe.mjs will
# parse), the alias, the alias launch, the direct launch, then uninstall before the next.
function MeasurePackage([string]$file, [string]$label) {
  if (-not $file) { Say "$label : SKIPPED (no package)"; return }
  $pkg = Install $file $label
  if ($pkg) {
    $json = Get-AppxPackage $PkgName | ConvertTo-Json -Compress
    Say "Get-AppxPackage json ($label): $json"
  }
  $alias = AliasCheck $label
  $inst = if ($pkg) { $pkg.InstallLocation } else { $null }
  if ($alias) {
    PhaseStart "$label-alias-launch"
    Launch "$label-alias" $alias $inst
    PhaseEnd "$label-alias-launch"
  } else { Say "$label alias launch: SKIPPED (no alias)" }
  if ($inst) {
    PhaseStart "$label-direct-launch"
    $direct = Join-Path $inst 'app\TN3270.exe'
    Say "$label direct exe exists: $(if (Test-Path $direct) { "YES $direct" } else { "NO $direct" })"
    Launch "$label-direct" $direct $inst
    PhaseEnd "$label-direct-launch"
    foreach ($q in (ProcsUnder $inst)) { Stop-Process -Id $q.ProcessId -Force -ErrorAction SilentlyContinue }
  } else { Say "$label direct launch: SKIPPED (not installed)" }
  foreach ($p in @(Get-AppxPackage $PkgName)) {
    try { Remove-AppxPackage -Package $p.PackageFullName -ErrorAction Stop; Say "Remove-AppxPackage ($label) $($p.PackageFullName): OK" }
    catch { Say "Remove-AppxPackage ($label) $($p.PackageFullName): FAILED $($_.Exception.Message)" }
  }
  Say "alias gone after uninstall ($label): $(if (Get-Command tn3270-gui.exe -ErrorAction SilentlyContinue) { 'NO' } else { 'YES' })"
}

# Not `Measure`: that is Measure-Object's alias, and aliases win over functions.
MeasurePackage $Appx 'default'
MeasurePackage $Appx2 'minversion'
# ---------------------------------------------------------------------------------------------
PhaseStart 'cleanup'
foreach ($p in @(Get-AppxPackage $PkgName)) {
  try { Remove-AppxPackage -Package $p.PackageFullName -ErrorAction Stop; Say "Remove-AppxPackage $($p.PackageFullName): OK" }
  catch { Say "Remove-AppxPackage $($p.PackageFullName): FAILED $($_.Exception.Message)" }
}
if ($Cert) {
  foreach ($store in 'Cert:\CurrentUser\My', 'Cert:\LocalMachine\TrustedPeople') {
    Remove-Item "$store\$($Cert.Thumbprint)" -Force -ErrorAction SilentlyContinue
    Say "certificate removed from $store : $(if (Test-Path "$store\$($Cert.Thumbprint)") { 'NO' } else { 'YES' })"
  }
}
Remove-Item -Force $Pfx, $Cer -ErrorAction SilentlyContinue
PhaseEnd 'cleanup'
Say ("duration win-appx.ps1 total: {0:N1}s" -f ((Get-Date) - $TAll).TotalSeconds)
exit 0
