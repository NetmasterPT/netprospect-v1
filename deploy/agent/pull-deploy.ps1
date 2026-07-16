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

# 1) CÓDIGO — git fetch + fast-forward.
try {
  git fetch --quiet origin main 2>&1 | Out-Null
  $L = (git rev-parse HEAD).Trim(); $R = (git rev-parse origin/main).Trim()
  if ($L -ne $R) {
    git pull --ff-only --quiet 2>&1 | Out-Null
    $changed = $true; Log "git $($L.Substring(0,7)) -> $($R.Substring(0,7))"
  }
} catch { Log "AVISO git: $_" }

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
  if (-not $COMPOSE_PROJECT) { Log "ERRO COMPOSE_PROJECT em falta — abortado (evita duplicar containers)"; exit 1 }
  try { docker compose -p $COMPOSE_PROJECT -f "$REPO\$COMPOSE_FILE" up -d --force-recreate 2>&1 | Out-Null; Log "recreate OK ($COMPOSE_PROJECT)" }
  catch { Log "ERRO recreate: $_" }
} else { Log "sem alteracoes" }
