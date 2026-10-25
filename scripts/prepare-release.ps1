$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
function Get-ReleaseHash([string]$File) {
  $stream = [IO.File]::OpenRead($File)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $sha.Dispose() }
}
$releaseRoot = Join-Path $projectRoot 'release'
$meta = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'package.json') | ConvertFrom-Json
$releaseVersion = $meta.version
if ($releaseVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Release version must be numeric semver.' }
$installerName = "KiCon-Live-Translate-Setup-$releaseVersion-x64.exe"
$installerFile = Join-Path $releaseRoot $installerName
$installerHash = Get-ReleaseHash $installerFile
$receipt = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'artifacts/installer-test.json') | ConvertFrom-Json
if (-not $receipt.ok -or $receipt.version -ne $releaseVersion -or $receipt.sha256 -ne $installerHash -or $receipt.installer -ne $installerName) {
  throw 'The current installer has not passed the installer test. Run npm run test:installer after the final build.'
}
& node (Join-Path $PSScriptRoot 'audit-package.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Packaged content audit failed.' }
$bundleName = "KiCon-Live-Translate-$releaseVersion-Windows-x64"
$bundleDir = [IO.Path]::GetFullPath((Join-Path $releaseRoot $bundleName))
$zipFile = Join-Path $releaseRoot "$bundleName.zip"
if (Test-Path -LiteralPath $bundleDir) { throw 'Bundle folder already exists. Preserve or move the earlier delivery before making another.' }
if (Test-Path -LiteralPath $zipFile) { throw 'Delivery ZIP already exists. It will not be overwritten.' }
New-Item -ItemType Directory -Path (Join-Path $bundleDir 'licenses') | Out-Null
# Explicit allowlist: never archive the release directory or a user's data folder.
$copies = [ordered]@{
  $installerName = $installerFile
  '请先阅读-安装与使用.txt' = (Join-Path $projectRoot 'docs/安装与迁移说明.txt')
  '更新说明.txt' = (Join-Path $projectRoot 'docs/更新说明.txt')
  '第三方组件说明.txt' = (Join-Path $projectRoot 'docs/第三方组件说明.txt')
  'licenses/Electron-LICENSE.txt' = (Join-Path $releaseRoot 'win-unpacked/LICENSE.electron.txt')
  'licenses/Chromium-LICENSES.html' = (Join-Path $releaseRoot 'win-unpacked/LICENSES.chromium.html')
  'licenses/ws-LICENSE.txt' = (Join-Path $projectRoot 'node_modules/ws/LICENSE')
}
foreach ($entry in $copies.GetEnumerator()) { Copy-Item -LiteralPath $entry.Value -Destination (Join-Path $bundleDir $entry.Key) }
$utf8 = New-Object Text.UTF8Encoding($false)
$gitBase = (& git -C $projectRoot rev-parse HEAD).Trim()
$dirty = @(& git -C $projectRoot status --porcelain).Count -gt 0
$componentElectron = (Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'node_modules/electron/package.json') | ConvertFrom-Json).version
$componentWs = (Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'node_modules/ws/package.json') | ConvertFrom-Json).version
$manifest = [ordered]@{
  product = 'KiCon Live Translate'; version = $releaseVersion; platform = 'Windows x64'
  preparedAt = [DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(8)).ToString('o')
  sourceBaseCommit = $gitBase; sourceHasUncommittedChanges = $dirty
  installer = $installerName; installerSHA256 = $installerHash
  codeSigned = $false; cloudAPIKeyIncluded = $false; personalSettingsIncluded = $false; meetingRecordsIncluded = $false
  components = @{ electron = $componentElectron; ws = $componentWs }
  validation = @{ installation = $receipt.install; launchAndRestart = $receipt.firstLaunchAndRestart; uninstall = $receipt.uninstall; testedAt = $receipt.testedAt; scope = 'Local Windows tests; not certification for all hardware or a clean Windows VM.' }
}
[IO.File]::WriteAllText((Join-Path $bundleDir '交付清单.json'), ($manifest | ConvertTo-Json -Depth 6), $utf8)
$payload = @(Get-ChildItem -LiteralPath $bundleDir -Recurse -File | Sort-Object FullName)
$hashes = @{}
$hashLines = foreach ($file in $payload) {
  $relative = $file.FullName.Substring($bundleDir.Length + 1).Replace('\', '/')
  $hash = Get-ReleaseHash $file.FullName
  $hashes[$relative] = $hash
  "$hash  $relative"
}
$sumsFile = Join-Path $bundleDir 'SHA256SUMS.txt'
[IO.File]::WriteAllText($sumsFile, ($hashLines -join "`r`n") + "`r`n", $utf8)
$hashes['SHA256SUMS.txt'] = Get-ReleaseHash $sumsFile
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($bundleDir, $zipFile, [IO.Compression.CompressionLevel]::Optimal, $false, [Text.Encoding]::UTF8)
$zip = [IO.Compression.ZipFile]::OpenRead($zipFile)
try {
  if ($zip.Entries.Count -ne $hashes.Count) { throw 'Unexpected ZIP entry count.' }
  $seen = @{}
  foreach ($entry in $zip.Entries) {
    $name = $entry.FullName.Replace('\', '/')
    if (-not $hashes.ContainsKey($name) -or $seen.ContainsKey($name)) { throw 'Unexpected or duplicate ZIP entry.' }
    $seen[$name] = $true
    $stream = $entry.Open()
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
    if ($hash -ne $hashes[$name]) { throw "ZIP payload checksum failed: $name" }
  }
} finally { $zip.Dispose() }
$zipHash = Get-ReleaseHash $zipFile
[IO.File]::WriteAllText("$zipFile.sha256.txt", "$zipHash  $bundleName.zip`r`n", $utf8)
@{ ok = $true; version = $releaseVersion; zip = "$bundleName.zip"; sha256 = $zipHash; entries = $hashes.Count; bytes = (Get-Item -LiteralPath $zipFile).Length } | ConvertTo-Json | Set-Content -Encoding utf8 -LiteralPath (Join-Path $projectRoot 'artifacts/delivery-test.json')
Write-Output "PASS: $($hashes.Count) allowlisted ZIP entries verified by SHA-256."
Write-Output $zipFile
