# ARIA control plane - self-hosting runbook

Restores the ARIA Telegram control plane on any Docker-capable Linux VM (written
for an Oracle Cloud Always Free Arm VM). Railway returned 404 "Application not
found", so this replaces it. Everything below runs from the `deploy/` folder
unless said otherwise.

STATUS HONESTY: the compose file was validated with `docker compose config` only;
it has never been built or run (no Docker daemon was available where it was written).
The app + migrations + /healthz path was proven on a bare machine with a throw-away
Postgres (see "Verification evidence" at the bottom). Expect to fix small things on
the first real `docker compose up` and treat that run as the real test.

## 0. What the app needs (verified in source)

- Node 22 (uses `node:sqlite`); the repo Dockerfile already provides it.
- SQLite file at `DB_PATH` (`/data/aria.db`): leads, licenses, orders/subscriptions, audit_log. This is customer data. Lives in the `aria_data` volume.
- Postgres via `DATABASE_URL`: engine clients, entitlements, pairing codes, sync, funnel events, feedback, invites, ledger tables. 13 migrations in `migrations/`, applied automatically by the app on every start (`src/migrate.ts`), so there is no separate migrate step.
- Port 8080, health check `GET /healthz`.
- Telegram webhook: with `TELEGRAM_TRANSPORT=webhook` the app registers `PUBLIC_URL/api/telegram/webhook` with `TELEGRAM_WEBHOOK_SECRET` itself on boot and re-checks it periodically.

## 1. Data first: export from Railway BEFORE anything else

Do this before importing anything on the new VM. If Railway data is already gone, read 1.4 and skip to section 2.

1.1 Postgres: Railway dashboard -> Postgres service -> Connect -> copy the **public** connection string. On your own computer (needs `pg_dump` 16 or newer):

    pg_dump "<connection string>" --format=custom --no-owner -f aria.pgdump

1.2 SQLite: the file `/data/aria.db` lives on the Railway volume. Use `railway ssh` into the app service and take a consistent copy, then download it:

    node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('/data/aria.db').exec(\"VACUUM INTO '/tmp/aria.sqlite'\")"

(Or use the volume's backup/download feature; if you copy the raw file, also copy `aria.db-wal`, otherwise recent writes are lost.)

1.3 Copy every variable from the Railway dashboard into a password manager. The four ARIA signing-key variables are mandatory (section 4).

1.4 If Railway data no longer exists, what is LOST:
- leads (trial signups);
- license issue and revocation records (a revoked license is no longer known to be revoked);
- the order/subscription mirror (Stripe remains the source of truth; reconcile from Stripe);
- the audit log;
- engine pairing, client and entitlement rows (every engine must re-pair).
If the signing keys are also lost, every issued license and entitlement is permanently invalid and must be re-issued under new keys, and the public keys baked into clients/engines must be updated, which is a release rather than a config change.

## 2. Create the VM (the OWNER must do this; an assistant cannot)

The owner must create the Oracle Cloud account themselves (identity and card verification are required). Then:

1. Console -> Compute -> Instances -> Create. Image: Ubuntu 24.04 (aarch64). Shape: VM.Standard.A1.Flex (Ampere). Oracle's Always Free page (docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm, read 2026-10-04) lists 2 OCPU / 12 GB total for A1, 47 GB minimum boot volume, 200 GB total block storage across Always Free. Re-check current limits when you create it. 1 OCPU / 6 GB is plenty for this app.
2. Create resources only in your tenancy **home region**; outside it they are billed.
3. Add your SSH public key. Keep the private key safe.
4. Networking: default VCN. In the subnet Security List allow ingress TCP 22 (restrict the source to your IP if possible). Do NOT open 8080 or 5432. For Caddy (5B) also allow TCP 80 and 443. For Cloudflare Tunnel (5A) no inbound web ports are needed.
5. Ubuntu images also ship an iptables firewall. For Caddy: `sudo iptables -I INPUT 6 -p tcp --dport 80 -j ACCEPT; sudo iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT; sudo netfilter-persistent save` (install `iptables-persistent` if missing).
6. Arm capacity on Always Free is sometimes "out of host capacity": retry later or try another availability domain.

## 3. Install Docker (Ubuntu, Arm)

    sudo apt-get update && sudo apt-get install -y ca-certificates curl git
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker $USER      # then log out and back in
    docker run --rm hello-world
    docker compose version

node:22-slim, postgres:16 and cloudflare/cloudflared publish linux/arm64 builds; confirm on the first pull.

## 4. Configure and start

    git clone <repo-url> aria && cd aria
    git checkout deploy/self-host-kit      # or main once merged
    cd deploy
    cp .env.template .env && chmod 600 .env
    nano .env

Fill in `.env` (names are in `.env.template`):
- MUST be copied UNCHANGED from Railway: `ARIA_LICENSE_PRIVATE_D`, `ARIA_LICENSE_PUBLIC_X`, `ARIA_ENTITLEMENT_PRIVATE_D`, `ARIA_ENTITLEMENT_PUBLIC_X`. Never run `npm run keygen` here: new keys invalidate every issued license/entitlement.
- NEW: `TELEGRAM_WEBHOOK_SECRET` (`openssl rand -hex 32`) - must NOT be the old value, which leaked into Railway logs (2026-09-26 audit). `POSTGRES_PASSWORD` (`openssl rand -hex 24`).
- `PUBLIC_URL` = the final https URL (section 5), no trailing slash. `TELEGRAM_TRANSPORT=webhook`. Plus `TELEGRAM_BOT_TOKEN`, `RESEND_API_KEY`, `ADMIN_EMAIL`, `FROM_EMAIL` and the Stripe values as on Railway.

Import old data (only if you exported in section 1). Put the two files in a folder, named exactly `aria.pgdump` and `aria.sqlite` (e.g. `deploy/import/aria.pgdump` and `deploy/import/aria.sqlite`), then:

    ./restore.sh import --yes-overwrite

It stops the app, recreates the `aria` database from the dump, replaces `/data/aria.db` and starts the app. Migrations are idempotent and see the imported `pgmigrations` table. Skip this for a fresh start.

Start (if you did not just run restore):

    export GIT_SHA=$(git rev-parse HEAD) GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
    docker compose up -d --build          # add --profile tunnel for Cloudflare Tunnel
    docker compose ps
    docker compose logs app | grep -i -E "migrat|BOT_BOOT|webhook|error"

You must see "Postgres migrations up to date". The app treats a migration failure as NON-fatal (logs an error, keeps running with engine routes unavailable), so `/healthz` can be green while Postgres features are broken. Always check that log line.

## 5. HTTPS (Telegram requires a public https URL)

A. Cloudflare Tunnel (no open ports, free):
1. Cloudflare Zero Trust -> Networks -> Tunnels -> Create (Cloudflared). Put the token in `CLOUDFLARE_TUNNEL_TOKEN` in `.env`.
2. Add a Public Hostname (needs a domain on Cloudflare) with service `http://app:8080`.
3. `docker compose --profile tunnel up -d`. Set `PUBLIC_URL=https://<that hostname>` and apply it: `docker compose up -d app`.

B. Caddy + your own domain: point an A record at the VM public IP, open 80/443 (section 2), then:

    sudo apt-get install -y caddy
    printf 'aria.example.com {\n  reverse_proxy 127.0.0.1:8080\n}\n' | sudo tee /etc/caddy/Caddyfile
    sudo systemctl reload caddy

Caddy gets the certificate automatically. Set `PUBLIC_URL=https://aria.example.com`.

## 6. Telegram cutover

1. BotFather -> /mybots -> your bot -> Bot Settings -> Menu Button -> set the URL to `PUBLIC_URL` (the Mini App is served from the app root). If a Mini App was created with /newapp, update its URL there as well.
2. The webhook re-points itself: the app calls setWebhook with the NEW secret within seconds of boot. Confirm from your own machine with `getWebhookInfo` (do not paste the bot token anywhere shared): url must equal `PUBLIC_URL/api/telegram/webhook` and there must be no `last_error_message`.
3. Never run two instances on the same bot token in webhook mode; the last setWebhook wins.

## 7. Verify

1. On the VM `curl -s http://127.0.0.1:8080/healthz`, and from outside `curl -s https://<your host>/healthz`: HTTP 200, `"ok":true`, and the `release` block shows the SHA you exported as `GIT_SHA` (compare with `git rev-parse HEAD`).
2. In Telegram send `/start` to the bot and expect a reply; open the Mini App from the menu button.
3. `docker compose ps` shows app and postgres `healthy`.
4. Run `./backup.sh` once and confirm it prints `OK`.

## 8. Oracle idle-reclamation risk

Oracle's Always Free documentation (page cited in section 2, read 2026-10-04) says compute instances are deemed idle if, over a 7-day period, 95th-percentile CPU is below 20% AND network utilization is below 20% AND (A1 shapes only) memory utilization is below 20%; idle Always Free instances may be reclaimed. A small bot like this will very likely meet that definition. Mitigations:
- (a) Upgrade the tenancy to Pay As You Go: Always Free resources stay free and this is the most reliable guard (confirm in current Oracle terms that reclamation no longer applies to your tier).
- (b) Size the VM small (1 OCPU / 6 GB) so utilization percentages are easier to keep up, and watch the metrics in the OCI console.
- (c) Do not rely on artificial load alone.
- (d) Keep offsite backups (section 9) so a reclaimed VM costs an hour, not the data.
Oracle can change these terms; recheck before relying on them.

## 9. Backups

- `./backup.sh` writes `backups/<UTC timestamp>/{aria.pgdump,aria.sqlite,SHA256SUMS}` and deletes folders older than `RETENTION_DAYS` (default 14).
- Schedule: `crontab -e` then `17 */6 * * * cd /home/ubuntu/aria/deploy && ./backup.sh >> backup.log 2>&1`
- Offsite: uncomment the `rclone` line in `backup.sh` after `rclone config`. A backup on the same VM does not survive loss of the VM.
- Test a restore on a spare machine at least once. Restore: `./restore.sh backups/<timestamp> --yes-overwrite` (it refuses without the flag; run `./backup.sh` first).

## 10. Rollback

- Bad deploy: `git checkout <previous-sha> && export GIT_SHA=$(git rev-parse HEAD) && docker compose up -d --build app`. Migrations are forward-only; do not go back across a migration without restoring a pre-deploy backup (run `./backup.sh` before every deploy).
- Bad data: `./restore.sh <backup> --yes-overwrite`.
- Whole host lost: rebuild on a new VM from section 2 and restore the latest offsite backup.

## 11. Security hygiene

- Secrets live only in `deploy/.env` on the host (chmod 600) and your password manager. `.env` and `backups/` are git-ignored. Never commit, paste into chat, or log them.
- Rotate `TELEGRAM_WEBHOOK_SECRET` at cutover (fresh value) and again if it ever shows up in logs: edit `.env`, `docker compose up -d app`.
- Do NOT carry over the stale `aria-real1-preview` Railway service or its variables; delete it if the Railway project is still reachable. Hosted REAL-money execution is outside this kit and not certified.
- Keep Postgres unpublished (no `ports:`), keep 8080 on 127.0.0.1, open only 22 (and 80/443 for Caddy). Key-only SSH, restricted to your IP.
- Consider rotating `TELEGRAM_BOT_TOKEN`, `RESEND_API_KEY` and Stripe keys if the Railway logs or dashboard may have been exposed. Do NOT rotate the four ARIA signing keys unless you intend to invalidate all licenses.
- Enable unattended-upgrades on the VM and take a backup before upgrading images.

## Verification evidence (fresh-boot test, 2026-10-04, no Docker)

Method: portable EnterpriseDB PostgreSQL 17.5 zip, user-level initdb on 127.0.0.1:54329, database `aria_selfhost_test`, empty SQLite file, dummy non-secret env, `npx tsx src/index.ts` from origin/main 2e4da25 (Node 24 locally; the image uses Node 22).
- 13 of 13 migrations applied; log line "Postgres migrations up to date"; `pgmigrations` rows = 13, 17 public tables.
- `GET /healthz` returned HTTP 200 with `"ok":true,"leads":0` and a release block.
- `VACUUM INTO` (the SQLite step in backup.sh) on the live WAL database: integrity_check ok, copy readable.
- `pg_dump --format=custom` then `pg_restore` into a second empty DB: `pgmigrations` rows = 13.
- Expected and harmless in the test: setWebhook returned 401 because the token was a dummy.

NOT verified: docker build, docker compose up, the app healthcheck inside the image, cloudflared, backup.sh/restore.sh end to end (only their pg_dump/pg_restore/VACUUM INTO steps were exercised, not through `docker compose exec`), arm64. `docker compose config` (with and without the tunnel profile) passed.
