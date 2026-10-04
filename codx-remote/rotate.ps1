$ErrorActionPreference = 'Stop'
$Root = Join-Path $env:LOCALAPPDATA 'CodxRemote'
$ConfigPath = Join-Path $Root 'config.json'

if (-not (Test-Path $ConfigPath)) {
  throw "Codx Remote config nao encontrada. Inicie o agente primeiro."
}

$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$headers = @{ Authorization = "Bearer $($config.deviceSecret)" }
$body = @{ deviceId = $config.deviceId } | ConvertTo-Json

$result = Invoke-RestMethod -Method POST -Uri 'https://codx-remote-zrider.vercel.app/api/device?action=rotate_links' -Headers $headers -ContentType 'application/json' -Body $body

$config.mcpUrl = $result.mcpUrl
$config.manageUrl = $result.manageUrl
$config | ConvertTo-Json -Depth 5 | Set-Content -Path $ConfigPath -Encoding UTF8

Write-Host ""
Write-Host "[OK] Links privados rotacionados." -ForegroundColor Green
Write-Host "[OK] Links antigos invalidados." -ForegroundColor Green
Write-Host "[OK] Novos links salvos no config local." -ForegroundColor Green
Write-Host ""
Write-Host "Nao compartilhe o arquivo config.json." -ForegroundColor Yellow
