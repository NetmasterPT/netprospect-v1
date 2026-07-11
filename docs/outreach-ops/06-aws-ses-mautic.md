# 06 — Warm tier: Mautic + AWS SES

The final rung: high-value, already-engaged contacts on **super-validated domains** where reputation
is paramount. Mautic (self-hosted, cheap) drives nurture campaigns through **AWS SES** ($0.10 / 1000).
Because these people already know the brand, deliverability is excellent.

## Step 1 — Mautic on the (non-production) Hetzner VM

```yaml
# /opt/mautic/docker-compose.yml
services:
  mautic-db:
    image: mariadb:10.11
    restart: always
    environment:
      MYSQL_ROOT_PASSWORD: <root>
      MYSQL_DATABASE: mautic
      MYSQL_USER: mautic
      MYSQL_PASSWORD: <pass>
    volumes: ["mautic_db:/var/lib/mysql"]
    command: --innodb-buffer-pool-size=1G
  mautic:
    image: mautic/mautic:5-apache
    restart: always
    depends_on: [mautic-db]
    ports: ["127.0.0.1:8090:80"]     # behind NPMplus + SSL
    environment:
      MAUTIC_DB_HOST: mautic-db
      MAUTIC_DB_USER: mautic
      MAUTIC_DB_PASSWORD: <pass>
      MAUTIC_DB_NAME: mautic
      MAUTIC_RUN_CRON_JOBS: "true"
    volumes: ["mautic_app:/var/www/html"]
volumes: { mautic_db: {}, mautic_app: {} }
```

```bash
docker compose up -d      # finish setup in the browser; then Settings → Configuration → API:
                          # enable API + enable Basic Auth (used by export-warm-to-mautic.js)
```

## Step 2 — AWS SES

1. Create an AWS account. In SES (a EU region, e.g. `eu-west-1`): **verify the warm/super-validated
   domain** — add the DKIM CNAMEs + SPF + a DMARC record it gives you.
2. **Exit the Sandbox** (Account dashboard → Request production access). Frame it as opt-in B2B
   (transactional + newsletters to **registered users/clients**), *not* cold. Draft:

   > We use Amazon SES to send product updates and B2B newsletters to registered users and business
   > clients who engaged with our services. We do not use purchased or third-party lists. Bounces and
   > complaints are processed automatically via Amazon SNS webhooks into our Mautic platform, which
   > blacklists the address instantly. Every e-mail carries a one-click unsubscribe. SPF, DKIM and
   > DMARC are configured.

   (Only graduate genuinely-engaged contacts here — that's what keeps complaints < 0.1 %.)
3. Create an SMTP/API credential for Mautic. In Mautic → Configuration → Email Settings: mailer =
   **Amazon SES (API)**, region + keys, verified From address.

## Step 3 — SNS → bounce/complaint → DNC (mandatory)

SES tolerance is strict (**bounce < 2 %, complaints < 0.1 %** or the account is auto-suspended).

1. SES → Configuration set → SNS topics for **Bounce** + **Complaint**.
2. Subscribe Mautic's webhook (or a small endpoint) to those topics; on a bounce/complaint, mark the
   Mautic contact **Do Not Contact** and mirror it back to NetProspect (`dnc` + `contacts.do_not_contact`).
   Mautic has native SES bounce handling — enable it.

## Step 4 — Load the warm contacts

```bash
# CSV (no Mautic API) — import in Mautic UI:
node export-warm-to-mautic.js --out=out/warm.csv
# or push via API:
MAUTIC_URL=https://mautic.<domain> MAUTIC_USER=api MAUTIC_PASS=... node export-warm-to-mautic.js
```

Warm the SES domain too (start ~100/day, ramp over ~4 weeks) even though SES IPs are reputable —
Gmail/Outlook still judge the **domain's** youth. Watch Google Postmaster Tools.

## Cost

Mautic on the existing Hetzner VM ≈ €0 extra; SES ≈ $0.10/1000 e-mails (100k = $10). New AWS accounts
often get credits. Far cheaper than a $35/mo managed platform.
