# ARIA control plane on a small (1 GB) VM or a cheap VPS - addendum to RUNBOOK.md

Read `RUNBOOK.md` first; this file only changes sizing, HTTPS-without-a-domain and
the host choice. All commands run from `deploy/` unless stated.

Evidence legend: MEASURED = observed on this repo on 2026-10-04; CITED = read from the
official page named (read 2026-10-04, re-check before paying); UNVERIFIED = not run or
not confirmed from an official page. Nothing in this file was run in Docker.

Start command on a small host:

    docker compose -f docker-compose.yml -f docker-compose.small.yml up -d --build
    # with Cloudflare Tunnel:  ... --profile tunnel up -d --build

`docker compose -f docker-compose.yml -f docker-compose.small.yml config` (with and
without `--profile tunnel`, with a dummy `.env`) parses and shows the merged limits.

## 1. Memory measurements (MEASURED, Windows, no Docker)

Method: portable EnterpriseDB PostgreSQL 17.5 zip (user-level `initdb`/`pg_ctl`, port 54330,
database `aria_smallvm_test`), empty SQLite file, dummy non-secret env,
`TELEGRAM_TRANSPORT=webhook` with an invalid token (Telegram calls return 401, harmless),
Node 24.15 locally (the image uses Node 22), main at 8916bdf. Migrations: "Postgres
migrations up to date"; `/readyz` HTTP 200. Figures are Windows working set (WS) /
private bytes. **Linux numbers will differ** (shared pages are counted per process on
Windows; use `docker stats` on the real host).

| Process | After boot | After 20x `/healthz` + `/readyz` |
|---|---|---|
| App via `npm start` (as in the Dockerfile): node child | 113 MB WS | 114 MB WS |
| ... plus the `tsx` parent + `npm` wrapper processes | ~58 + ~62 MB WS | unchanged |
| **App total via `npm start`** | **~233 MB WS** | ~234 MB |
| App via `node --import tsx src/index.ts` (override) | 85 MB WS (83 MB private) | 87 MB WS (85 MB private) |
| Postgres 17, default settings, 6 background procs | 102 MB WS (28 MB private) | 126 MB WS / 7 procs (28 MB private) |

Notes: the idle app held 2 Postgres connections (`pg_stat_activity`). `src/db-pg.ts` creates
`new Pool({ connectionString })` with no `max`, so the `pg` default (10) applies and there is
no env knob; app code was deliberately not changed. `max_connections=20` leaves room for 10 pool
connections + `pg_dump` + `psql`. Load (real Telegram traffic, engine sync, Stripe) was not
measured; headroom below is a judgment, not a measurement.

## 2. Budget and the settings in `docker-compose.small.yml`

| Item | Limit / setting | Basis |
|---|---|---|
| OS + dockerd + containerd | ~250-300 MB | UNVERIFIED estimate for Ubuntu 24.04 minimal; check `free -m` before starting the stack |
| app | `mem_limit: 320m`, `--max-old-space-size=192` | measured 85-115 MB idle, ~3x headroom for bursts; heap cap < container cap so V8 collects before the kernel kills |
| postgres | `mem_limit: 256m` | 64 MB shared_buffers + ~20 backends x a few MB + WAL buffers/maintenance |
| cloudflared (tunnel profile only) | `mem_limit: 96m` | not measured; the Go client is small, raise it if `docker stats` shows pressure |
| Sum of limits | 672 MB (576 MB without tunnel) | limits are ceilings, typical use is far lower |
| Swap | 2 GB file (section 3) | safety net for spikes, `docker build`, `npm install` |

Why the app uses `node --import tsx` instead of `npm start`: removes two wrapper processes
worth ~120 MB WS. Verified on the bare machine only. If the container will not start, delete
the `command:` line from the override to fall back to `npm start`.

Postgres flags (defaults target a much bigger machine):
- `shared_buffers=64MB` (default 128 MB): the dataset is small; the rest is left to the OS page cache.
- `effective_cache_size=256MB`: planner hint only (allocates nothing); roughly what the OS cache will hold.
- `work_mem=2MB` (default 4 MB): per sort/hash node per connection; keeps worst case bounded.
- `maintenance_work_mem=32MB` (default 64 MB): vacuum/index builds.
- `max_connections=20` (default 100): each backend costs memory; pool max is 10.
- `max_wal_size=256MB`, `min_wal_size=64MB`, `checkpoint_completion_target=0.9`: less WAL disk, smoother checkpoints on a small disk.
- `autovacuum_max_workers=2`, `max_worker_processes=4`, `max_parallel_workers_per_gather=0`: fewer helper processes; parallel query helps nothing at this size.
- `jit=off`: avoids loading LLVM JIT for no benefit on tiny queries.
These are standard sizing heuristics, not benchmarked against this app. UNVERIFIED in a container.

## 3. Swap file (Ubuntu/Debian)

A 1 GB host with no swap gets OOM-killed during `docker compose build` (npm install) or a
Postgres spike. Swap on the boot disk is slow but turns a crash into a slowdown.

    sudo fallocate -l 2G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
    echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf && sudo sysctl --system
    free -m        # Swap line shows 2047

Do not rely on swap permanently: if `free -m` shows constant swap use, move up one VM size.

## 4. HTTPS without owning a domain

Telegram requires a public https URL for the webhook and for the Mini App / menu button
URL, and the app re-registers it from `PUBLIC_URL` on every boot, so the URL must be stable.

| Option | Needs | Verdict |
|---|---|---|
| (i-a) Cloudflare **quick** tunnel (`cloudflared tunnel --url http://localhost:8080`) | free, no account | **Not usable for production.** CITED (developers.cloudflare.com ... trycloudflare): "The hostname changes each time you create a Quick Tunnel", it stops when cloudflared stops, no uptime guarantee, 200 in-flight request cap, "for testing and development". Every restart changes the URL, breaking the webhook and the BotFather Mini App URL. |
| (i-b) Cloudflare **named** tunnel | free Cloudflare account **and a domain added to Cloudflare** | CITED (create-remote-tunnel doc): "you must add a website to Cloudflare" before publishing an application. Stable and no inbound ports, but you need a domain. |
| (ii) Caddy + `<ip>.sslip.io` / `<ip>.nip.io` | stable public IPv4, inbound 80+443 | Works without buying a domain. CITED (nip.io page): hostnames embed the IP (`34-1-2-3.sslip.io`), no wildcard certs, Let's Encrypt limits for these domains were raised over time but the page itself advises trying the sibling domain if you are rate-limited. CITED (letsencrypt.org/docs/rate-limits): 50 certs per registered domain per 7 days, 5 duplicate certs per identical name set per 7 days, 5 failed validations per hour. Risks: a shared third-party DNS service you do not control; the IP in the hostname changes if the VM IP changes (needs a reserved static IP, which on GCP is billed, see 5.1); sslip.io's own terms/uptime were not confirmed (the fetch of sslip.io redirected to nip.io). |
| (iii) Cheap domain (~USD 1-12/yr, registrar prices vary, UNVERIFIED) | pay once | Works with either Caddy (A record) or a named Cloudflare Tunnel (move DNS to Cloudflare, free). |

**Recommendation: (iii) a cheap domain + Cloudflare named tunnel.** It is the only option
that gives a stable URL, needs no inbound web ports and no static public IP, and survives
VM replacement by just re-running cloudflared with the same token. (The tunnel is outbound
only, but the VM still needs outbound internet, so on GCP keep the ephemeral external IP.) Second choice: Caddy + sslip.io on a VPS that
includes a static IPv4 in the price (Hetzner/Vultr/DO), accepting the third-party DNS dependency.
If the URL ever changes, update `PUBLIC_URL` and BotFather's Menu Button.

## 5. Providers

### 5.1 Google Cloud e2-micro (Compute Engine)

CITED (docs.cloud.google.com/free/docs/free-cloud-features): free tier = 1 non-preemptible
`e2-micro` per month in `us-west1` (Oregon), `us-central1` (Iowa) or `us-east1` (South
Carolina); 30 GB-months standard persistent disk; 1 GB outbound transfer from North America
to all region destinations (excluding China and Australia) per month. e2-micro has 2 shared
vCPUs and 1 GB RAM (spec from Google machine-type docs, not re-fetched).

Costs the free tier does NOT cover: the external IPv4 address. Owner's figure is about
USD 0.004-0.005 per hour (about USD 3-3.7/month at 730 h); I could not extract the exact
number from Google's pricing page (the fetch returned no table), so UNVERIFIED: check
cloud.google.com/vpc/network-pricing. Egress over 1 GB/month is billed at standard rates.

Create steps (owner does this in the Console; this assistant creates nothing):
1. Console -> Compute Engine -> VM instances -> Create instance. Region `us-central1` (or `us-west1` / `us-east1`), machine type `e2-micro`.
2. Boot disk: Ubuntu 24.04 LTS x86/64, **Standard persistent disk**, 30 GB (not Balanced/SSD: those are not in the free allotment).
3. Firewall: do not tick HTTP/HTTPS for a Cloudflare Tunnel setup; tick them only for Caddy.
4. Networking: keep the default ephemeral external IP (billed, see above) or none if you will use IAP SSH + tunnel (a VM with no external IP cannot reach the internet without Cloud NAT, which is also billed, so for simplicity keep the IP).
5. Create, then SSH from the Console, then follow RUNBOOK sections 3-4 with the `-f docker-compose.small.yml` override and section 3 above (swap).
6. Budget alert: Console -> Billing -> Budgets & alerts -> Create budget, amount USD 5, alert thresholds 50/90/100 percent, email to you. Alerts do not stop spending; they only notify.

Traffic estimate vs the 1 GB cap (MEASURED sizes): the Mini App is `public/index.html` ~22 KB plus
`public/app.js` ~34 KB before compression, so a cold open is under ~60 KB; the engine
download is ~85 KB; Telegram webhook replies and API JSON are bytes to a few KB. Roughly
10,000+ cold Mini App opens fit in 1 GB, so a small user base fits. Things that can blow the
cap: offsite backups uploaded every 6 hours (upload daily instead if dumps grow), and
anything that downloads large files from your server. Inbound traffic (Telegram webhook
requests, `apt`, Docker image pulls) is not outbound egress. Memory pressure is a bigger
risk than bandwidth.

### 5.2 Hetzner Cloud

CITED (docs.hetzner.com/cloud/servers/overview): primary IPv4 costs EUR 0.50/month
(excl. VAT), IPv6 primary IPs are free; locations listed on hetzner.com/cloud: Falkenstein,
Nuremberg, Helsinki, Hillsboro (Oregon), Ashburn (Virginia). The hetzner.com/cloud page marked the
"Cost-Optimized" tier as currently unavailable when read. Plan prices were not extractable
from the pages I could fetch; the owner's figure of about EUR 4.5/month for a 4 GB plan is
UNVERIFIED here. A 4 GB server removes the need for the small override (the stock compose
file is then fine, the override still harmless). Payment methods page returned 404:
UNVERIFIED which cards/PayPal Hetzner accepts; Hetzner also runs identity checks on new accounts.

### 5.3 Vultr and DigitalOcean

- DigitalOcean CITED (digitalocean.com/pricing/droplets): cheapest Basic Droplet USD 4/month is 512 MB RAM, 1 vCPU, 10 GB SSD, 500 GB transfer, too small for app + Postgres without heavy swap; step up to a 1-2 GB plan (price not captured). Accepts "Visa, Mastercard, American Express, Discover, PayPal, Google Pay, and Apple Pay": PayPal/Google Pay are alternatives if cards are rejected elsewhere.
- Vultr: the pricing and product pages returned 403 to the fetcher. Plans, prices and payment methods are UNVERIFIED; check vultr.com yourself.

## 6. EMERGENCY STOPGAP: run on the owner's Windows PC (no Docker)

**Honest drawbacks:** sleep, reboot, Windows Update or a closed lid = full outage, and Telegram
will retry then drop updates; the four ARIA signing keys, bot token and Stripe keys sit in
plain env on a dev machine you also browse the web with; no backups unless you schedule
them; the PC's home IP and power are single points of failure. Acceptable for days and for
testing, **not for paying users**. Do not use it as the long-term host.

The mechanics below were run on 2026-10-04 with dummy values (Node 24, PostgreSQL 17.5 zip);
the tunnel step was NOT run (needs your Cloudflare account/domain).

1. Install Node 22+ (`node -v`). Clone the repo, `npm install`.
2. Portable Postgres: download the EnterpriseDB "binaries" zip for 17.x (postgresql.org -> Download -> Windows -> EDB zip). Extract only a SHORT path such as `C:\pgx`: the full zip contains pgAdmin files with paths too long for default Windows limits and extraction fails. `bin`, `lib`, `share` are enough.
3. Initialise and start (PowerShell, user level, no admin needed):

       C:\pgx\pgsql\bin\initdb.exe -D C:\pgx\data -U postgres -A trust -E UTF8
       Start-Process C:\pgx\pgsql\bin\pg_ctl.exe -ArgumentList '-D','C:\pgx\data','-o','"-p 54330 -c listen_addresses=127.0.0.1"','-l','C:\pgx\pg.log','start' -WindowStyle Hidden
       C:\pgx\pgsql\bin\createdb.exe -h 127.0.0.1 -p 54330 -U postgres aria

   `-A trust` is safe only because it listens on 127.0.0.1; never expose the port. (Calling `pg_ctl start -w` directly from some tool shells hangs because the server inherits the console handles; start it detached as above.)
4. Put real values in a `.env` at the repo root (same variable names as `deploy/.env.template`), plus `DATABASE_URL=postgres://postgres@127.0.0.1:54330/aria`, `DB_PATH=C:\aria\aria.db`, `PORT=8080`. Copy secrets from your password manager; never paste them into chat.
5. Start: `node --import tsx src/index.ts` (or `npm start`). Check:

       curl.exe -i http://127.0.0.1:8080/readyz     # must be 200
       curl.exe http://127.0.0.1:8080/healthz

   Log must contain "Postgres migrations up to date".
6. HTTPS: install `cloudflared` (Cloudflare docs), create a named tunnel for a hostname on your Cloudflare domain pointing at `http://localhost:8080`, run it as a service, set `PUBLIC_URL` to that hostname, restart the app. A quick tunnel changes URL on every restart (section 4), so use it only for a one-hour smoke test.
7. Reduce outages: Settings -> Power -> never sleep when plugged in; pause Windows Update active hours; run Node and Postgres via Task Scheduler "at startup" tasks. Backups: `C:\pgx\pgsql\bin\pg_dump.exe -h 127.0.0.1 -p 54330 -U postgres --format=custom -f aria.pgdump aria` and copy `aria.db` using `VACUUM INTO` (RUNBOOK section 1.2 shows the node one-liner) to somewhere off the PC.
8. Stop: `C:\pgx\pgsql\bin\pg_ctl.exe -D C:\pgx\data stop -m fast`. Migrate to a real host as soon as one exists: dump with step 7, restore with `./restore.sh import --yes-overwrite` (RUNBOOK section 4).

## 7. What is NOT verified

Docker build, `compose up`, the `node --import tsx` command inside the image, Postgres flags
inside the `postgres:16` container (they are valid 16 settings, but never started), memory on
Linux, arm64/x86 image availability, cloudflared, sslip.io terms, Hetzner/Vultr/GCP-IP
prices. Treat the first real `docker compose up` plus `docker stats` as the real test and
adjust `mem_limit` from what it shows.
