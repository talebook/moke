$f = "C:\Users\Administrator\Documents\Github\moke\readest\target\x86_64-unknown-linux-ohos\debug\build\Readest-5c54a8c5c968d727\out\capabilities.json"
$j = Get-Content $f -Raw | ConvertFrom-Json
Write-Output ("IDENTIFIERS: " + (($j.PSObject.Properties.Name) -join ','))
$c = $j.ohos
Write-Output ("LOCAL: " + $c.local)
Write-Output ("WINDOWS: " + ($c.windows -join ','))
if ($c.remote) {
  Write-Output ("REMOTE: " + ($c.remote.urls -join ','))
} else {
  Write-Output "REMOTE: <none>"
}
