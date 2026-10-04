$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Join-Path $env:LOCALAPPDATA 'CodxRemote'
$Agent = Join-Path $Root 'agent.mjs'
$Backend = 'https://codx-remote-api-zrider.onrender.com'
$AgentUrl = "$Backend/agent/agent.mjs"

function Ok($Text) { Write-Host "[OK] $Text" -ForegroundColor Green }
function Step($Text) { Write-Host " - $Text" -ForegroundColor DarkGray }

Clear-Host
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "                       CODX REMOTE" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Private Remote MCP for Windows" -ForegroundColor Cyan
Write-Host ""

New-Item -ItemType Directory -Force -Path $Root | Out-Null

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
    Step "Node.js nao encontrado. Instalando Node.js LTS..."
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) { throw "winget nao encontrado. Instale Node.js LTS e tente novamente." }
    & winget.exe install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { throw "Node.js foi instalado. Feche e abra o PowerShell e execute novamente." }
    Ok "Node.js instalado"
} else {
    Ok "Node.js encontrado"
}

Step "Configurando backend Codx Remote..."
[Environment]::SetEnvironmentVariable('CODX_REMOTE_URL',$Backend,'User')
$env:CODX_REMOTE_URL=$Backend
Ok "Backend configurado"

Step "Baixando o agente Codx Remote..."
Invoke-WebRequest -Uri $AgentUrl -OutFile $Agent -UseBasicParsing
if (-not (Test-Path $Agent)) { throw "Falha ao baixar o agente Codx Remote." }
Ok "Agente atualizado"

Write-Host ""
Write-Host "Iniciando Codx Remote..." -ForegroundColor Cyan
Write-Host "Mantenha esta janela aberta. Ctrl+C desconecta." -ForegroundColor DarkGray
Write-Host ""

& node.exe $Agent
