# NetProspect — agente de AUTO-DEPLOY por PULL (Windows 10 / Docker Desktop).
#
# Corre via Tarefa Agendada. NÃO precisa de SSH nem de inbound no laptop: é o laptop que PUXA
# o estado do np-server. git pull + puxa o .env do store central e recria os containers SÓ SE
# o código OU o .env mudaram. Config em agent.env.ps1 (mesmo diretório).
# Setup: ver docs/runbook-laptop-autodeploy.md.

$ErrorActionPreference = "Stop"
$Self = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$Self\agent.env.ps1"   # $FLEET_HOST, $SERVER_URL, $FLEET_PULL_TOKEN, $REPO, $COMPOSE_FILE, $ENV_TARGET
$Log = Join-Path $Self "pull-deploy.log"
function Log($m) { "$(Get-Date -Format o) $m" | Out-File -Append -Encoding utf8 $Log }
function NormLF([string]$s) { if ($null -eq $s) { return "" } return ($s -replace "`r`n", "`n") }

$changed = $false
Set-Location $REPO

# 1) CÓDIGO — git fetch + fast-forward. $SKIP_GIT=$true salta (ex.: host onde se committa).
if (-not (Get-Variable -Name SKIP_GIT -ErrorAction SilentlyContinue) -or -not $SKIP_GIT) {
  try {
    git fetch --quiet origin main 2>&1 | Out-Null
    $L = (git rev-parse HEAD).Trim(); $R = (git rev-parse origin/main).Trim()
    if ($L -ne $R) {
      # Guarda docs-only: se TODOS os ficheiros alterados forem .md, faz o pull mas NAO recria
      # (documentacao nunca e carregada pelos workers -> recreate seria churn inutil).
      $files = git diff --name-only $L $R
      git pull --ff-only --quiet 2>&1 | Out-Null
      $codeChanged = @($files | Where-Object { $_ -notmatch '\.md$' }).Count -gt 0
      if ($codeChanged) { $changed = $true; Log "git $($L.Substring(0,7)) -> $($R.Substring(0,7))" }
      else { Log "git $($L.Substring(0,7)) -> $($R.Substring(0,7)) (so docs .md - sem recreate)" }
    }
  } catch { Log "AVISO git: $_" }
} else { Log "git: saltado (SKIP_GIT)" }

# 2) .ENV — puxa do store central; substitui só se diferente (normaliza CRLF/LF p/ não churnar).
try {
  $headers = @{}; if ($FLEET_PULL_TOKEN) { $headers["Authorization"] = "Bearer $FLEET_PULL_TOKEN" }
  $resp = Invoke-WebRequest -Uri "$SERVER_URL/api/fleet/pull/$FLEET_HOST" -Headers $headers -UseBasicParsing -TimeoutSec 20
  $new = NormLF([string]$resp.Content)
  $cur = if (Test-Path $ENV_TARGET) { NormLF((Get-Content -Raw $ENV_TARGET)) } else { "" }
  if ($new -and ($new -ne $cur)) {
    [IO.File]::WriteAllText($ENV_TARGET, $new)   # escreve com LF, sem BOM
    $changed = $true; Log ".env atualizado -> $ENV_TARGET"
  }
} catch { Log "AVISO .env: $_" }

# 3) RECREATE — só se algo mudou.
if ($changed) {
  if (-not $COMPOSE_PROJECT) { Log "ERRO COMPOSE_PROJECT em falta -- abortado (evita duplicar containers)"; exit 1 }
  try { docker compose -p $COMPOSE_PROJECT -f "$REPO\$COMPOSE_FILE" up -d --force-recreate 2>&1 | Out-Null; Log "recreate OK ($COMPOSE_PROJECT)" }
  catch { Log "ERRO recreate: $_" }
} else { Log "sem alteracoes" }

# 4) OBSERVABILITY self-heal — o windows_exporter (:9182) e o Alloy correm FORA do Docker (serviços
#    Windows), por isso um reboot/queda deixa-os parados e o Prometheus perde o target sem que o
#    recreate acima os toque. Idempotente, corre SEMPRE: INSTALA se faltarem (a Task corre elevada,
#    -RunLevel Highest → pode instalar o MSI), garante Running + StartupType=Automatic e a regra de
#    firewall da 9182. Sem isto, um laptop novo (ou sem o exporter) fica sem target no Prometheus.
$obsInstaller = "$REPO\deploy\observability\install-windows-observability.ps1"
$needInstall = @("windows_exporter", "Alloy") | Where-Object { -not (Get-Service $_ -ErrorAction SilentlyContinue) }
if ($needInstall -and (Test-Path $obsInstaller)) {
  try {
    Log "observability: a instalar ($($needInstall -join ',')) via install-windows-observability.ps1"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $obsInstaller *>> $Log
  } catch { Log "AVISO instalador observability: $_" }
}
foreach ($svc in @("windows_exporter", "Alloy")) {
  try {
    $s = Get-Service $svc -ErrorAction SilentlyContinue
    if ($s) {
      if ($s.StartType -ne "Automatic") { Set-Service $svc -StartupType Automatic }
      if ($s.Status -ne "Running") { Start-Service $svc; Log "$svc arrancado (estava $($s.Status))" }
    } else { Log "AVISO $svc continua em falta apos tentativa de instalacao" }
  } catch { Log "AVISO self-heal ${svc}: $_" }
}
try {
  if (-not (Get-NetFirewallRule -DisplayName "windows_exporter 9182" -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName "windows_exporter 9182" -Direction Inbound -Protocol TCP -LocalPort 9182 -Action Allow -Profile Any | Out-Null
    Log "firewall 9182 criada"
  }
} catch { Log "AVISO firewall 9182: $_" }
