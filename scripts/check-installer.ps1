$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
function Get-ReleaseHash([string]$File) {
  $stream = [IO.File]::OpenRead($File)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $sha.Dispose() }
}
$releaseVersion = (Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'package.json') | ConvertFrom-Json).version
$installerFile = Join-Path $projectRoot "release/KiCon-Live-Translate-Setup-$releaseVersion-x64.exe"
$installerHash = Get-ReleaseHash $installerFile
$existing = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Get-ItemProperty | Where-Object { $_.DisplayName -like 'KiCon Live Translate*' }
if ($existing) { throw 'An existing KiCon installation was found. Use a separate Windows test account for installer verification.' }
foreach ($shortcutFolder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  if (Test-Path -LiteralPath (Join-Path $shortcutFolder 'KiCon 实时同传.lnk')) { throw 'An existing KiCon shortcut was found. Installer verification will not overwrite it.' }
}
$artifactRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'artifacts'))
$testTarget = [System.IO.Path]::GetFullPath((Join-Path $artifactRoot ('install-test-' + [guid]::NewGuid().ToString('N'))))
if (-not $testTarget.StartsWith($artifactRoot + [System.IO.Path]::DirectorySeparatorChar)) { throw 'Test installation must stay inside artifacts.' }
$installedExe = Join-Path $testTarget 'KiCon Live Translate.exe'
$installProcess = Start-Process -FilePath $installerFile -ArgumentList @('/S', '/currentuser', "/D=$testTarget") -WindowStyle Hidden -PassThru -Wait
if ($installProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $installedExe)) { throw "Installer failed: $($installProcess.ExitCode)" }
$tested = $false
try {
  $entry = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Get-ItemProperty | Where-Object { $_.DisplayName -like 'KiCon Live Translate*' }
  if (-not $entry) { throw 'Installer did not register the application.' }
  & node (Join-Path $PSScriptRoot 'check-package.cjs') "--exe=$installedExe"
  if ($LASTEXITCODE -ne 0) { throw 'Installed application test failed.' }
  $tested = $true
} finally {
  # Uninstall only the temporary installation created above; never touch user data.
  $uninstallerFile = Join-Path $testTarget 'Uninstall KiCon Live Translate.exe'
  if (Test-Path -LiteralPath $uninstallerFile) {
    $uninstallProcess = Start-Process -FilePath $uninstallerFile -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait
    if ($uninstallProcess.ExitCode -ne 0) { throw "Uninstaller failed: $($uninstallProcess.ExitCode)" }
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ((Test-Path -LiteralPath $installedExe) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
  }
}
if (Test-Path -LiteralPath $installedExe) { throw 'Uninstaller did not remove the temporary application.' }
$remaining = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Get-ItemProperty | Where-Object { $_.DisplayName -like 'KiCon Live Translate*' }
if ($remaining) { throw 'Uninstaller left its registration behind.' }
@{ ok = $tested; version = $releaseVersion; sha256 = $installerHash; installer = (Split-Path $installerFile -Leaf); install = 'passed'; firstLaunchAndRestart = 'passed without external Node/npm'; uninstall = 'passed'; testedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $artifactRoot 'installer-test.json')
Write-Output 'PASS: full NSIS installation, installed app first launch/restart, and uninstallation.'
