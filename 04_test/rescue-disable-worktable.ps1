<#
  rescue-disable-worktable.ps1
  Purpose: if the dsh-worktable plugin makes DSH Desktop fail to start, remove it from the
           profile load list so DSH can boot again. Sessions/history live elsewhere and are NOT touched.

  What it does: back up package.json -> delete "dsh-worktable" from dsh.profile.bundles ->
                write back -> re-parse to validate JSON.
  It only edits bundles (the sole load list). It does NOT delete dependencies or node_modules:
  deleting/renaming the plugin folder triggers "profile package identity is invalid" and breaks startup again.

  Usage (fully quit DSH Desktop first):
      powershell -ExecutionPolicy Bypass -File "F:\AI\工作区\dsh-worktable\04_test\rescue-disable-worktable.ps1"
  Optional: -ProfileDir <dir> (default desktop), -DryRun (preview only).
#>
param(
  [string]$ProfileDir = "$env:USERPROFILE\.dsh-beta\profiles\desktop",
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$pkg = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path $pkg)) { throw "profile package.json not found: $pkg" }

$raw = Get-Content -LiteralPath $pkg -Raw -Encoding UTF8
$manifest = $raw | ConvertFrom-Json
if ($null -eq $manifest.dsh -or $null -eq $manifest.dsh.profile -or $null -eq $manifest.dsh.profile.bundles) {
  throw "package.json has no dsh.profile.bundles array"
}

$before = @($manifest.dsh.profile.bundles)
if (-not ($before -contains 'dsh-worktable')) {
  Write-Host "dsh-worktable is already absent from bundles; nothing to do." -ForegroundColor Yellow
  exit 0
}
$after = @($before | Where-Object { $_ -ne 'dsh-worktable' })

Write-Host ("bundles: {0} -> {1} (removed dsh-worktable)" -f $before.Count, $after.Count)
if ($DryRun) { Write-Host "DryRun: no write performed." -ForegroundColor Cyan; exit 0 }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item -LiteralPath $pkg -Destination "$pkg.bak-$stamp" -Force
Write-Host "backup: $pkg.bak-$stamp"

$manifest.dsh.profile.bundles = $after
$json = $manifest | ConvertTo-Json -Depth 100
[System.IO.File]::WriteAllText($pkg, $json, (New-Object System.Text.UTF8Encoding($false)))

$check = (Get-Content -LiteralPath $pkg -Raw -Encoding UTF8) | ConvertFrom-Json
if (@($check.dsh.profile.bundles) -contains 'dsh-worktable') { throw "dsh-worktable still present after write; restore from backup!" }
Write-Host "OK: removed from load list, JSON valid. Restart DSH Desktop (worktable will not load; sessions unaffected)." -ForegroundColor Green
