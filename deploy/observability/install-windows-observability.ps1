# install-windows-observability.ps1 — corre-se UMA vez no laptop (PowerShell COMO ADMINISTRADOR).
# Instala windows_exporter (métricas :9182) + Grafana Alloy (Event Log + logs do Docker Desktop → Loki).
# Idempotente. Loki/Prometheus alcançam o laptop pela tailnet.
#
#   Set-ExecutionPolicy -Scope Process Bypass -Force
#   .\install-windows-observability.ps1
#
$ErrorActionPreference = "Stop"
$Loki      = "http://100.95.20.65:3100"
$HostLabel = "gpedro-laptop"
$weVer     = "0.30.5"
$alloyVer  = "1.5.1"
Write-Host "== NetProspect: observabilidade do laptop ($HostLabel) =="

# --- 1) windows_exporter (métricas :9182) ---
if (-not (Get-Service windows_exporter -ErrorAction SilentlyContinue)) {
  $msi = "$env:TEMP\windows_exporter.msi"
  Write-Host "[1/3] a descarregar windows_exporter $weVer"
  Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/prometheus-community/windows_exporter/releases/download/v$weVer/windows_exporter-$weVer-amd64.msi" -OutFile $msi
  Start-Process msiexec.exe -Wait -ArgumentList "/i `"$msi`" /quiet ENABLED_COLLECTORS=cpu,cs,logical_disk,net,os,memory,system,process,service,tcp LISTEN_ADDR=0.0.0.0 LISTEN_PORT=9182"
  Write-Host "    windows_exporter instalado"
} else { Write-Host "[1/3] windows_exporter já instalado" }

# --- 2) Grafana Alloy (serviço Windows) ---
$alloyDir = "$env:ProgramFiles\GrafanaLabs\Alloy"
if (-not (Get-Service Alloy -ErrorAction SilentlyContinue)) {
  Write-Host "[2/3] a descarregar + instalar Grafana Alloy $alloyVer"
  $zip = "$env:TEMP\alloy-installer.zip"
  Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/grafana/alloy/releases/download/v$alloyVer/alloy-installer-windows-amd64.exe.zip" -OutFile $zip
  Expand-Archive $zip -DestinationPath $env:TEMP -Force
  Start-Process "$env:TEMP\alloy-installer-windows-amd64.exe" -Wait -ArgumentList "/S"
} else { Write-Host "[2/3] Alloy já instalado" }

# --- 3) config do Alloy (Event Log + Docker Desktop → Loki) ---
Write-Host "[3/3] a escrever o config do Alloy"
$dockerBlock = ""
if (Test-Path "\\.\pipe\docker_engine") {
  $dockerBlock = @"
discovery.docker "dc" { host = "npipe:////./pipe/docker_engine" }
discovery.relabel "dc" {
  targets = discovery.docker.dc.targets
  rule {
    source_labels = ["__meta_docker_container_name"]
    regex         = "/(.*)"
    target_label  = "container"
  }
}
loki.source.docker "dc" {
  host       = "npipe:////./pipe/docker_engine"
  targets    = discovery.relabel.dc.output
  forward_to = [loki.process.h.receiver]
}
"@
}
$cfg = @"
logging { level = "warn" }
loki.write "d" { endpoint { url = "$Loki/loki/api/v1/push" } }
loki.source.windowsevent "app" {
  eventlog_name = "Application"
  forward_to    = [loki.process.h.receiver]
}
loki.source.windowsevent "sys" {
  eventlog_name = "System"
  forward_to    = [loki.process.h.receiver]
}
$dockerBlock
loki.process "h" {
  stage.static_labels { values = { host = "$HostLabel" } }
  forward_to = [loki.write.d.receiver]
}
"@
$cfg | Out-File -Encoding ascii "$alloyDir\config.alloy"

# o serviço Alloy no Windows lê o config via a env do serviço; garantir o ficheiro + reiniciar
Restart-Service Alloy -ErrorAction SilentlyContinue
Restart-Service windows_exporter -ErrorAction SilentlyContinue
Start-Sleep 3
Write-Host "windows_exporter: $((Get-Service windows_exporter).Status) | Alloy: $((Get-Service Alloy).Status)"
Write-Host "== feito. Prometheus raspa :9182; Alloy envia logs para o Loki. =="
