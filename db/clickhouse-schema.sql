-- NetProspect — esquema ClickHouse (Fase E: deteção de mudança + métricas).
-- Idempotente. Aplicado por bootstrap-clickhouse.js e montado em
-- /docker-entrypoint-initdb.d no primeiro arranque do container.
-- Duas tabelas MergeTree:
--   observations — 1 linha por (site, métrica) por corrida → série temporal.
--   change_events — 1 linha por mudança detetada (gatilho de venda) entre corridas.

CREATE DATABASE IF NOT EXISTS netprospect;

-- Série temporal de observações. value_num p/ numéricos, value_str p/ categóricos.
CREATE TABLE IF NOT EXISTS netprospect.observations
(
  site_id    UInt64,
  domain     String,
  metric     LowCardinality(String),
  value_num  Nullable(Float64),
  value_str  String DEFAULT '',
  run_id     String DEFAULT '',
  ts         DateTime DEFAULT now()
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (site_id, metric, ts)
TTL ts + INTERVAL 24 MONTH;

-- Eventos de mudança (deltas entre observações consecutivas). São os gatilhos de
-- venda: qualified, score_changed, spf_broke, cert_expiring, platform_changed, ...
CREATE TABLE IF NOT EXISTS netprospect.change_events
(
  site_id    UInt64,
  domain     String,
  event      LowCardinality(String),
  old_value  String DEFAULT '',
  new_value  String DEFAULT '',
  severity   LowCardinality(String) DEFAULT 'info',  -- info|good|warning|critical
  ts         DateTime DEFAULT now()
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (ts, site_id)
TTL ts + INTERVAL 24 MONTH;
