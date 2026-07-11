-- db/data-quality.sql — relatório de qualidade + cobertura dos dados recolhidos.
-- Read-only. Correr:
--   docker exec -i netprospect-postgres-1 psql -U netprospect -d netprospect < db/data-quality.sql
-- Reexecutar depois dos backfills para confirmar que as lacunas fecharam.

\pset footer off
\echo '=================== NETPROSPECT — DATA QUALITY ==================='

\echo '\n--- Totais por TLD (sites / live / qualified / extraídos) ---'
SELECT right(domain,3) AS tld,
       count(*) AS sites,
       count(*) FILTER (WHERE is_live) AS live,
       count(*) FILTER (WHERE qualified) AS qualified,
       count(*) FILTER (WHERE qualified AND contacts_checked_at IS NOT NULL) AS extraidos,
       count(*) FILTER (WHERE qualified AND contacts_checked_at IS NULL) AS por_extrair
FROM sites GROUP BY right(domain,3) ORDER BY sites DESC;

\echo '\n--- Cobertura de contactos (Fase A) por TLD do site ---'
SELECT right(s.domain,3) AS tld,
       count(*) AS contactos,
       round(100.0*count(*) FILTER (WHERE c.role_category IS NOT NULL)/count(*)) AS "rolecat%",
       round(100.0*count(*) FILTER (WHERE c.phone_country IS NOT NULL)/count(*)) AS "phone_country%",
       round(100.0*count(*) FILTER (WHERE c.social_profiles IS NOT NULL)/count(*)) AS "social%",
       round(100.0*count(*) FILTER (WHERE c.email IS NOT NULL)/count(*)) AS "email%",
       round(100.0*count(*) FILTER (WHERE c.email_status IS NOT NULL)/count(*)) AS "verified%"
FROM contacts c LEFT JOIN sites s ON c.site=s.id
GROUP BY right(s.domain,3) ORDER BY contactos DESC NULLS LAST;

\echo '\n--- Distribuição role_category ---'
SELECT coalesce(role_category,'(null)') AS role_category, count(*) FROM contacts GROUP BY role_category ORDER BY 2 DESC;

\echo '\n--- Distribuição email_status (verificação) ---'
SELECT coalesce(email_status,'(null)') AS email_status, count(*) FROM contacts GROUP BY email_status ORDER BY 2 DESC;

\echo '\n--- Cobertura domain-health (qualified) ---'
SELECT count(*) AS qualified,
       round(100.0*count(*) FILTER (WHERE ssl_grade IS NOT NULL)/count(*)) AS "ssl%",
       round(100.0*count(*) FILTER (WHERE dns_provider IS NOT NULL)/count(*)) AS "dns%",
       round(100.0*count(*) FILTER (WHERE cms_version IS NOT NULL)/count(*)) AS "cms%",
       round(100.0*count(*) FILTER (WHERE whois_registrar IS NOT NULL)/count(*)) AS "whois%",
       round(100.0*count(*) FILTER (WHERE has_decision_maker)/count(*)) AS "has_dm%",
       round(100.0*count(*) FILTER (WHERE lead_score IS NOT NULL)/count(*)) AS "scored%"
FROM sites WHERE qualified;

\echo '\n--- RED FLAGS (deve ser tudo 0 / baixo) ---'
SELECT
  (SELECT count(*) FROM contacts WHERE email IS NOT NULL AND email !~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$') AS bad_contact_email,
  (SELECT count(*) FROM companies WHERE general_email IS NOT NULL AND general_email !~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$') AS bad_company_email,
  (SELECT count(*) FROM contacts WHERE name IS NULL AND email IS NULL) AS empty_contacts,
  (SELECT count(*) FROM contacts WHERE company IS NULL) AS contacts_no_company,
  (SELECT count(*) FROM contacts WHERE site IS NULL) AS contacts_no_site,
  (SELECT count(*) FROM companies co WHERE NOT EXISTS (SELECT 1 FROM sites s WHERE s.company=co.id)) AS companies_no_site;

\echo '\n--- Contactos com email DUPLICADO (bug a corrigir) ---'
SELECT count(*) AS emails_duplicados, coalesce(sum(c-1),0) AS linhas_a_remover
FROM (SELECT email, count(*) c FROM contacts WHERE email IS NOT NULL GROUP BY email HAVING count(*)>1) x;

\echo '\n--- Amostra de emails duplicados (top 10 por contagem) ---'
SELECT email, count(*) FROM contacts WHERE email IS NOT NULL GROUP BY email HAVING count(*)>1 ORDER BY 2 DESC LIMIT 10;

\echo '\n--- Totais globais ---'
SELECT (SELECT count(*) FROM sites) AS sites, (SELECT count(*) FROM companies) AS companies,
       (SELECT count(*) FROM contacts) AS contacts, (SELECT count(*) FROM contacts WHERE email IS NOT NULL) AS contacts_email;
\echo '================================================================='
