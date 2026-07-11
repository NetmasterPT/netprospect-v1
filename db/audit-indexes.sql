-- Índices secundários para os filtros de prospeção (auditoria).
-- O Directus NÃO cria índices para campos escalares — sem estes, cada faceta
-- faz seq scan sobre ~1,5M linhas. Idempotente (IF NOT EXISTS). Aplicar com:
--   docker exec -i netprospect-postgres-1 psql -U netprospect -d netprospect < db/audit-indexes.sql
-- Nunca indexar/filtar sobre colunas json (social, summary, report).

-- Booleans "quentes": índices PARCIAIS (só as linhas true) — compactos e usados
-- pelos filtros has=true. O planner ignora-os quando se filtra por false.
CREATE INDEX IF NOT EXISTS ix_sites_has_email       ON sites (has_email)        WHERE has_email;
CREATE INDEX IF NOT EXISTS ix_sites_has_phone       ON sites (has_phone)        WHERE has_phone;
CREATE INDEX IF NOT EXISTS ix_sites_fb              ON sites (social_facebook)  WHERE social_facebook;
CREATE INDEX IF NOT EXISTS ix_sites_ig              ON sites (social_instagram) WHERE social_instagram;
CREATE INDEX IF NOT EXISTS ix_sites_li              ON sites (social_linkedin)  WHERE social_linkedin;
CREATE INDEX IF NOT EXISTS ix_sites_tw              ON sites (social_twitter)   WHERE social_twitter;
CREATE INDEX IF NOT EXISTS ix_sites_gmb             ON sites (gmb)              WHERE gmb;
CREATE INDEX IF NOT EXISTS ix_sites_cpanel          ON sites (is_cpanel)        WHERE is_cpanel;
CREATE INDEX IF NOT EXISTS ix_sites_mobile_unfriendly ON sites (mobile_friendly) WHERE NOT mobile_friendly;

-- Enums / categóricos: btree normal (usado por _eq e _in).
CREATE INDEX IF NOT EXISTS ix_sites_load_bucket     ON sites (load_bucket);
CREATE INDEX IF NOT EXISTS ix_sites_traffic_bucket  ON sites (traffic_bucket);
CREATE INDEX IF NOT EXISTS ix_sites_spf             ON sites (spf_status);
CREATE INDEX IF NOT EXISTS ix_sites_dmarc           ON sites (dmarc_status);
CREATE INDEX IF NOT EXISTS ix_sites_audit_status    ON sites (audit_status);
CREATE INDEX IF NOT EXISTS ix_sites_sec_severity    ON sites (security_severity);
CREATE INDEX IF NOT EXISTS ix_sites_business_city   ON sites (business_city);
CREATE INDEX IF NOT EXISTS ix_sites_industry        ON sites (industry);

-- Numéricos (range: seo_score < N, security_findings > 0, wp_vuln_count > 0).
CREATE INDEX IF NOT EXISTS ix_sites_seo_score       ON sites (seo_score);
CREATE INDEX IF NOT EXISTS ix_sites_mobile_score    ON sites (mobile_score);
CREATE INDEX IF NOT EXISTS ix_sites_sec_findings    ON sites (security_findings) WHERE security_findings > 0;
CREATE INDEX IF NOT EXISTS ix_sites_wp_vuln         ON sites (wp_vuln_count)     WHERE wp_vuln_count > 0;

-- Marcas de resume (o produtor/backfill salta o que já foi feito).
CREATE INDEX IF NOT EXISTS ix_sites_cheap_checked   ON sites (cheap_checked_at);
CREATE INDEX IF NOT EXISTS ix_sites_audit_checked   ON sites (audit_checked_at);

-- site_reports: lookup por (site, kind) para o upsert idempotente e o drawer.
CREATE INDEX IF NOT EXISTS ix_site_reports_site_kind ON site_reports (site, kind);

-- Fase A: qualificação v2 + lead score + contactos (roles).
CREATE INDEX IF NOT EXISTS ix_sites_lead_score        ON sites (lead_score);
CREATE INDEX IF NOT EXISTS ix_sites_has_dm            ON sites (has_decision_maker) WHERE has_decision_maker;
CREATE INDEX IF NOT EXISTS ix_contacts_role           ON contacts (role);
CREATE INDEX IF NOT EXISTS ix_contacts_role_category  ON contacts (role_category);
CREATE INDEX IF NOT EXISTS ix_contacts_email_nn       ON contacts (site) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_contacts_phone_nn       ON contacts (site) WHERE phone IS NOT NULL;

-- Fase D: SSL / WHOIS / DNS / CMS.
CREATE INDEX IF NOT EXISTS ix_sites_ssl_days          ON sites (ssl_days_left);
CREATE INDEX IF NOT EXISTS ix_sites_expiring_soon     ON sites (expiring_soon) WHERE expiring_soon;
CREATE INDEX IF NOT EXISTS ix_sites_cms_outdated      ON sites (cms_outdated) WHERE cms_outdated;
CREATE INDEX IF NOT EXISTS ix_sites_dns_provider      ON sites (dns_provider);
