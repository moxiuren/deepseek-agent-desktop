<# DeepSeek-Agent one-click installer (Windows, PowerShell 5.1+, no extra tools).
 #
 # Fresh machine, one line in terminal (admin NOT required):
 #   powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/moxiuren/deepseek-agent-desktop/main/windows/installer/install.ps1 | iex"
 #
 # With options, download first:
 #   Invoke-WebRequest -Uri https://raw.githubusercontent.com/moxiuren/deepseek-agent-desktop/main/windows/installer/install.ps1 -OutFile install.ps1
 #   powershell -ExecutionPolicy Bypass -File install.ps1 [-Tag v1.0.9] [-Zip C:\path\to.zip] [-Dir D:\app] [-NoLaunch] [-CheckOnly]
 #
 # Flow: .NET 8 desktop runtime + WebView2 check (winget auto-install),
 # newest release incl. prereleases that carries a win-x64/trial .zip,
 # stop app, timestamp backup (keep 3), extract, drop stale ThreadJob shell,
 # seed user plugins (missing only, whale.js excluded), shortcuts, launch.
 # Console output is plain ASCII (no emoji) for legacy consoles.
#>
[CmdletBinding()]
param(
    [string]$Tag = "",
    [string]$Zip = "",
    [string]$Dir = "",
    [switch]$NoLaunch,
    [switch]$CheckOnly,
    [int]$KeepBackups = 3
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Repo = 'moxiuren/deepseek-agent-desktop'
$AppName = 'DeepSeek-Agent'
$ExeName = 'DeepSeek.exe'
$Wv2Key = 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'

function Step($m) { Write-Output "[..] $m" }
function Ok($m)   { Write-Output "[OK] $m" }
function Skip($m) { Write-Output "[SKIP] $m" }
function Die($m)  { Write-Output "[FAIL] $m"; exit 1 }

Write-Output 'DeepSeek-Agent one-click installer'
Write-Output "repo: $Repo"

# 1. winget presence (best effort)
$winget = $null -ne (Get-Command winget -ErrorAction SilentlyContinue)
if (-not $winget) { Write-Output '[WARN] winget not found; dependency auto-install disabled' }

# 2. .NET 8 desktop runtime
Step 'checking .NET 8 desktop runtime ...'
$dotnetOk = $false
try { $rts = dotnet --list-runtimes 2>$null; $dotnetOk = ($rts | Select-String 'Microsoft.WindowsDesktop.App 8\.' -Quiet) } catch {}
if ($dotnetOk) { Ok '.NET 8 desktop runtime present' }
elseif ($CheckOnly) { Die 'missing: .NET 8 Desktop Runtime' }
elseif ($winget) {
    Step 'installing .NET 8 Desktop Runtime via winget ...'
    winget install --id Microsoft.DotNet.DesktopRuntime.8 --silent --accept-package-agreements --accept-source-agreements
    $rts = dotnet --list-runtimes 2>$null
    if (-not ($rts | Select-String 'Microsoft.WindowsDesktop.App 8\.' -Quiet)) { Die 'could not install .NET 8 Desktop Runtime' }
    Ok '.NET 8 desktop runtime present'
} else { Die 'missing .NET 8 Desktop Runtime and no winget' }

# 3. WebView2
Step 'checking WebView2 runtime ...'
$wv2 = (Test-Path "HKLM:\$Wv2Key") -or (Test-Path "HKCU:\$Wv2Key")
if ($wv2) { Ok 'WebView2 runtime present' }
elseif ($CheckOnly) { Die 'missing: WebView2 runtime' }
elseif ($winget) {
    Step 'installing WebView2 via winget ...'
    winget install --id Microsoft.EdgeWebView2Runtime --silent --accept-package-agreements --accept-source-agreements
    $wv2 = (Test-Path "HKLM:\$Wv2Key") -or (Test-Path "HKCU:\$Wv2Key")
    if (-not $wv2) { Die 'could not install WebView2 runtime' }
    Ok 'WebView2 runtime present'
} else { Die 'missing WebView2 runtime and no winget' }

# 4. install dir + package resolution
$installDir = if ($Dir) { $Dir } else { Join-Path $env:LOCALAPPDATA $AppName }
if ($Zip) {
    if (-not (Test-Path -LiteralPath $Zip)) { Die "local zip not found: $Zip" }
    $zipPath = (Resolve-Path -LiteralPath $Zip).Path
    $label = "local $zipPath"
} else {
    Step 'resolving latest release ...'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $hdr = @{ 'User-Agent' = 'deepseek-agent-installer' }
    if ($Tag) { $rels = @(Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Tag" -Headers $hdr) }
    else { $rels = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=20" -Headers $hdr }
    $asset = $null; $relTag = ''
    foreach ($r in $rels) {
        if ($r.draft) { continue }
        $hit = $r.assets | Where-Object { $_.name -like '*.zip' -and ($_.name -like '*win-x64*' -or $_.name -like '*win64*' -or $_.name -like '*trial*') } | Select-Object -First 1
        if ($hit) { $asset = $hit; $relTag = $r.tag_name; break }
    }
    if (-not $asset) { Die 'no release with a win-x64/trial .zip asset found' }
    Ok ("release $relTag asset $($asset.name) ($($asset.size) bytes)")
    $label = "$relTag / $($asset.name)"
    if ($CheckOnly) { Write-Output '[OK] check-only: machine ready, package resolvable; nothing changed'; exit 0 }
    $zipPath = Join-Path $env:TEMP $asset.name
    Step ("downloading " + $asset.browser_download_url + " ...")
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath -UseBasicParsing
    $got = (Get-Item -LiteralPath $zipPath).Length
    if ($asset.size -gt 0 -and $got -ne $asset.size) { Die "size mismatch: got $got want $($asset.size)" }
    Ok "downloaded $got bytes"
}
if ($CheckOnly) { Write-Output '[OK] check-only: machine ready; nothing changed'; exit 0 }

# 5. stop running app
Step 'stopping running DeepSeek.exe (if any) ...'
Stop-Process -Name ([IO.Path]::GetFileNameWithoutExtension($ExeName)) -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# 6. backup existing install
if (Test-Path -LiteralPath $installDir) {
    $parent = Split-Path -Parent $installDir
    $bak = Join-Path $parent ("backup-" + (Get-Date -Format yyyyMMdd-HHmmss))
    Step "backing up $installDir -> $bak ..."
    Move-Item -LiteralPath $installDir -Destination $bak -Force
    Ok 'backup done'
    $parent = Split-Path -Parent $installDir
    $baks = Get-ChildItem -LiteralPath $parent -Directory -Filter 'backup-*' -ErrorAction SilentlyContinue | Sort-Object Name
    while ($baks.Count -gt $KeepBackups) { Remove-Item -LiteralPath $baks[0].FullName -Recurse -Force; $baks = @($baks | Select-Object -Skip 1) }
} else {
    $parent = Split-Path -Parent $installDir
    if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
}

# 7. extract
Step "extracting $zipPath -> $installDir ..."
Expand-Archive -Path $zipPath -DestinationPath $installDir -Force
if (-not (Test-Path -LiteralPath (Join-Path $installDir $ExeName))) { Die 'extract failed: DeepSeek.exe missing' }
Ok 'extracted'

# 8. drop stale ThreadJob rename-shell if the package carries one
$stale = Join-Path $installDir 'Modules\ThreadJob'
if (Test-Path -LiteralPath $stale) { Remove-Item -LiteralPath $stale -Recurse -Force; Ok 'removed stale Modules\ThreadJob shell' }

# 9. seed user plugins (missing only; whale.js superseded by whale-dsh.js)
$srcPlug = Join-Path $installDir 'plugins'
$dstPlug = Join-Path ([Environment]::GetFolderPath('MyDocuments')) "$AppName\plugins"
if (Test-Path -LiteralPath $srcPlug) {
    New-Item -ItemType Directory -Path $dstPlug -Force | Out-Null
    $n = 0
    Get-ChildItem -LiteralPath $srcPlug -File -Filter '*.js' | ForEach-Object {
        if ($_.Name -eq 'whale.js') { return }
        $dst = Join-Path $dstPlug $_.Name
        if (-not (Test-Path -LiteralPath $dst)) { Copy-Item -LiteralPath $_.FullName -Destination $dst -Force; $n++ }
    }
    if ($n -gt 0) { Ok "seeded $n user plugin(s)" } else { Skip 'user plugins already present' }
}

# 10. shortcuts
$exe = Join-Path $installDir $ExeName
$wsh = New-Object -ComObject WScript.Shell
foreach ($link in @((Join-Path ([Environment]::GetFolderPath('Desktop')) 'DeepSeek Agent.lnk'),
    (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Microsoft\Windows\Start Menu\Programs\DeepSeek Agent.lnk'))) {
    try {
        $s = $wsh.CreateShortcut($link); $s.TargetPath = $exe; $s.WorkingDirectory = $installDir; $s.IconLocation = "$exe,0"; $s.Save()
    } catch { Write-Output "[WARN] shortcut failed: $link" }
}
Ok 'shortcuts ready'

# 11. launch
if (-not $NoLaunch) {
    Step 'launching ...'
    try { Start-Process -FilePath $exe | Out-Null; Ok 'launched' }
    catch { Write-Output '[WARN] launch failed (start it manually)' }
}

Write-Output "[DONE] installed $label -> $installDir"
