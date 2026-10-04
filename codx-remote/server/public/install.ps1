$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$installRoot = Join-Path $env:USERPROFILE '.codx-server-remote'
$backend = 'https://codx-remote-api-zrider.onrender.com'
$agentPath = Join-Path $installRoot 'agent.mjs'
$legacyRoot = Join-Path $env:LOCALAPPDATA 'CodxRemote'
Write-Host 'Codx Remote 0.8.0 - instalacao automatica para ChatGPT' -ForegroundColor Cyan
Write-Host '1 - Visivel neste PowerShell, mostrando os logs'
Write-Host '2 - Rodando em segundo plano'
do {
    $selectedMode = Read-Host 'Escolha 1 ou 2'
} while ($selectedMode -notin @('1','2'))

function Start-CodxMode($NodePath, $AgentFile, $RootPath, $Mode) {
    $modeFile = Join-Path $RootPath 'running-mode.txt'
    $running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine.Contains($AgentFile)
    })
    $previousMode = if (Test-Path -LiteralPath $modeFile) { (Get-Content -LiteralPath $modeFile -Raw).Trim() } else { 'background' }
    if ($Mode -eq '2' -and $running.Count -gt 0 -and $previousMode -eq 'background') {
        Write-Host '[OK] Codx Remote ja esta rodando em segundo plano.' -ForegroundColor Green
        Write-Host 'Pode fechar este PowerShell.'
        return
    }
    foreach ($managedProcess in $running) {
        Stop-Process -Id $managedProcess.ProcessId -ErrorAction Stop
        Wait-Process -Id $managedProcess.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
    }
    if ($Mode -eq '2') {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $RootPath 'start.ps1') -Setup
        if ($LASTEXITCODE -ne 0) { throw 'Falha ao iniciar. Verifique os logs na pasta de instalacao.' }
        Set-Content -LiteralPath $modeFile -Value 'background'
        Write-Host '[OK] Codx Remote iniciado em segundo plano. Pode fechar este PowerShell.' -ForegroundColor Green
        return
    }
    Set-Content -LiteralPath $modeFile -Value 'visible'
    Write-Host '[OK] Modo visivel. Mantenha esta janela aberta; Ctrl+C desconecta.' -ForegroundColor Green
    $previousEnv = @{}
    foreach ($key in @('CODX_REMOTE_HOME','CODX_REMOTE_URL','CODX_REMOTE_HEADLESS','CODX_REMOTE_OPEN_CHAT')) {
        $previousEnv[$key] = [Environment]::GetEnvironmentVariable($key,'Process')
    }
    try {
        $env:CODX_REMOTE_HOME = $RootPath
        $env:CODX_REMOTE_URL = $backend
        $env:CODX_REMOTE_HEADLESS = '0'
        $env:CODX_REMOTE_OPEN_CHAT = '0'
        & $NodePath $AgentFile
    } finally {
        foreach ($key in $previousEnv.Keys) {
            if ($null -eq $previousEnv[$key]) {
                Remove-Item -LiteralPath ('Env:' + $key) -ErrorAction SilentlyContinue
            } else {
                [Environment]::SetEnvironmentVariable($key,$previousEnv[$key],'Process')
            }
        }
    }
}
# A complete installation can be started without downloads or credential changes.
$requiredFiles = @('agent.mjs', 'start.ps1', 'stop.ps1', 'node-path.txt', 'config.json')
$complete = $true
foreach ($file in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $installRoot $file) -PathType Leaf)) { $complete = $false }
}
if ($complete -and $env:CODX_REMOTE_FORCE_UPDATE -ne '1') {
    $installedNode = (Get-Content -LiteralPath (Join-Path $installRoot 'node-path.txt') -Raw).Trim()
    if (Test-Path -LiteralPath $installedNode -PathType Leaf) {
        Start-CodxMode $installedNode $agentPath $installRoot $selectedMode
        return
    }
}
New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $installRoot 'logs') -Force | Out-Null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $installRoot /inheritance:r /grant:r ('*' + $sid + ':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel proteger a pasta de credenciais.' }
$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) { throw 'Instale Node.js LTS em https://nodejs.org e execute novamente.' }
    & winget.exe install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw 'A instalacao do Node.js nao foi concluida.' }
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
    $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCmd) { throw 'Reabra o PowerShell e execute novamente para carregar o Node.js.' }
}
$nodePath = $nodeCmd.Source
$configPath = Join-Path $installRoot 'config.json'
$legacyConfig = Join-Path $legacyRoot 'config.json'
if (-not (Test-Path -LiteralPath $configPath) -and (Test-Path -LiteralPath $legacyConfig)) {
    Copy-Item -LiteralPath $legacyConfig -Destination $configPath
    Write-Host '[OK] Configuracao anterior copiada; a pasta antiga foi preservada.'
}
$downloadPath = Join-Path $installRoot 'agent.download.mjs'
Invoke-WebRequest -Uri "$backend/agent/agent.mjs" -OutFile $downloadPath -UseBasicParsing -TimeoutSec 90
& $nodePath --check $downloadPath
if ($LASTEXITCODE -ne 0) { throw 'O agente baixado nao passou na verificacao de sintaxe.' }
$candidatePaths = @($agentPath, (Join-Path $legacyRoot 'agent.mjs'))
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
    $processInfo = $_
    foreach ($candidate in $candidatePaths) {
        if ($processInfo.CommandLine -and $processInfo.CommandLine.Contains($candidate)) {
            Stop-Process -Id $processInfo.ProcessId -ErrorAction SilentlyContinue
            break
        }
    }
}
Move-Item -LiteralPath $downloadPath -Destination $agentPath -Force
$utf8 = New-Object Text.UTF8Encoding($false)
$startScript = @'
param([switch]$Setup)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$env:CODX_REMOTE_HOME = $root
$env:CODX_REMOTE_URL = 'https://codx-remote-api-zrider.onrender.com'
$env:CODX_REMOTE_HEADLESS = '1'
$env:CODX_REMOTE_OPEN_CHAT = if ($Setup) { '1' } else { '0' }
$node = (Get-Content -LiteralPath (Join-Path $root 'node-path.txt') -Raw).Trim()
if (-not (Test-Path -LiteralPath $node)) { throw 'Node.js nao encontrado. Execute o instalador novamente.' }
$agent = Join-Path $root 'agent.mjs'
$existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($agent) }
if ($existing) { exit }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$process = Start-Process -FilePath $node -ArgumentList ('"' + $agent + '"') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $root "logs\agent-$stamp.log") -RedirectStandardError (Join-Path $root "logs\agent-$stamp.err.log")
$process.Id | Set-Content -LiteralPath (Join-Path $root 'agent.pid')
Set-Content -LiteralPath (Join-Path $root 'running-mode.txt') -Value 'background'
'@
$stopScript = @'
$agent = Join-Path $PSScriptRoot 'agent.mjs'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($agent) } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
'@
$startPath = Join-Path $installRoot 'start.ps1'
[IO.File]::WriteAllText($startPath, $startScript, $utf8)
[IO.File]::WriteAllText((Join-Path $installRoot 'stop.ps1'), $stopScript, $utf8)
[IO.File]::WriteAllText((Join-Path $installRoot 'node-path.txt'), $nodePath, $utf8)
$vbsPath = Join-Path $installRoot 'start-hidden.vbs'
$launchCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $startPath + '"'
$vbs = 'CreateObject("WScript.Shell").Run "' + $launchCommand.Replace('"','""') + '", 0, False'
[IO.File]::WriteAllText($vbsPath, $vbs, $utf8)
$startupDir = [Environment]::GetFolderPath('Startup')
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path $startupDir 'Codx Remote.lnk'))
$shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$shortcut.Arguments = '"' + $vbsPath + '"'
$shortcut.WorkingDirectory = $installRoot
$shortcut.Save()
[IO.File]::WriteAllText((Join-Path $installRoot 'conectar-chatgpt.url'), "[InternetShortcut]`r`nURL=https://chatgpt.com/plugins/plugins_6ac2118e331481918f078b95bd26c3fc`r`n", $utf8)
[IO.File]::WriteAllText((Join-Path $installRoot 'LEIA-ME.txt'), @"
Codx Remote 0.8.0
Pasta: $installRoot
O agente inicia automaticamente quando voce entra no Windows.
Logs: logs\
Parar: powershell -NoProfile -ExecutionPolicy Bypass -File "$installRoot\stop.ps1"
Iniciar: powershell -NoProfile -ExecutionPolicy Bypass -File "$installRoot\start.ps1"
ChatGPT: instale/conecte Codx Remote e autorize a conta uma vez.
O instalador nao pode instalar ferramentas dentro do ChatGPT sozinho.
config.json e mcp.json contem credenciais: nao compartilhe.
Para desativar o inicio automatico, remova Codx Remote.lnk da pasta Inicializar do Windows.
"@, $utf8)
Write-Host "[OK] Instalado em $installRoot" -ForegroundColor Green
Write-Host '[OK] Inicio automatico com o Windows configurado em segundo plano.' -ForegroundColor Green
Write-Host 'Se abrir a pagina de cadastro, conclua a autorizacao inicial.'
Write-Host 'Depois conecte o plugin no ChatGPT uma vez; as conversas usarao essa conexao.'
Start-CodxMode $nodePath $agentPath $installRoot $selectedMode
