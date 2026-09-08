$ErrorActionPreference = "Stop"

$HostName = "im.byk.local_triage"
$ExtensionId = "local-triage@byk.im"
$SourceDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallParent = Join-Path $env:LOCALAPPDATA "LocalTriage"
$InstallDirectory = Join-Path $InstallParent "NativeHost"
$StagingDirectory = Join-Path $InstallParent ("NativeHost.installing-" + [guid]::NewGuid().ToString("N"))
$Executable = Join-Path $InstallDirectory "LocalTriageNativeHost.exe"
$Manifest = Join-Path $InstallDirectory "$HostName.json"
$RegistryKey = "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName"

Write-Host "Installing Local Triage native CPU companion..."
Remove-Item $RegistryKey -Force -ErrorAction SilentlyContinue
Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessName -like "LocalTriageDirectMLHost*" -or $_.ProcessName -like "LocalTriageNativeHost*" } |
  Stop-Process -Force -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Path $StagingDirectory -Force | Out-Null
try {
  Get-ChildItem $SourceDirectory -Force |
    Where-Object { $_.Name -notin @("install.ps1", "uninstall.ps1") } |
    Copy-Item -Destination $StagingDirectory -Recurse -Force

  $RequiredFiles = @(
    "LocalTriageNativeHost.exe",
    "node_modules\@huggingface\transformers\package.json",
    "node_modules\onnxruntime-node\package.json",
    "node_modules\onnxruntime-node\dist\index.js",
    "node_modules\onnxruntime-node\bin\napi-v6\win32\x64\onnxruntime.dll",
    "node_modules\onnxruntime-node\bin\napi-v6\win32\x64\onnxruntime_binding.node"
  )
  foreach ($RelativePath in $RequiredFiles) {
    if (-not (Test-Path (Join-Path $StagingDirectory $RelativePath) -PathType Leaf)) {
      throw "Companion archive is incomplete: missing $RelativePath"
    }
  }

  Get-ChildItem $StagingDirectory -Recurse -File |
    Unblock-File -ErrorAction SilentlyContinue

  if (Test-Path $InstallDirectory) {
    Remove-Item $InstallDirectory -Recurse -Force
  }
  Move-Item $StagingDirectory $InstallDirectory
} finally {
  if (Test-Path $StagingDirectory) {
    Remove-Item $StagingDirectory -Recurse -Force
  }
}

$NativeManifest = [ordered]@{
  name = $HostName
  description = "Local Triage native CPU event-model companion"
  path = $Executable
  type = "stdio"
  allowed_extensions = @($ExtensionId)
}
$ManifestJson = $NativeManifest | ConvertTo-Json -Depth 4
$Utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($Manifest, $ManifestJson, $Utf8WithoutBom)

New-Item -Path $RegistryKey -Force | Out-Null
Set-Item -Path $RegistryKey -Value $Manifest

if (-not (Test-Path $Executable)) {
  throw "The companion executable was not copied to $Executable"
}

Write-Host "Installed to $InstallDirectory"
Write-Host "Restart Thunderbird, then use Local Triage Settings > Download and test event model."
