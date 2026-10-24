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

SMALL HOSTS (1 GB RAM VM, GCP e2-micro, cheap VPS, or a Windows-PC stopgap): see
`SMALL-VM-ADDENDUM.md` and the `docker-compose.small.yml` override
(`docker compose -f docker-compose.yml -f docker-compose.small.yml up -d --build`). It also covers
HTTPS without a domain. After any start, check `GET /readyz` (HTTP 200 = SQLite and Postgres
migrations ready); `/healthz` alone is only liveness.

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

- Hosted PAPER engine build inputs (REQUIRED, the image build fails closed without them): `ARIA_ENGINE_COMMIT_SHA` (exact 40-char commit of the aria-engine repo) and `ARIA_ENGINE_GIT_TOKEN` (read-only token for it). **aria-engine is a PRIVATE repo: a host without read access to AIWMCX/aria-engine cannot build this image.** The token is used only in the builder stage and is not in the final image. Hosted fleet runtime switches: `FLEET_ENABLED` (default false = fleet dark), `FLEET_ALLOWED_TELEGRAM_IDS` (founder-only first deploy), `FLEET_MAX_CONCURRENT_TENANTS` (default 3; an empty value is treated as unset), `FLEET_MIN_FREE_MEMORY_MB` (default 400), and `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15` on Railway. Full ordered checklist, kill switch (`/fleet_stop_all`) and rollback: section 12 below and the "Hosted PAPER fleet: deploy hardening" section of docs/FLEET_MANAGER_RUNBOOK.md.

Import old data (only if you exported in section 1). Put the two files in a folder, named exactly `aria.pgdump` and `aria.sqlite` (e.g. `deploy/import/aria.pgdump` and `deploy/import/aria.sqlite`), then:

    ./restore.sh import --yes-overwrite

It stops the app, recreates the `aria` database from the dump, replaces `/data/aria.db` and starts the app. Migrations are idempotent and see the imported `pgmigrations` table. Skip this for a fresh start.

Start (if you did not just run restore):

    export GIT_SHA=$(git rev-parse HEAD) GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
    docker compose up -d --build          # add --profile tunnel for Cloudflare Tunnel
    docker compose ps
    docker compose logs app | grep -i -E "migrat|BOT_BOOT|webhook|error"

You must see "Postgres migrations up to date". The app treats a migration failure as NON-fatal (logs an error, keeps running with engine routes unavailable), so `/healthz` (liveness, always 200) can be green while Postgres features are broken. Always check that log line, and check `/readyz` (readiness): it must return HTTP 200 after first boot. HTTP 503 means SQLite or Postgres/migrations are not ready; the JSON `postgres` block shows `configured`/`ready`/`migrations` and never credentials.

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

1. On the VM `curl -s -i http://127.0.0.1:8080/readyz` must be HTTP 200 with `"ready":true` (check this, not only `/healthz`). Then `curl -s http://127.0.0.1:8080/healthz`, and from outside `curl -s https://<your host>/healthz`: HTTP 200, `"ok":true`, and the `release` block shows the SHA you exported as `GIT_SHA` (compare with `git rev-parse HEAD`).
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

## 12. Hosted PAPER fleet: deploy and rollback

Short form; the full table of switches, the cap-sizing formula and what is
unverified are in the "Hosted PAPER fleet: deploy hardening" section of
`docs/FLEET_MANAGER_RUNBOOK.md`.

Before enabling: check the `invites` table for other approved users; set
`ARIA_ENGINE_GIT_TOKEN`, `ARIA_ENGINE_COMMIT_SHA=766dcdbc7aca1dad54d6294729fba1f45a8b6481`,
`FLEET_ENABLED=true`, `FLEET_ALLOWED_TELEGRAM_IDS=<founder>`,
`FLEET_MAX_CONCURRENT_TENANTS=3`, `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15`
(on non-Railway hosts the equivalent is giving the container a stop grace of
at least 15 s, e.g. compose `stop_grace_period: 15s`). Then verify `/healthz`
(`engine.available`, `engine.sha`, `fleet.enabled`, `fleet.available`),
run founder `/paper_start` -> `/paper_status` -> `/paper_stop`, and do one
redeploy to confirm rehydration before widening access.

Rollback / kill switch: admin `/fleet_stop_all` (stops all tenants and marks
them stopped; the reply says how many failed; users can still `/paper_start` until `FLEET_ENABLED=false`), then `FLEET_ENABLED=false` and redeploy. `/healthz`
`fleet.enabled:false` confirms. The Docker image build and Linux runtime
behaviour have not been verified.

## 13. Shared launch discovery (one process, key held only there)

One supervised child, `aria discovery run --out /data/discovery/launches.ndjson`,
holds the streaming endpoints and appends every decoded launch to an NDJSON
file on the volume. Tenants tail that file (path only in their own
`config.json`); they never receive a stream URL or key. Off by default.

**Railway variables (control plane service):**

| Variable | Value |
| --- | --- |
| `DISCOVERY_ENABLED` | `true` |
| `ARIA_STREAM_RPC_URL` | `wss://...` (provider websocket, key inside) |
| `ARIA_STREAM_RPC_HTTP_URL` | `https://...` (provider HTTP RPC, key inside) |
| `ARIA_ENGINE_COMMIT_SHA` | the aria-engine commit that contains PR B2 (`aria discovery run`, `discovery.fileTail`). This is a build ARG: **bump it to the merged engine SHA and redeploy**. An older pinned engine is detected and discovery stays off (`reason` says so). |

Only the two `ARIA_STREAM_*` variables (plus non-secret TLS trust vars `NODE_EXTRA_CA_CERTS`/`NODE_USE_SYSTEM_CA` if set) go to the discovery child, together
with the same operating-system basics tenants get. `buildTenantEnv` is
unchanged and additionally refuses any `ARIA_STREAM*` name in `extraEnv`.

**Verify (`/healthz`, no auth):**

```
"discovery": { "enabled": true, "running": true, "state": "running",
  "restarts": 0, "lastEventAgeMs": <ms, small>, "heartbeatAgeMs": <under ~15000>,
  "stale": false, "counters": { "connected": true, "decoded": <growing>,
  "authFailures": 0, "subscribeErrors": 0, ... }, "programsWatched": {"watched":3,"total":3} }
```

- `enabled:false` + `reason`: a variable is missing/malformed, or the packaged
  engine is too old. Reasons never contain a value.
- `authFailures > 0`: provider rejected the key. `stale:true`: the producer's
  heartbeat is older than 60 s. `restarts` rising: the child keeps crashing;
  read `/data/tenant-logs/discovery.log` (URLs and key fragments are redacted).
- Public RPC endpoints drop events; use a paid streaming provider.

**Tenants:** before each tenant spawn the control plane makes a direct, atomic
edit of that tenant's `config.json` (only the `discovery` key: `file-tail` +
`/data/discovery/launches.ndjson`; temp file + rename, mode 0600, nothing else
touched). A tenant with no `config.json` yet (never started) is skipped and
picked up at its next spawn. Note: a tenant only *consumes* the feed when its
engine runs with `market.kind = "real-discovery"`; hosted tenants use the
engine's default config today, so enabling discovery does not by itself change
what they trade on (paper only either way).

`stale` in the `/healthz` discovery block is true when the producer heartbeat
is older than 60 s OR no launch has arrived for `DISCOVERY_MAX_EVENT_AGE_MS`
(optional, default 900000 = 15 min, minimum 60000). `counters` also carries
`writeErrors`, `rotations`, `linesWritten`; alarm on `writeErrors > 0`.

The engine pin must contain `aria discovery run` AND the
`discovery.fileTail` config key (engine PR #12 head or later); an engine
pinned at the first PR #12 commit (58154f1) is reported as unsupported.

**Disable:** set `DISCOVERY_ENABLED=false` (or delete it) and redeploy. The
child is not started, `/healthz` shows `discovery.enabled:false`, and each
tenant that still points at our feed is switched back to `polling` at its next
spawn. Tenant desired state is never touched by any of this. To stop it without
a redeploy, remove the two `ARIA_STREAM_*` variables the same way.

**Unverified:** Linux/Railway behaviour (SIGTERM flush, volume permissions) and
a run with a real paid provider key have not been exercised.

## 14. Paper sniper (PAPER ONLY)

The aria-engine honest paper sniper (`src/paper/sniper/*`, `docs/PAPER_SNIPER.md` in the
engine repo) runs inside a hosted tenant when its `config.json` has
`market.kind="real-discovery"` AND `discovery.source="file-tail"`. This control plane seeds
exactly that, for allow-listed Telegram ids only, and adds a founder panel, a daily report,
`/paper_report`, `/kill`, `/resume` and assisted-snipe alerts. **It never signs or sends a
transaction.** If you trade an alert, you choose the amount and sign in your own wallet.

**Prerequisites:** section 13 (shared discovery) working, `FLEET_ENABLED=true`, and the
founder already has a hosted tenant (`/paper_start`).

**Railway variables (control plane service):**

| Variable | Value |
| --- | --- |
| `PAPER_SNIPER_ENABLED` | `true` (default false). |
| `PAPER_SNIPER_TELEGRAM_IDS` | `<founder numeric Telegram id>` (comma list). **Enabled + blank/malformed refuses to boot.** Also keep the same id in `FLEET_ALLOWED_TELEGRAM_IDS` if that is set. |
| `PAPER_SNIPER_REPORT_HOUR_UTC` | `0`-`23`, default `13`. The daily report is sent once, within 2 h of that hour. |
| `PAPER_SNIPER_ALERTS_PER_HOUR` | optional, default `12` per recipient; excess alerts are dropped and summarised once. |
| `ARIA_ENGINE_COMMIT_SHA` | build ARG, **bump to `4fadcd3554e67489cfd2eeb686a2815dbaeafbed` (or later) and redeploy**. An older engine has no sniper; `/healthz` says so. |

Jupiter key: the engine reads an optional key from the env var NAMED in
`launchSafety.jupiter.apiKeyEnvVar`, but hosted tenants receive no secret-looking variable
(`buildTenantEnv` refuses them), so the sniper runs keyless against `api.jup.ag` (rate limits
apply). Jupiter is OFF by default in the engine (`launchSafety.jupiter.enabled=false`).

**What gets written to the tenant's `config.json`** (atomic, 0600, at the tenant's next
spawn; keys verified against engine 4fadcd3): `market.kind="real-discovery"`, `sniper.buyLamports="50000000"`
(0.05 SOL), `sniper.maxOpen=3`, `sniper.maxExposureLamports="300000000"` (0.3 SOL),
`sniper.dailyLossHaltLamports="150000000"` (0.15 SOL, UTC day), `sniper.stopLossBps=3000`,
`sniper.maxHoldMs=1800000`. The previous values are recorded in `<runtimeDir>/paper-sniper-seed.json`
(never inside `config.json`). **While the sniper is enabled, every spawn re-asserts these six limits: an operator
edit to one of them in a seeded tenant's `config.json` is overwritten at the next spawn.** Change the limits in code, or
disable seeding, rather than hand-editing. (Disabling leaves a value alone only if it no longer equals what we wrote.)
**A running tenant only picks this up after a restart:**
`/paper_stop` then `/paper_start`.

**Verify:**
1. `GET /healthz` -> `"paperSniper": {"enabled": true, "tenants": 1}` (after the founder's tenant has
   spawned once; `tenants` counts tenants seeded since this process booted). The public endpoint carries only
   `enabled` and `tenants`; when `enabled` is false the reason (switch off, fleet off, discovery off, engine too old)
   is in the control-plane boot log line "paper sniper services are OFF" (never a value).
2. `/paper_start` (or restart), then look in the founder panel (Telegram Mini App) for the **Paper sniper**
   section: state `RUNNING`, MAIN vs BASELINE table. The section is hidden for anyone not on the allow-list
   and while the feature is off (`/api/paper-sniper/*` answers 404).
3. `/paper_report` returns the same numbers as text. Files on the volume:
   `<tenants>/<clientId>/.aria/state/sniper-ledger.jsonl`, `sniper-status.json`, `sniper-marks.json`.
4. With the default engine safety gate (`minLiquiditySol=5`, top-10 holders <= 50%) almost every FRESH
   launch is a `safety_block` skip. That is the engine's documented behaviour, not a bug; zero trades for
   a long time is expected until the gate is deliberately relaxed in the tenant config.

**Kill / resume:**
- Fastest: `/kill` in Telegram (or the panel KILL button) writes `<runtimeDir>/KILL`; new entries stop in about 1 s, open
  PAPER positions keep being managed. `/kill flatten` also closes them. `/resume` (or panel RESUME) removes the flag and
  writes the `RESUME` token (also clears a latched consecutive-failure halt).
- Fleet-wide: `/fleet_stop_all` (admin only, unchanged).
- Full off: set `PAPER_SNIPER_ENABLED=false` and redeploy. At each tenant's next spawn only what we seeded is
  reverted (market.kind and the six sniper keys, only where the value is still ours); `paper-sniper-seed.json` is removed.

**Telegram:** daily report at the configured UTC hour; `/paper_report`, `/kill`, `/resume` for allow-listed ids
(everyone else gets "This command is not available"). Entry alerts (MAIN strategy only) show the mint in copyable code
formatting, source, which safety checks passed, paper entry details and a Jupiter SOL-to-token button; exit alerts (full
and partial, with the reason) offer the token-to-SOL button (not for `honeypot_loss`/`exit_error_loss`). Every alert ends:
"PAPER signal. If you trade, you choose the amount and sign in your own wallet. Verify afterwards in the founder panel."

**Alert delivery semantics:** at-least-once. A Telegram send has a 10 s timeout; a failed or timed-out send is NOT recorded as
sent and is retried on the next polls (3 attempts in total, then logged and dropped; pending retries are in memory only).
The byte offset and sent keys are persisted after each poll, so a crash between a send and that write can repeat an alert
after restart. Rate-limited alerts are dropped (not retried late); exits for a trade whose entry alert was delivered always
bypass the hourly limit. A malformed ledger row is skipped and logged without losing the rest of its batch. A failing
database lookup in the alert poller logs a warning at most once per 10 minutes. `/paper_report`, `/kill` and `/resume`
answer only in private chats. A failing report-state file cannot make the daily report repeat within a process.

**Numbers are a model.** Fills, fees and exits are simulated; closed-trade statistics exclude open positions; below 200 closed
trades every view says INSUFFICIENT SAMPLE. The summary is computed by `src/paper-sniper/data.ts`, a TS port of the engine's book +
report (cross-checked against the engine's own `buildReport` on a fixture; the bootstrap CI, paired view and profit factor are not
ported - run `aria paper report --json` in the tenant for those).

**Unverified:** a real tenant running the sniper on Railway/Linux with a live feed; Telegram delivery of alerts and the Mini App panel
in a real client; behaviour at ledger sizes beyond 64 MiB (newest window only, flagged `truncated`).

## 15. Private read-only RPC relay (hosted tenants; PR F1)

**Why:** hosted tenant engines default to the public `api.mainnet-beta.solana.com`, which returns 429 for
`getTokenLargestAccounts` and friends, so the fail-closed safety gate BLOCKs every launch. The relay lets paper-sniper
tenants use the founder's paid provider **without the provider key ever reaching a tenant**. It runs inside the control plane,
listens on **127.0.0.1 only** (a separate port; never Railway's public `PORT`), accepts only read-only JSON-RPC methods and
attaches the key server-side. Each tenant gets a random 256-bit token; its config holds
`rpc.url = http://127.0.0.1:<RPC_RELAY_PORT>/rpc/<token>` (the token is not the provider key).

**Railway variables (control plane service):**

| Variable | Value |
| --- | --- |
| `RPC_RELAY_ENABLED` | `true` (default off). Also needs `ARIA_STREAM_RPC_HTTP_URL` (already set for discovery; https only). |
| `RPC_RELAY_PORT` | optional, default `8899`; must differ from `PORT`. |
| `RPC_RELAY_TENANT_RPS` / `RPC_RELAY_TENANT_BURST` | optional, default `5` / `10` per tenant. |
| `RPC_RELAY_GLOBAL_RPS` / `RPC_RELAY_GLOBAL_BURST` | optional, default `25` / `50` across all tenants: size this under the provider plan. |
| `RPC_RELAY_MAX_BODY_BYTES`, `RPC_RELAY_MAX_RESPONSE_BYTES`, `RPC_RELAY_MAX_BATCH`, `RPC_RELAY_UPSTREAM_TIMEOUT_MS` | optional; defaults 16 KiB, 2 MiB, 10, 8000 ms. |

**Allowed methods:** getAccountInfo, getMultipleAccounts, getTransaction, getSignaturesForAddress, getTokenLargestAccounts,
getTokenAccountBalance, getTokenAccountsByOwner, getBalance, getSlot, getMinimumBalanceForRentExemption, getGenesisHash.
Everything else (sendTransaction, simulateTransaction, requestAirdrop, getProgramAccounts, getLatestBlockhash, ...) is rejected
with a JSON-RPC error; a batch is accepted only if every element is allowed. Over-limit requests get HTTP 429 (the engine treats
that as an error and fails closed); unknown tokens get 403.

**Rollout:** set `RPC_RELAY_ENABLED=true` and redeploy. The tenant config is rewritten at each tenant's **next spawn**, so
existing tenants need `/paper_stop` + `/paper_start` (or the redeploy itself, which respawns them) to pick up the new `rpc.url`.
Only paper-sniper tenants (section 14) are seeded. Check `/healthz`: `rpcRelay` = `{enabled, requests, rejectedMethod, rateLimited, upstreamErrors}`
(counts only). Rising `rateLimited` means raise the limits or the provider plan.

**Rollback:** set `RPC_RELAY_ENABLED=false` and redeploy. At each tenant's next spawn `rpc.url` is restored to its previous value
only if it still equals what we wrote; `rpc-relay-seed.json` is removed. The per-tenant `rpc-relay-token` file is left in place.
