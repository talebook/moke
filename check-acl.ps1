$f = Get-ChildItem 'C:\Users\Administrator\Documents\Github\moke\readest\target\x86_64-unknown-linux-ohos\debug\build' -Filter 'capabilities.json' -Recurse | Where-Object { $_.FullName -match 'Readest' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Output ("FILE: " + $f.FullName)
Write-Output ("MTIME: " + $f.LastWriteTime)
$j = Get-Content $f.FullName -Raw | ConvertFrom-Json
$ohos = $j.ohos
Write-Output ("WINDOWS: " + ($ohos.windows -join ','))
Write-Output "--- fs permissions ---"
$ohos.permissions | Where-Object { $_ -match 'fs' } | ForEach-Object {
  if ($_.identifier) { Write-Output ("SET/PERM: " + $_.identifier + " allow=" + ($_.allow | ConvertTo-Json -Compress)) } else { Write-Output ("STRING: " + $_) }
}
