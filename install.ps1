param(
  [Parameter(Mandatory = $true)]
  [string]$Token,

  [Parameter(Mandatory = $true)]
  [string]$Server,

  [string]$SourceBaseUrl,
  [string]$Name = "Agent-$env:COMPUTERNAME",
  [int]$Interval = 5000,
  [string]$Api = "http://127.0.0.1:3001"
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host "[SysManager] $Message"
}

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Administrator)) {
  throw "Execute este script em um PowerShell aberto como Administrador."
}

$agentDir = Join-Path $env:ProgramData "SysManagerAgent"
$configDir = Join-Path $env:ProgramData "SysManagerAgent"
$configFile = Join-Path $configDir "config.json"
$serviceName = "sysmanager-agent"

if ([string]::IsNullOrWhiteSpace($SourceBaseUrl)) {
  try {
    $serverUri = [Uri]$Server
    $SourceBaseUrl = "http://$($serverUri.Host):7878/agent/runtime"
  } catch {
    throw "Nao foi possivel derivar SourceBaseUrl. Informe -SourceBaseUrl explicitamente."
  }
}

$SourceBaseUrl = $SourceBaseUrl.TrimEnd('/')

Write-Step "Iniciando instalacao do SysManager Agent para Windows"
Write-Step "Servidor: $Server"
Write-Step "Nome: $Name"
Write-Step "API local: $Api"
Write-Step "Origem dos arquivos: $SourceBaseUrl"

Write-Step "Verificando Node.js e npm"
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$npmCmd = Get-Command npm -ErrorAction SilentlyContinue

if (-not $nodeCmd -or -not $npmCmd) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Step "Node.js nao encontrado. Instalando via winget"
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
  }
}

if (-not $nodeCmd -or -not $npmCmd) {
  throw "Node.js 18+ e npm sao obrigatorios. Instale manualmente e execute novamente."
}

$nodeVersion = (& $nodeCmd.Source --version).Trim()
$majorVersion = [int](($nodeVersion -replace '^v', '').Split('.')[0])
if ($majorVersion -lt 18) {
  throw "Node.js 18+ e necessario. Versao atual: $nodeVersion"
}

Write-Step "Node.js detectado: $nodeVersion"

Write-Step "Preparando diretorios"
New-Item -Path $agentDir -ItemType Directory -Force | Out-Null
New-Item -Path $configDir -ItemType Directory -Force | Out-Null

$scriptBase = $PSScriptRoot
$runtimeFiles = @("index.js", "local-api-fallback.js", "package.json")
$hasLocalFiles = $true

foreach ($file in $runtimeFiles) {
  if (-not (Test-Path (Join-Path $scriptBase $file))) {
    $hasLocalFiles = $false
    break
  }
}

if ($hasLocalFiles) {
  Write-Step "Copiando arquivos locais do repositorio"
  foreach ($file in $runtimeFiles) {
    Copy-Item -Path (Join-Path $scriptBase $file) -Destination (Join-Path $agentDir $file) -Force
  }
} else {
  Write-Step "Baixando arquivos do agent"
  foreach ($file in $runtimeFiles) {
    $src = "$SourceBaseUrl/$file"
    $dst = Join-Path $agentDir $file
    Invoke-WebRequest -UseBasicParsing $src -OutFile $dst
  }
}

Write-Step "Instalando dependencias npm"
Push-Location $agentDir
npm install --omit=dev --quiet
Pop-Location

Write-Step "Gerando configuracao"
$configObject = @{
  serverUrl = $Server
  token = $Token
  agentName = $Name
  reportInterval = $Interval
  localApiBaseUrl = $Api
}
$configObject | ConvertTo-Json -Depth 10 | Set-Content -Path $configFile -Encoding UTF8

Write-Step "Configurando servico do Windows"
$existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existing) {
  if ($existing.Status -ne 'Stopped') {
    Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
  }
  sc.exe delete $serviceName | Out-Null
  Start-Sleep -Seconds 1
}

$nodePath = $nodeCmd.Source
$binPath = '"{0}" "{1}" --config "{2}"' -f $nodePath, (Join-Path $agentDir "index.js"), $configFile
sc.exe create $serviceName binPath= $binPath start= auto DisplayName= "SysManager Agent" | Out-Null
sc.exe description $serviceName "SysManager remote agent for Windows" | Out-Null

Start-Service -Name $serviceName
$service = Get-Service -Name $serviceName

Write-Host ""
Write-Host "=== Instalacao concluida ==="
Write-Host "Status: $($service.Status)"
Write-Host ""
Write-Host "Comandos uteis:"
Write-Host "  Get-Service sysmanager-agent"
Write-Host "  Restart-Service sysmanager-agent"
Write-Host "  sc.exe qc sysmanager-agent"
