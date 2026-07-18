#!/usr/bin/env bash
# push-configs.sh — deploya (idempotente) os configs VERSIONADOS de deploy/observability/ para os CTs
# da stack de observabilidade. Fonte-de-verdade = este repo; os CTs recebem exatamente o que está aqui.
#
# Componentes (CTs no hel1-pve salvo indicação):
#   prometheus   CT200  /etc/prometheus/prometheus.yml            + promtool check config → SIGHUP
#   rules        CT200  /etc/prometheus/rules/*.yml               + promtool check rules  → SIGHUP
#   alertmanager CT203  /etc/alertmanager/alertmanager.yml        + amtool check-config   → SIGHUP
#   loki         CT206  /etc/loki/loki.yaml                       + loki -verify-config   → restart
#   blackbox     CT204(hel1)+CT204(de1)  /opt/blackbox-exporter/blackbox.yml              → restart
#   ntfy         CT205  /etc/ntfy/server.yml                                              → restart
#   grafana      CT201  /etc/grafana/provisioning/**  + /var/lib/grafana/dashboards/*.json→ restart
#
# O ficheiro é empurrado por `pct exec … tee` via stdin do SSH (não precisa de estar no nó primeiro).
# Configs com validador vão primeiro para <dest>.new, validam, e só então substituem <dest> (nunca
# deixa um config partido no sítio). Reload por SIGHUP quando o daemon o suporta (sem downtime).
#
# Uso:   ./push-configs.sh [--dry-run] [--only prometheus|rules|alertmanager|loki|blackbox|ntfy|grafana]
# Env:   HEL1_PVE (default root@100.86.211.70)  DE1_PVE (default root@100.87.226.117)
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEL1="${HEL1_PVE:-root@100.86.211.70}"
DE1="${DE1_PVE:-root@100.87.226.117}"
SSH="ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10"
DRY=0; ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --only) ONLY="$2"; shift ;;
    *) echo "arg desconhecido: $1" >&2; exit 2 ;;
  esac; shift
done
want(){ [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
FAIL=0; OK=0
say(){ printf '  %s\n' "$*"; }

# push_file <pve> <ctid> <localrel> <dest>  — copia local→CT (cria destino via tee).
push_file(){ local pve="$1" ct="$2" src="$DIR/$3" dst="$4"
  [ -f "$src" ] || { say "✗ falta ficheiro local: $3"; FAIL=$((FAIL+1)); return 1; }
  if [ "$DRY" = 1 ]; then say "· (dry) $3 → CT$ct:$dst"; return 0; fi
  $SSH "$pve" "pct exec $ct -- tee '$dst' >/dev/null" < "$src"
}
# in_ct <pve> <ctid> <cmd…>
in_ct(){ local pve="$1" ct="$2"; shift 2; $SSH "$pve" "pct exec $ct -- sh -c '$*'"; }

# ---- prometheus.yml (validação: config.new → promtool → substitui → SIGHUP) ----
if want prometheus; then
  echo "[prometheus CT200] prometheus.yml"
  if push_file "$HEL1" 200 prometheus/prometheus.yml /etc/prometheus/prometheus.yml.new; then
    if [ "$DRY" = 1 ]; then OK=$((OK+1));
    elif in_ct "$HEL1" 200 "/usr/local/bin/promtool check config /etc/prometheus/prometheus.yml.new >/dev/null 2>&1"; then
      in_ct "$HEL1" 200 "mv /etc/prometheus/prometheus.yml.new /etc/prometheus/prometheus.yml && systemctl kill -s HUP prometheus"
      say "✓ validado + SIGHUP"; OK=$((OK+1))
    else say "✗ promtool REJEITOU prometheus.yml — não aplicado (.new deixado p/ inspeção)"; FAIL=$((FAIL+1)); fi
  fi
fi

# ---- rules/*.yml (valida cada .new num dir temporário → substitui → SIGHUP) ----
if want rules; then
  echo "[prometheus CT200] rules/*.yml"
  in_ct "$HEL1" 200 "rm -rf /etc/prometheus/rules.new && mkdir -p /etc/prometheus/rules.new" 2>/dev/null
  local_ok=1
  for f in "$DIR"/prometheus/rules/*.yml; do
    b="$(basename "$f")"
    push_file "$HEL1" 200 "prometheus/rules/$b" "/etc/prometheus/rules.new/$b" || local_ok=0
  done
  if [ "$DRY" = 1 ]; then OK=$((OK+1));
  elif [ "$local_ok" = 1 ] && in_ct "$HEL1" 200 "/usr/local/bin/promtool check rules /etc/prometheus/rules.new/*.yml >/dev/null 2>&1"; then
    in_ct "$HEL1" 200 "rm -f /etc/prometheus/rules/*.yml && cp /etc/prometheus/rules.new/*.yml /etc/prometheus/rules/ && rm -rf /etc/prometheus/rules.new && systemctl kill -s HUP prometheus"
    say "✓ regras validadas + SIGHUP"; OK=$((OK+1))
  else say "✗ promtool REJEITOU as regras — não aplicadas"; FAIL=$((FAIL+1)); fi
fi

# ---- alertmanager.yml (amtool check-config → SIGHUP) ----
if want alertmanager; then
  echo "[alertmanager CT203] alertmanager.yml"
  if push_file "$HEL1" 203 alertmanager/alertmanager.yml /etc/alertmanager/alertmanager.yml.new; then
    if [ "$DRY" = 1 ]; then OK=$((OK+1));
    elif in_ct "$HEL1" 203 "/usr/local/bin/amtool check-config /etc/alertmanager/alertmanager.yml.new >/dev/null 2>&1"; then
      in_ct "$HEL1" 203 "mv /etc/alertmanager/alertmanager.yml.new /etc/alertmanager/alertmanager.yml && systemctl kill -s HUP prometheus-alertmanager"
      say "✓ validado + SIGHUP"; OK=$((OK+1))
    else say "✗ amtool REJEITOU alertmanager.yml — não aplicado"; FAIL=$((FAIL+1)); fi
  fi
fi

# ---- loki.yaml (loki -verify-config → restart) ----
if want loki; then
  echo "[loki CT206] loki.yaml"
  if push_file "$HEL1" 206 loki/loki.yaml /etc/loki/loki.yaml.new; then
    if [ "$DRY" = 1 ]; then OK=$((OK+1));
    elif in_ct "$HEL1" 206 "/usr/local/bin/loki -config.file=/etc/loki/loki.yaml.new -verify-config >/dev/null 2>&1"; then
      in_ct "$HEL1" 206 "mv /etc/loki/loki.yaml.new /etc/loki/loki.yaml && systemctl restart loki"
      say "✓ validado + restart"; OK=$((OK+1))
    else say "✗ loki -verify-config REJEITOU — não aplicado"; FAIL=$((FAIL+1)); fi
  fi
fi

# ---- blackbox.yml (hel1 CT204 + de1 CT204) → restart ----
if want blackbox; then
  echo "[blackbox] blackbox.yml → hel1 CT204 + de1 CT204"
  for pair in "$HEL1:hel1" "$DE1:de1"; do
    pve="${pair%%:*}"; tag="${pair##*:}"
    if push_file "$pve" 204 blackbox/blackbox.yml /opt/blackbox-exporter/blackbox.yml; then
      [ "$DRY" = 1 ] || in_ct "$pve" 204 "systemctl restart blackbox-exporter"
      say "✓ $tag CT204 restart"; OK=$((OK+1))
    fi
  done
fi

# ---- ntfy server.yml → restart (garante os dirs de cache) ----
if want ntfy; then
  echo "[ntfy CT205] server.yml"
  if push_file "$HEL1" 205 ntfy/server.yml /etc/ntfy/server.yml; then
    if [ "$DRY" != 1 ]; then
      in_ct "$HEL1" 205 "mkdir -p /var/cache/ntfy/attachments && chown -R ntfy:ntfy /var/cache/ntfy 2>/dev/null; systemctl restart ntfy"
    fi
    say "✓ restart"; OK=$((OK+1))
  fi
fi

# ---- grafana provisioning + dashboards → restart ----
if want grafana; then
  echo "[grafana CT201] provisioning + dashboards"
  push_file "$HEL1" 201 grafana/provisioning/datasources/netprospect.yaml /etc/grafana/provisioning/datasources/netprospect.yaml
  push_file "$HEL1" 201 grafana/provisioning/dashboards/netprospect.yaml  /etc/grafana/provisioning/dashboards/netprospect.yaml
  [ "$DRY" = 1 ] || in_ct "$HEL1" 201 "mkdir -p /var/lib/grafana/dashboards"
  for f in "$DIR"/grafana/dashboards/*.json; do
    [ -f "$f" ] || continue
    push_file "$HEL1" 201 "grafana/dashboards/$(basename "$f")" "/var/lib/grafana/dashboards/$(basename "$f")"
  done
  if [ "$DRY" != 1 ]; then
    in_ct "$HEL1" 201 "chown -R grafana:grafana /var/lib/grafana/dashboards 2>/dev/null; systemctl restart grafana-server"
  fi
  say "✓ provisioning + dashboards + restart"; OK=$((OK+1))
fi

echo
echo "=== push-configs: OK=$OK  FALHAS=$FAIL$([ "$DRY" = 1 ] && echo '  (dry-run)') ==="
[ "$FAIL" = 0 ]
