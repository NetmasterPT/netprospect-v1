# Runbook — Auto-deploy por PULL (laptop Windows + frota Linux)

Como manter cada host da frota atualizado **sem SSH** e com o `.env` de cada um **editável a
partir do dashboard**. Nasceu porque a frota usa **Tailscale SSH** (a porta 22 é intercetada pelo
tailscaled e a autenticação é por ACL, não por chaves), e o laptop (Windows 10) nem por WSL aceita
SSH de entrada. A solução é **PULL**: cada host verifica o np-server periodicamente e recria os
containers **só se o código ou o `.env` mudaram**.

```
  dashboard (np-server)  ──edita/guarda──►  fleet-env/<host>.env   (store central, rw)
        ▲                                          │
        │  editor de .env por host                 │  GET /api/fleet/pull/<host>
        │                                          ▼
  browser (tu, na tailnet)              agente PULL em cada host (a cada 5 min):
                                          git pull + puxa .env → recria SE mudou
```

Nada de inbound nos hosts, nada de ACL, nada de chaves. O único requisito é o host conseguir
**sair** para o np-server na tailnet (`http://100.114.17.74:3001`), o que todos já fazem.

---

## 1. Servidor (np-server) — já configurado no código

- Store: `fleet-env/<host>.env` (montado rw no container do dashboard; gitignored — são segredos).
- Endpoints:
  - `GET/PUT /api/fleet/env/:host` — o **editor** do dashboard (lê/grava; tailnet-gated).
  - `GET /api/fleet/pull/:host` — o **agente** (raw text/plain do `.env`, header `X-Env-Hash`).
    Protegido por `FLEET_PULL_TOKEN` se estiver definido no `.env` do np-server; senão só tailnet.
- Para exigir token: define `FLEET_PULL_TOKEN=<segredo>` no `deploy/server/.env` e recria o dashboard.

O `<host>` tem de bater com o `FLEET_HOST` reportado pelo worker desse host (o nome no dashboard).

---

## 2. Laptop Windows 10 (o caso principal)

Pré-requisitos: **Git for Windows**, **Docker Desktop** (com o worker do laptop já a correr), e o
repo clonado (ex.: `C:\Users\gpedro\netprospect-v1`).

### 2.1 Configurar o agente
1. Copia `deploy\agent\agent.env.ps1.example` → `deploy\agent\agent.env.ps1` e preenche:
   - `$FLEET_HOST = "gpedro-laptop"` (igual ao do worker).
   - `$SERVER_URL = "http://100.114.17.74:3001"`.
   - `$FLEET_PULL_TOKEN` = igual ao do np-server (ou vazio se não usares token).
   - `$REPO` = pasta do repo (ex.: `C:\Users\gpedro\netprospect-v1`).
   - `$COMPOSE_FILE = "deploy\laptop\docker-compose.yml"`, `$ENV_TARGET = "$REPO\deploy\laptop\.env"`.

### 2.2 Testar à mão (uma vez)
Abre o **PowerShell** e corre:
```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\gpedro\netprospect-v1\deploy\agent\pull-deploy.ps1
Get-Content C:\Users\gpedro\netprospect-v1\deploy\agent\pull-deploy.log -Tail 10
```
Deve dizer "sem alteracoes" (ou aplicar mudanças e "recreate OK"). Se falhar o `.env`, confirma o
`$SERVER_URL`, o token, e que já guardaste um `.env` para este host no dashboard (secção 4).

### 2.3 Registar a Tarefa Agendada (corre a cada hora)
Num PowerShell **como Administrador**:
```powershell
$ps  = "C:\Users\gpedro\netprospect-v1\deploy\agent\pull-deploy.ps1"
$act = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ps`""
# a cada hora, indefinidamente, e também 3 min após o arranque:
$t1  = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 1)
$t2  = New-ScheduledTaskTrigger -AtStartup
$set = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "NetProspect Pull Deploy" -Action $act -Trigger $t1,$t2 -Settings $set `
  -User $env:USERNAME -RunLevel Highest -Description "git pull + .env + recreate se mudou"
```
> `-RunOnlyIfNetworkAvailable` + `-StartWhenAvailable` = corre quando o portátil estiver ligado e
> online; se estiver desligado à hora certa, corre na próxima oportunidade. Ajusta o intervalo
> (`-Hours 1`) se quiseres mais/menos frequência.

Ver/forçar depois: `Start-ScheduledTask -TaskName "NetProspect Pull Deploy"` e o `pull-deploy.log`.

---

## 3. Hosts Linux da frota (de1, oracle, hel1) — systemd timer

No host (repo em `/root/netprospect-v1`; no hel1 é `/root/Github/netprospect-v1` → ajusta o path):
```bash
cd /root/netprospect-v1
cp deploy/agent/agent.env.example deploy/agent/agent.env
# edita deploy/agent/agent.env: FLEET_HOST, SERVER_URL, FLEET_PULL_TOKEN, COMPOSE_FILE, COMPOSE_PROJECT
#   de1/oracle: COMPOSE_FILE=deploy/worker/docker-compose.yml   COMPOSE_PROJECT=npworker
#   hel1:       COMPOSE_FILE=docker/docker-compose.yml          COMPOSE_PROJECT=netprospect
# (COMPOSE_PROJECT = prefixo dos containers em `docker ps`; obrigatório, senão duplica containers)
sudo cp deploy/agent/netprospect-pull.service deploy/agent/netprospect-pull.timer /etc/systemd/system/
# (ajusta o ExecStart no .service se o repo não for /root/netprospect-v1)
sudo systemctl daemon-reload
sudo systemctl enable --now netprospect-pull.timer
systemctl list-timers netprospect-pull.timer     # confirma o próximo disparo
/root/netprospect-v1/deploy/agent/pull-deploy.sh # corre uma vez à mão p/ testar
tail -n 20 deploy/agent/pull-deploy.log
```

---

## 4. Editar o `.env` de um host a partir do dashboard

Página **Servidores** → card do host → **Editar .env**. Guardar escreve em `fleet-env/<host>.env`
no np-server; o agente desse host aplica-o no próximo ciclo (≤ intervalo do timer) e recria os
containers. Primeira vez para um host: cola o `.env` atual desse host e Guarda (fica a ser a fonte
de verdade).

---

## 5. Notas / troubleshooting

- **Só recria se mudou**: compara o SHA de git (local vs `origin/main`) e o conteúdo do `.env`
  (normalizado LF). Sem alterações → não toca nos containers.
- **git pull falha** (working tree suja): o agente regista o aviso e **salta o código** (não força).
  Nos hosts de produção o working tree deve estar limpo (só o `.env`, que é gitignored, muda).
- **`.env` a churnar** (recria sempre): normalmente CRLF vs LF — o agente já normaliza; confirma que
  o `.env` no store não tem BOM.
- **Segurança**: o `.env` tem segredos. Sem `FLEET_PULL_TOKEN`, qualquer nó da tailnet consegue lê-lo
  em `/api/fleet/pull/:host`. Define o token se a fronteira da tailnet não chegar.
- **Laptop offline**: o agente falha o fetch em silêncio (log de aviso) e tenta no próximo ciclo.
