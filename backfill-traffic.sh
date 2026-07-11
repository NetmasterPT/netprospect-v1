#!/bin/bash
# backfill-traffic.sh — Traffic ranking via JOIN bulk contra o Tranco top-1M.
# É um set-op (lookup numa lista fixa), NÃO um crawl por domínio, por isso corre
# como UM UPDATE no Postgres em vez de centenas de milhares de jobs (que, além do
# mais, escreveriam 'unranked' a todos porque o worker-base não carrega o Tranco).
# Buckets iguais a lib/audit/tranco.js bucketOf(). Idempotente. Só qualificados-vivos.
set -e
cd "$(dirname "$0")"
PG=netprospect-postgres-1
CSV=data/tranco/top-1m.csv
[ -f "$CSV" ] || { echo "Tranco em falta: $CSV (corre fetch-tranco.js)"; exit 1; }
docker cp "$CSV" "$PG:/tmp/tranco.csv"
docker exec -i "$PG" psql -U netprospect -d netprospect <<'SQL'
DROP TABLE IF EXISTS tranco_tmp;
CREATE UNLOGGED TABLE tranco_tmp (rank int, domain text);
\copy tranco_tmp FROM '/tmp/tranco.csv' WITH (FORMAT csv)
CREATE INDEX ON tranco_tmp(domain);
-- ranked: apenas os que estão no top-1M (match por apex; sites.domain já é apex)
UPDATE sites s SET traffic_rank = t.rank,
  traffic_bucket = CASE WHEN t.rank <= 10000 THEN 'top10k'
                        WHEN t.rank <= 100000 THEN 'top100k'
                        ELSE 'top1m' END
  FROM tranco_tmp t
  WHERE s.qualified AND s.is_live AND s.domain = t.domain;
-- resto dos qualificados-vivos → unranked (= sem dados, não "pouco tráfego")
UPDATE sites SET traffic_bucket = 'unranked'
  WHERE qualified AND is_live AND traffic_bucket IS NULL;
DROP TABLE tranco_tmp;
SELECT traffic_bucket, count(*) FROM sites WHERE qualified AND is_live GROUP BY 1 ORDER BY 2 DESC;
SQL
