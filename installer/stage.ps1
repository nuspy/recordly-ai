<#
.SYNOPSIS
    Prepares the folder that RecordlyAI.ifp packages: release\installforge\stage\app\.
    It does NOT build the setup: open installer\RecordlyAI.ifp in InstallForge for that.

.DESCRIPTION
    Run it after every `npm run build:win:installforge` (electron-builder writes new files, so an older stage goes stale).
    InstallForge installs a [Folder] entry as a subfolder named like the folder, hence the folder is called "app":
    <InstallPath>\app\RecordlyAI.exe, <InstallPath>\app\skills\recordly-ai-demo, <InstallPath>\app\prereq\vc_redist.x64.exe.
    Files are hard-linked (same NTFS volume, no extra disk space); if that fails they are copied.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Unpacked = Join-Path $Root 'release\win-unpacked'
$Stage = Join-Path $Root 'release\installforge\stage\app'

if (-not (Test-Path (Join-Path $Unpacked 'RecordlyAI.exe'))) {
    throw "$Unpacked\RecordlyAI.exe not found: run `npm run build:win:installforge` first"
}

function Add-Tree([string]$From, [string]$To, [string[]]$ExcludeDirs = @()) {
    $from = (Resolve-Path $From).Path.TrimEnd('\')
    foreach ($f in Get-ChildItem -LiteralPath $from -Recurse -File -Force) {
        $rel = $f.FullName.Substring($from.Length + 1)
        $skip = $false
        foreach ($d in $ExcludeDirs) { if ($rel -like "$d\*" -or $rel -like "*\$d\*") { $skip = $true; break } }
        if ($skip) { continue }
        $dst = Join-Path $To $rel
        New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null
        try { New-Item -ItemType HardLink -Path $dst -Target $f.FullName | Out-Null }
        catch { Copy-Item -LiteralPath $f.FullName -Destination $dst }
    }
}

if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Force $Stage | Out-Null

# the app: macOS helpers are useless on Windows
Add-Tree $Unpacked $Stage @('darwin-arm64', 'darwin-x64')

# the agent skill (no caches)
Add-Tree (Join-Path $Root 'skills\recordly-ai-demo') (Join-Path $Stage 'skills\recordly-ai-demo') @('__pycache__', '.narration-cache')

# licenses next to the program
foreach ($n in 'LICENSE.md', 'THIRD_PARTY_NOTICES.md') { Copy-Item (Join-Path $Root $n) $Stage }

# Microsoft Visual C++ Redistributable x64 (whisper-cli.exe and the native helpers link the MSVC runtime dynamically)
$redist = Get-ChildItem 'C:\Program Files\Microsoft Visual Studio\*\*\VC\Redist\MSVC\*\vc_redist.x64.exe' -ErrorAction SilentlyContinue |
    Sort-Object { [version]($_.FullName -replace '^.*\\MSVC\\(\d+(\.\d+)*)\\.*$', '$1' -replace '^\D.*$', '0.0') } -Descending | Select-Object -First 1
if (-not $redist) { throw 'vc_redist.x64.exe not found under Visual Studio; download https://aka.ms/vc14/vc_redist.x64.exe into the stage prereq folder' }
$sig = Get-AuthenticodeSignature $redist.FullName
if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Microsoft Corporation') { throw "the signature of $($redist.FullName) is not Microsoft's ($($sig.Status))" }
$prereq = Join-Path $Stage 'prereq'
New-Item -ItemType Directory -Force $prereq | Out-Null
Copy-Item $redist.FullName $prereq

$files = Get-ChildItem $Stage -Recurse -File
"{0} files, {1:N0} MB (logical) in {2}" -f $files.Count, (($files | Measure-Object Length -Sum).Sum / 1MB), $Stage
