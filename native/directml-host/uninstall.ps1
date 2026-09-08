$ErrorActionPreference = "Stop"

$HostName = "im.byk.local_triage"
$InstallParent = Join-Path $env:LOCALAPPDATA "LocalTriage"
$RegistryKey = "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName"

Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessName -like "LocalTriageDirectMLHost*" -or $_.ProcessName -like "LocalTriageNativeHost*" } |
  Stop-Process -Force -ErrorAction SilentlyContinue
Remove-Item -Path $RegistryKey -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path (Join-Path $InstallParent "DirectMLHost") -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path (Join-Path $InstallParent "NativeHost") -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Local Triage native companion removed."
