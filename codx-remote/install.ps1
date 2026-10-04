$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Join-Path $env:LOCALAPPDATA 'CodxRemote'
$Bin = Join-Path $Root 'bin'
$ConfigPath = Join-Path $Root 'config.json'
$ProfileMarker = Join-Path $Root 'profile.ready'
New-Item -ItemType Directory -Force -Path $Root,$Bin | Out-Null

function Write-Step([string]$Text) { Write-Host " - $Text" -ForegroundColor DarkGray }
function Write-Ok([string]$Text) { Write-Host "✅ $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "⚠️  $Text" -ForegroundColor Yellow }

Clear-Host
Write-Host @'
 ██████╗ ██████╗ ██████╗ ██╗  ██╗    ██████╗ ███████╗███╗   ███╗ ██████╗ ████████╗███████╗
██╔════╝██╔═══██╗██╔══██╗╚██╗██╔╝    ██╔══██╗██╔════╝████╗ ████║██╔═══██╗╚══██╔══╝██╔════╝
██║     ██║   ██║██║  ██║ ╚███╔╝     ██████╔╝█████╗  ██╔████╔██║██║   ██║   ██║   █████╗
██║     ██║   ██║██║  ██║ ██╔██╗     ██╔══██╗██╔══╝  ██║╚██╔╝██║██║   ██║   ██║   ██╔══╝
╚██████╗╚██████╔╝██████╔╝██╔╝ ██╗    ██║  ██║███████╗██║ ╚═╝ ██║╚██████╔╝   ██║   ███████╗
 ╚═════╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝    ╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝ ╚═════╝    ╚═╝   ╚══════╝
'@ -ForegroundColor Cyan
Write-Host ""
Write-Host "🌐 Private MCP Connection" -ForegroundColor Cyan
Write-Host ""

# Node.js / npx
$npx = Get-Command npx.cmd -ErrorAction SilentlyContinue
if (-not $npx) {
  Write-Step "Node.js não encontrado. Instalando Node.js LTS..."
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw "winget não foi encontrado. Instale o Node.js LTS e execute este comando novamente."
  }
  & winget.exe install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
  $npx = Get-Command npx.cmd -ErrorAction SilentlyContinue
  if (-not $npx) { throw "Node.js foi instalado, mas o npx ainda não apareceu no PATH. Feche e abra o PowerShell e rode o comando novamente." }
  Write-Ok "Node.js instalado"
} else {
  Write-Ok "Node.js / npx encontrado"
}

# OpenAI tunnel-client
$TunnelExe = Join-Path $Bin 'tunnel-client.exe'
if (-not (Test-Path $TunnelExe)) {
  Write-Step "Baixando o Secure MCP tunnel-client oficial da OpenAI..."
  $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/openai/tunnel-client/releases/latest' -Headers @{ 'User-Agent'='CodxRemoteInstaller' }
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
  $asset = $release.assets | Where-Object { $_.name -match "^tunnel-client-v.*-windows-$arch\.zip$" } | Select-Object -First 1
  $sums = $release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' } | Select-Object -First 1
  if (-not $asset) { throw "Não encontrei o pacote Windows $arch na release mais recente do tunnel-client." }

  $zip = Join-Path $env:TEMP $asset.name
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing

  if ($sums) {
    $sumFile = Join-Path $env:TEMP 'codx-tunnel-SHA256SUMS.txt'
    Invoke-WebRequest -Uri $sums.browser_download_url -OutFile $sumFile -UseBasicParsing
    $line = Get-Content $sumFile | Where-Object { $_ -match [regex]::Escape($asset.name) } | Select-Object -First 1
    if ($line) {
      $expected = ($line -split '\s+')[0].Trim().ToLowerInvariant()
      $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant()
      if ($expected -ne $actual) { throw "Falha na verificação SHA256 do tunnel-client." }
      Write-Ok "SHA256 do tunnel-client verificado"
    }
  }

  $extract = Join-Path $env:TEMP ('codx-tunnel-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $extract | Out-Null
  Expand-Archive -Path $zip -DestinationPath $extract -Force
  $found = Get-ChildItem -Path $extract -Recurse -Filter 'tunnel-client.exe' | Select-Object -First 1
  if (-not $found) { throw "tunnel-client.exe não encontrado dentro do pacote." }
  Copy-Item $found.FullName $TunnelExe -Force
  Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  Write-Ok "OpenAI tunnel-client instalado"
} else {
  Write-Ok "OpenAI tunnel-client encontrado"
}

# First-time credentials. Runtime API key is stored using Windows DPAPI (current user).
$cfg = $null
if (Test-Path $ConfigPath) {
  try { $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json } catch { $cfg = $null }
}

if (-not $cfg -or -not $cfg.tunnelId -or -not $cfg.apiKeyProtected) {
  Write-Host ""
  Write-Host "🔐 Primeira configuração" -ForegroundColor Cyan
  Write-Host "Você precisa de um Tunnel ID e uma Runtime API key da OpenAI."
  Write-Host "Guia: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels" -ForegroundColor DarkGray
  Write-Host ""

  $TunnelId = Read-Host 'Tunnel ID (tunnel_...)'
  if ([string]::IsNullOrWhiteSpace($TunnelId)) { throw "Tunnel ID não informado." }

  $SecureKey = Read-Host 'Runtime API key' -AsSecureString
  if ($SecureKey.Length -eq 0) { throw "Runtime API key não informada." }
  $Protected = ConvertFrom-SecureString $SecureKey

  $cfg = [pscustomobject]@{
    tunnelId = $TunnelId.Trim()
    apiKeyProtected = $Protected
    createdAt = (Get-Date).ToString('o')
  }
  $cfg | ConvertTo-Json | Set-Content -Path $ConfigPath -Encoding UTF8
  Write-Ok "Configuração salva em $ConfigPath"
}

$SecureStored = ConvertTo-SecureString $cfg.apiKeyProtected
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureStored)
try {
  $ApiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}
$env:CONTROL_PLANE_API_KEY = $ApiKey
$env:CONTROL_PLANE_TUNNEL_ID = [string]$cfg.tunnelId

if (-not (Test-Path $ProfileMarker)) {
  Write-Step "Criando perfil MCP local 'codx-remote'..."
  & $TunnelExe init --sample sample_mcp_stdio_local --profile codx-remote --tunnel-id $env:CONTROL_PLANE_TUNNEL_ID --mcp-command "npx.cmd -y @wonderwhy-er/desktop-commander@latest"
  if ($LASTEXITCODE -ne 0) { throw "Falha ao criar o perfil do tunnel-client." }
  New-Item -ItemType File -Force -Path $ProfileMarker | Out-Null
  Write-Ok "Perfil criado"
}

Write-Step "Validando MCP e túnel..."
& $TunnelExe doctor --profile codx-remote --explain
if ($LASTEXITCODE -ne 0) {
  Write-Warn "O diagnóstico encontrou um problema. Confira o Tunnel ID, a Runtime API key e as permissões do túnel."
  Write-Host "Você pode apagar $ConfigPath para refazer a autenticação." -ForegroundColor DarkGray
  throw "Codx Remote não está pronto."
}

Write-Host ""
Write-Ok "Codx Remote está pronto"
Write-Host "   Device: $env:COMPUTERNAME"
Write-Host "   Status: Online enquanto esta janela estiver aberta"
Write-Host "   Manager local: http://127.0.0.1:8080/ui"
Write-Host ""
Write-Host "┌─ Next" -ForegroundColor Cyan
Write-Host "│ No ChatGPT: Plugins → Add/Create MCP → Connection: Tunnel"
Write-Host "│ Selecione o Tunnel ID: $($cfg.tunnelId)"
Write-Host "│ Depois volte ao chat e use o app MCP."
Write-Host "└─ Pressione Ctrl+C para desconectar." -ForegroundColor Cyan
Write-Host ""
Write-Host "🚀 Iniciando tunnel-client..." -ForegroundColor Cyan

try {
  & $TunnelExe run --profile codx-remote --health.listen-addr 127.0.0.1:8080 --open-web-ui
} finally {
  $env:CONTROL_PLANE_API_KEY = $null
  Write-Host ""
  Write-Host "🔌 Codx Remote desconectado." -ForegroundColor Yellow
}
