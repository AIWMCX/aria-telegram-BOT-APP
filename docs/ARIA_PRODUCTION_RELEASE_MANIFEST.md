# ARIA Production Release Manifest

**Author:** release-integrity investigation session, 2026-09-19
**Standing rule this document exists to serve:**

> A GitHub commit is not deployed merely because it exists. A merged branch is
> not production merely because main contains it. A Railway deployment marked
> SUCCESS is not sufficient if it built the wrong SHA. ARIA may be called
> current only when: INTENDED_RELEASE_SHA = origin/main SHA = Railway
> deployment source SHA = running application's reported build SHA, and
> production smoke tests pass.

This document does three things: (1) states the current value of all four
links in that chain, as observed via the Railway MCP tools and `git
fetch`/`rev-parse` against both repos' real remotes (not inference, not a
value carried over from an earlier session); (2) classifies every commit
currently ahead of each repo's `origin/main` on its named in-flight branch;
(3) records the one P0 finding this investigation exists to surface — the
hosted PAPER engine has no real provisioning story on Railway today.

All evidence below was gathered read-only. No deploy was triggered, no
Railway variable was changed, no branch other than this document's own
(`chore/release-identity-and-manifest`, based off `aria-telegram-BOT-APP`
`origin/main`) was written to.

---

## 1. The four-link chain, as of 2026-09-19

| Link | Value | Source |
|---|---|---|
| `origin/main` SHA (aria-telegram-BOT-APP) | `f2e1ffd9fe31af18959712db833b8237cf54e946` | `git fetch origin --prune && git rev-parse origin/main` |
| Railway deployment source SHA (service `aria-telegram-BOT-APP`) | `f2e1ffd9fe31af18959712db833b8237cf54e946` | `list-deployments` → latest deployment `5d1ee031-7797-4773-85bc-4f750abb0da0`, `status: SUCCESS`, `meta.commitHash` |
| Running application's reported build SHA | **Did not exist before this branch.** `/healthz` returned no build-identity field at all prior to this change. | Read of `src/server.ts`'s `/healthz` handler on `origin/main` |
| Production smoke test | Not run as part of this investigation (out of scope — no deploy was triggered) | — |

**Conclusion:** the first two links agree today (main HEAD == what Railway
actually built and is running). The third link was simply **absent** — there
was no way for a human or an automated smoke test to ask the running process
"what SHA are you actually running" and get an answer, which is exactly the
gap the standing rule is designed to catch (a future deploy could silently
build the wrong SHA and nothing would notice). Task 2 below closes that gap
in code; it has **not** been deployed as part of this task, so as of this
writing the live service still does not expose it — that requires a
merge-and-deploy this task is explicitly not authorized to do.

---

## 2. Task 1 — Engine packaging dependency trace (read from source, both repos)

**Scope note:** none of this code is on `origin/main` in either repo yet. It
exists only on `aria-telegram-BOT-APP`'s `origin/work/hosted-paper-engine-impl`
(Fleet Manager) — read via a second worktree, never modified. The two other
in-flight branches were not touched.

### 2.1 What `spawnTenant()` actually invokes

`src/fleet/fleet-manager.ts`:

```ts
/** Default invocation: run the real aria-engine CLI via tsx, unmodified, from the sibling checkout. */
export function realEngineInvocation(engineRepoPath: string): EngineInvocation {
  return {
    buildStart: () => ({ command: process.execPath, args: ["--import", "tsx", "src/cli.ts", "paper", "start"], cwd: engineRepoPath }),
    buildStop: () => ({ command: process.execPath, args: ["--import", "tsx", "src/cli.ts", "paper", "stop"], cwd: engineRepoPath }),
    readyMarker: "paper engine started",
  };
}
```

`src/fleet/instance.ts` wires this into the one process-wide `FleetManager`:

```ts
export const fleetManager = new FleetManager({
  engineInvocation: realEngineInvocation(CONFIG.ARIA_ENGINE_REPO_PATH),
  ...
});
```

`src/config.ts`:

```ts
ARIA_ENGINE_REPO_PATH: z.string().optional().default("../aria-engine"),
```

`spawnTenant()` (`fleet-manager.ts`) calls `this.opts.engineInvocation.buildStart()`
and passes the resulting `{ command, args, cwd }` straight into
`TenantProcess`'s constructor (`src/fleet/tenant-process.ts`), which does a
plain `node:child_process` `spawn(command, args, { cwd, env: {...}, stdio: [...] })`.
No package manager step, no artifact download, no image-baked copy — it is a
literal `node --import tsx src/cli.ts paper start` run with `cwd` pointed at
whatever `ARIA_ENGINE_REPO_PATH` resolves to.

### 2.2 What kind of dependency is this?

**A dev-only sibling-checkout path.** `ARIA_ENGINE_REPO_PATH` defaults to the
relative path `"../aria-engine"` — i.e. it assumes the two repos are checked
out as siblings on the same filesystem, exactly the layout this investigation
itself was run against (`C:\Users\AIWMC\dev\aria-telegram-BOT-APP` next to
`C:\Users\AIWMC\dev\aria-engine`). It is **not**:

- an npm-installed package (`package.json`'s only related dependency is
  `tsx` itself, `^4.19.2` — a TypeScript runner, not the engine);
- a downloaded binary (no fetch/download step anywhere in `fleet-manager.ts`
  or `tenant-process.ts`);
- a Docker-image-baked copy (see 2.3 — the Dockerfile never copies an
  `aria-engine` checkout into the image).

There **is** a top-level `engine/` directory in the `aria-telegram-BOT-APP`
repo (`engine/package.json`, `engine/src/`), but reading it shows it is a
*different*, much smaller package — `"name": "@aria/engine"`, version
`0.1.0`, a handful of files — unrelated to the real `aria-engine` product
(`"name": "aria-engine"`, version `0.7.0-beta.4`, 60+ test files, the actual
PAPER trading engine with `bin: { aria: "./dist/cli.js" }`). The Dockerfile
does not `COPY` this `engine/` directory into the image either way, so it is
inert either way — a genuinely separate, unrelated artifact, not a disguised
copy of the real engine.

### 2.3 Does this have any chance of working on Railway?

**No — confirmed, not inferred.** The production `Dockerfile` (verified
against both the repo file and the actual Railway build log for the live
deployment, step-for-step identical) is:

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY migrations ./migrations
RUN mkdir -p /data
ENV DB_PATH=/data/aria.db
ENV NODE_ENV=production
EXPOSE 8080
CMD ["npm", "start"]
```

There is no `COPY engine`, no `COPY ../aria-engine`, no git-submodule
checkout, no npm install of any `aria-engine`/`@aria/engine` package (it
isn't in `dependencies`), and no build step that clones the `aria-engine`
GitHub repo. The resulting container has **no `aria-engine` source tree
anywhere on disk**. When Railway runs this container and (once the
hosted-paper-engine-impl branch is eventually merged) something calls
`spawnTenant()`, `realEngineInvocation("../aria-engine")` will resolve to a
path that **does not exist inside the container** — the spawn will fail
immediately (ENOENT on the `cwd`), for every tenant, unconditionally.

**This is the P0 finding this investigation was chartered to surface: as of
2026-09-19, hosted PAPER has no real engine-provisioning story for Railway at
all.** The Task 6 soak test (`scripts/fleet-soak.ts`,
`src/fleet/fleet-manager.test.ts` et al., on the same branch) exercises
FleetManager's state machine against a **fake fixture**
(`src/fleet/test-fixtures/fake-engine.mjs`) or, in the one real-CLI
integration test, against the literal dev-machine sibling checkout — never
against anything resembling a Railway container. That soak certifies
FleetManager's own spawn/monitor/restart/crash-loop logic is internally
correct. **It does not and cannot certify that Railway can actually launch a
real engine process the same way**, because the soak never runs inside a
container that lacks the sibling checkout. Treating the soak's PASS as
production-readiness evidence for hosted PAPER would be exactly the kind of
conflation the standing rule above exists to prevent. Closing this gap needs
a real decision (vendor the engine into the bot repo's build context, publish
it as an installable package/binary, or bake it into a shared Docker image)
before hosted PAPER can ever be deployed to Railway — none of that exists
yet, on any branch, in either repo.

### 2.4 Engine version/SHA verification at spawn time

**Missing.** `RECOMMENDED_ENGINE_VERSION` / `MINIMUM_SUPPORTED_ENGINE_VERSION`
/ `compareAriaVersions` do exist in `src/config.ts` (already on `origin/main`,
predating this branch — commit `170bc91`), but they are used only by
`src/engine-customer-routes.ts` to classify a **self-reported** version string
a already-paired local device sends over `/api/engine/sync`/`/api/engine/pair`
for a soft update-nudge UI. Grepped `src/fleet/fleet-manager.ts` directly:
zero references to `RECOMMENDED_ENGINE_VERSION`, `MINIMUM_SUPPORTED_ENGINE_VERSION`,
or `compareAriaVersions`. `spawnTenant()`/`realEngineInvocation()` never read
the engine's own `package.json` version, never compute a checksum/SHA of what
they're about to spawn, and never reject an incompatible engine — they just
exec whatever is at `ARIA_ENGINE_REPO_PATH` (which, per 2.3, doesn't exist on
Railway regardless).

### 2.5 Does anything expose the running engine's build identity?

**No, and this repo's `/healthz` never did before this task.** Read directly
from `origin/main`'s `src/server.ts` prior to this change:

```ts
app.get("/healthz", (c) =>
  c.json({ ok: true, uptime: process.uptime(), leads: totalLeads(), paymentsEnabled: PAYMENTS_ENABLED }),
);
```

Same shape on `work/hosted-paper-engine-impl` — the hosted-engine branch
doesn't touch `/healthz` at all. Task 2 (below) adds a `release` block to
this response for the *control plane's own* build identity, but leaves
`engineSha: null` deliberately — there is currently no engine artifact with a
verifiable identity on Railway to report (see 2.3), so any non-null value
there would be fabricated.

---

## 3. Task 2 — Build identity instrumentation (implemented on this branch)

New file `src/release.ts`, wired into `/healthz` in `src/server.ts`.

**Sourcing, in priority order:** `APP_COMMIT_SHA` env var → Railway's own
`RAILWAY_GIT_COMMIT_SHA` → a `.build-sha`/`.build-time` file written during
the Docker build → the literal string `"unknown"`. **`list-variables` against
the live Railway service does NOT show `RAILWAY_GIT_COMMIT_SHA`** (see the
exact variable list in §4) — per Railway's documented behavior, git metadata
reaches a Dockerfile build only as a **build ARG**, and is not automatically
promoted to a runtime env var unless the Dockerfile declares
`ARG RAILWAY_GIT_COMMIT_SHA` and re-exports it via `ENV`. This repo's
Dockerfile did not do that before this change; it now does:

```dockerfile
ARG RAILWAY_GIT_COMMIT_SHA
ARG RAILWAY_GIT_BRANCH
ENV APP_COMMIT_SHA=$RAILWAY_GIT_COMMIT_SHA
ENV APP_GIT_BRANCH=$RAILWAY_GIT_BRANCH
RUN echo -n "$RAILWAY_GIT_COMMIT_SHA" > .build-sha
RUN date -u +"%Y-%m-%dT%H:%M:%SZ" > .build-time
```

**This has not been verified against a real Railway build** (no deploy was
triggered, per the task's constraints) — flagging honestly as a follow-up:
after this branch merges and deploys, `/healthz`'s `release.controlPlaneSha`
must be checked against the real deployment to confirm Railway actually
populates `RAILWAY_GIT_COMMIT_SHA` as a build ARG for this project/plan. If it
doesn't, the `.build-sha` file mechanism (which needs no Railway-specific
behavior at all) is the fallback that still works.

`/healthz` now returns:

```json
{
  "ok": true,
  "uptime": 123.45,
  "leads": 0,
  "paymentsEnabled": false,
  "release": {
    "controlPlaneSha": "f2e1ffd9fe31af18959712db833b8237cf54e946",
    "branch": "main",
    "buildTime": "2026-09-19T18:00:00Z",
    "releaseId": "f2e1ffd9fe31@2026-09-19T18:00:00Z",
    "mode": "paper",
    "engineSha": null
  }
}
```

`engineSha` is explicitly `null` — never fabricated — per the Task 1 finding
above: there is no deployed mechanism that provisions a versioned/identifiable
`aria-engine` artifact into this service's container today, so there is
nothing honest to report. Flip this only once that gap is actually closed.

No secrets are exposed: `release` contains only a commit SHA, a branch name,
and a build timestamp — all of which are already public in the GitHub repo
this deploys from. Test coverage: `test/release-identity.ts` (added to
`npm test`) asserts the endpoint returns real values when the sourcing env
vars are set, falls back to the literal string `"unknown"` (never `undefined`,
never a thrown error) in a genuinely clean child process with none of those
vars set, and that the response never contains any of this process's actual
secret env var values (`TELEGRAM_BOT_TOKEN`, `RESEND_API_KEY`,
`ARIA_LICENSE_PRIVATE_D`, `ARIA_ENTITLEMENT_PRIVATE_D`) or leaks
`process.env` wholesale. `npm run typecheck` and `npm test` are both clean on
this branch.

---

## 4. Task 4 — Railway's actual current configuration (read-only, via MCP)

Project: **bubbly-prosperity** (`4f5fba5b-a1ab-4240-b5a6-0ded65caf113`),
environment **production** (`fe8a169d-f44d-4e8a-bf5b-8bcad00574be`).

### Service `aria-telegram-BOT-APP` (`dddae878-b35d-4f0f-8140-dfda6e8e33b7`)

| Field | Value |
|---|---|
| Source | `AIWMCX/aria-telegram-BOT-APP`, branch `main` |
| Build | Dockerfile-based — confirmed via the live build log's actual steps (`FROM node:22-slim`, `COPY package.json`, `RUN npm install`, `COPY tsconfig.json`/`src`/`public`/`scripts`/`migrations`, `RUN mkdir -p /data`), byte-for-byte matching this repo's `Dockerfile`. (The Railway API's own `build.builder` field reports `"RAILPACK"` — this is Railway's internal build-system label and does **not** mean it ignored the Dockerfile; the actual BuildKit steps prove the Dockerfile ran.) |
| Start command | `npm start` (from `railway.json`; no override in the live service config) |
| Healthcheck | `/healthz`, 30s timeout — confirmed both in `railway.json` and in the live deploy log (`Path: /healthz`, `Retry window: 30s`, `Healthcheck succeeded!`) |
| Latest deployment | `5d1ee031-7797-4773-85bc-4f750abb0da0`, status `SUCCESS`, commit `f2e1ffd9fe31af18959712db833b8237cf54e946` — **matches `origin/main` exactly** |
| Persistent volume | Yes — `aria-telegram-bot-data`, 5000 MB, region `sfo`, mounted at `/data` (this is where the SQLite DB lives) |
| Configured variable names | `ADMIN_EMAIL`, `ADMIN_TELEGRAM_CHAT_ID`, `ARIA_ENTITLEMENT_PRIVATE_D`, `ARIA_ENTITLEMENT_PUBLIC_X`, `ARIA_LICENSE_PRIVATE_D`, `ARIA_LICENSE_PUBLIC_X`, `DATABASE_URL`, `DB_PATH`, `LOG_LEVEL`, `NODE_ENV`, `PORT`, `PUBLIC_URL`, `RESEND_API_KEY`, `RUN_ENGINE_AUTH_SELFTEST`, `RUN_ENGINE_CONTROL_SELFTEST`, `RUN_ENGINE_SYNC_SELFTEST`, `RUN_LEDGER_SELFTEST`, `RUN_SYNC_DESYNC_REPRO`, `RYPTO_CHANNEL_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_TRANSPORT`, `TELEGRAM_WEBHOOK_SECRET` — plus Railway's own always-present `RAILWAY_ENVIRONMENT*`/`RAILWAY_PROJECT*`/`RAILWAY_SERVICE*`/`RAILWAY_VOLUME*`/`RAILWAY_PUBLIC_DOMAIN`/`RAILWAY_STATIC_URL`. **No `RAILWAY_GIT_COMMIT_SHA` or other `RAILWAY_GIT_*` name appears in this list** — consistent with those being build-ARG-only until a Dockerfile explicitly promotes them (see §3). No `ARIA_ENGINE_REPO_PATH`, `FLEET_TENANTS_ROOT`, or any other hosted-Fleet-Manager variable is configured — consistent with that code not being on `main` yet. |
| Domains | `aria-telegram-bot-app-production.up.railway.app` (no custom domain) |

### Other services in this project (context only, not this task's scope)

- **`aria-real1-preview`** (`35aaf768-7ab5-4cb0-952f-7e06bd573936`) — a second
  service tracking branch `codex/real-1-preview-current-main`. Its latest
  deployment (`20aa887a-c904-4b16-acd2-952a85694a80`) is **`FAILED`**. No
  volume attached. Not touched by this task.
- **`Postgres`** (`a3eb989a-4ae6-4fc0-9242-c24d2b88a6ac`) — managed database
  backing `DATABASE_URL` for the users/entitlements domain.

---

## 5. Task 3 — Commit classification

Categories: `REQUIRED_FOR_RELEASE` / `DOC_ONLY` / `TEST_ONLY` / `CERTIFICATION`
/ `SUPERSEDED` / `UNRELATED` / `LIVE_FUTURE` / `UNSAFE`. Read via `git show
--stat` (all commits) plus full diffs for anything ambiguous or security-
relevant. "REQUIRED_FOR_RELEASE" below means required for that branch's own
stated release goal (hosted PAPER on Railway for the bot repo; PAPER-engine
commercial feature completeness for the engine repo) — **not** that either
branch is ready to merge to main today; §2.3's P0 finding blocks that
regardless of how complete the branch's own commits are.

### 5.1 `aria-telegram-BOT-APP`: `origin/main` (`f2e1ffd9`) .. `origin/work/hosted-paper-engine-impl` (`d66848a4`) — 24 commits

| Commit | Message | Class |
|---|---|---|
| `dd88653` | docs: add hosted PAPER engine design spec + implementation plan | DOC_ONLY |
| `026be66` | docs: post-write reconciliation for hosted-engine plan | DOC_ONLY |
| `2bf2d83` | chore: create SDD progress ledger | DOC_ONLY |
| `7e5d7a2` | feat(schema): add engine_clients.hosting_mode column (Task 1) | REQUIRED_FOR_RELEASE |
| `692f411` | docs(ledger): record Task 1 completion | DOC_ONLY |
| `ca048bd` | docs: close Task 1 as DONE/REVIEWED-PASS | DOC_ONLY |
| `fdb4796` | feat(fleet): build Fleet Manager core — spawn/monitor/stop (Task 2) | REQUIRED_FOR_RELEASE |
| `aca0794` | docs(ledger): record Task 2 commit SHA | DOC_ONLY |
| `e7c0d4c` | fix(fleet): cancel pending restart timer on stopTenant (Task 2 review fix) | REQUIRED_FOR_RELEASE |
| `46d2e61` | docs: close Task 2 as DONE/REVIEWED-PASS | DOC_ONLY |
| `733c24e` | feat(fleet): resource bounds + crash-loop backoff/give-up policy (Task 3) | REQUIRED_FOR_RELEASE |
| `f22cb34` | docs: record Task 3 commit hash | DOC_ONLY |
| `0b627e3` | docs: close Task 3, mark runbook note resolved | DOC_ONLY |
| `a0c5ff5` | feat(bot): wire Telegram commands to Fleet Manager (Task 4) | REQUIRED_FOR_RELEASE |
| `5c2f60f` | docs(ledger): record Task 4 commit SHA | DOC_ONLY |
| `b4c4321` | fix(fleet): provision real device identity on local→hosted conversion (Task 4 review fix) | REQUIRED_FOR_RELEASE |
| `ed55388` | docs(ledger): record Task 4 review-fix SHA | DOC_ONLY |
| `1c66e8a` | fix(fleet): identity write-before-commit ordering, crash-safety (Task 4 2nd review fix) | REQUIRED_FOR_RELEASE |
| `14dd9d6` | docs(ledger): record Task 4 2nd review-fix SHA | DOC_ONLY |
| `e2283d9` | docs: record 3rd-pass verification closing Task 4 | DOC_ONLY |
| `e874097` | test(fleet): dual-mode local/hosted coexistence test (Task 5) | TEST_ONLY |
| `7e3a4da` | docs(ledger): record Task 5 SHA | DOC_ONLY |
| `54ca099` | test(fleet): soak Fleet Manager under multi-tenant load + fault injection (Task 6) | CERTIFICATION |
| `d66848a` | docs(ledger): record Task 6 commit SHA | DOC_ONLY |

**Totals:** REQUIRED_FOR_RELEASE 6 · DOC_ONLY 15 · TEST_ONLY 1 · CERTIFICATION 1 · SUPERSEDED 0 · UNRELATED 0 · LIVE_FUTURE 0 · UNSAFE 0

### 5.2 `aria-engine`: `origin/main` (`b4ebdb6a`) .. `origin/work/reference-driven-commercialization-impl` (`0e311b9`) — 36 commits

| Commit | Message | Class |
|---|---|---|
| `facfb24` | docs: add reference-driven commercialization design | DOC_ONLY |
| `6befc3e` | docs: add reference-driven commercialization implementation plan | DOC_ONLY |
| `8c87578` | docs(plan): correct Tasks 2/3/6/7 against real code | DOC_ONLY |
| `02bbef4` | chore: create SDD progress ledger | DOC_ONLY |
| `34e9936` | docs: record Task 1 commit hash | DOC_ONLY |
| `bca3133` | docs: competitive reference matrix (Task 1) | DOC_ONLY |
| `5b5d7a9` | fix: correct Task 1 review findings; redact a third-party API key quoted in the matrix | DOC_ONLY (see note below) |
| `6c41ff9` | fix: redact self-referential API-key leak in ledger, close Task 1 | DOC_ONLY (see note below) |
| `e9e9a4e` | docs: record Task 2 commit hash | DOC_ONLY |
| `1b9fdbc` | docs: close Task 2 | DOC_ONLY |
| `289057f` | docs: record Task 3 commit SHA | DOC_ONLY |
| `2e672fd` | feat(paper): trailing-stop exit (Task 3) | REQUIRED_FOR_RELEASE |
| `831a1f5` | fix(paper): restart-recovery test coverage for trailing-stop (Task 3 review fix) | REQUIRED_FOR_RELEASE |
| `7541623` | docs: record Task 3 review-fix SHA | DOC_ONLY |
| `6229bcf` | docs: close Task 3 | DOC_ONLY |
| `eff8799` | docs: record Task 4 commit SHA | DOC_ONLY |
| `8bfabe0` | feat(paper): progressive/emergency PAPER exit planning (Task 4) | REQUIRED_FOR_RELEASE |
| `28e51b9` | fix(runtime): journal whitelist replayability fix (Task 4 review fix) | REQUIRED_FOR_RELEASE |
| `a210e36` | docs: record Task 4 review-fix SHA | DOC_ONLY |
| `b4a85c1` | docs: close Task 4 | DOC_ONLY |
| `a1d0892` | docs: record Task 5 commit SHA | DOC_ONLY |
| `bc04590` | feat(copy): PAPER copy-signal intelligence — wallet quality scoring (Task 5) | REQUIRED_FOR_RELEASE |
| `1eb8196` | docs: close Task 5 | DOC_ONLY |
| `4d2e5dd` | feat(discovery): health-reporting wrapper around polling transport (Task 6) | REQUIRED_FOR_RELEASE |
| `79f0e0a` | docs+fix: close Task 6, correct a false claim, add JSDoc (1-line, non-functional) | DOC_ONLY |
| `03845d2` | feat(paper): execution-cost-envelope aggregator around Jito PAPER model (Task 7) | REQUIRED_FOR_RELEASE |
| `e31cba5` | docs: update ledger for Task 7 | DOC_ONLY |
| `b212814` | docs: close Task 7 | DOC_ONLY |
| `052d795` | feat(runtime): journal/replay coverage for Tasks 3–7's features (Task 8) | REQUIRED_FOR_RELEASE |
| `9774eaa` | docs: close Task 8 | DOC_ONLY |
| `8656b81` | feat(runtime): commercial PAPER audit/certification command (Task 9) | CERTIFICATION |
| `90c0eae` | docs: record Task 9 commit SHA | DOC_ONLY |
| `5429a04` | fix(runtime): correct audit-summary causal claim (Task 9 review fix) | CERTIFICATION |
| `0e311b9` | docs: close Task 9, correct a test-count misstatement | DOC_ONLY |
| `82cc2bc` | docs: Task 2 audit — Pump-native PAPER economics confirmed correct, no gap found | DOC_ONLY |
| `7ede0c8` | chore: resync stale package-lock.json version metadata | UNRELATED |

**Totals:** REQUIRED_FOR_RELEASE 7 · DOC_ONLY 26 · TEST_ONLY 0 · CERTIFICATION 2 · SUPERSEDED 0 · UNRELATED 1 · LIVE_FUTURE 0 · UNSAFE 0

**Note on `5b5d7a9`/`6c41ff9`:** both redact a leaked API key from a
*research/documentation* file (`docs/COMPETITIVE_REFERENCE_MATRIX.md`, a
study of third-party open-source sniper bots) — the key belonged to a
third-party Helius endpoint quoted verbatim from a studied repo's public
source, not an ARIA secret. Read the full diff directly to confirm: no
ARIA credential, private key, or production secret was ever exposed by
these commits; they are corrective documentation edits, not incident
response for this project's own secrets.

---

## 6. LIVE-capability grep — required explicit report

Per the charter: grepped `signTransaction`, `sendRawTransaction`,
`private.?key`, `seed.?phrase`, `executionMode.*live` (case-insensitive)
across **both full candidate branch trees** (not just the diffs — the whole
tree, so nothing hiding in an unrelated pre-existing file is missed).

**Result: no functional LIVE-capable code path was found on either branch.**
Full detail:

- **aria-engine (`work/reference-driven-commercialization-impl`):** every
  match is one of (a) a negative/forbidden-pattern test —
  `src/contracts.test.ts`, `src/paper/paper-hard-stop.test.ts`,
  `src/solana-config.test.ts` all assert these strings/patterns **never**
  appear in the real config/contracts source, several with a literal
  compile-time check (`_modeIsNeverLive: ExecutionMode extends "live" ? false
  : true = true`); (b) `.github/workflows/ci.yml` — CI itself greps the built
  `dist/` output for `sendTransaction`/`sendRawTransaction`/`signTransaction`/
  `new Keypair(...)` and fails the build if any are found; (c) `privateKey`/
  `seedPhrase` matches inside `device-auth.ts`/`local-keystore.ts`, which are
  the **device identity** (Ed25519, authenticates sync requests) — every one
  of these files' own docblocks states explicitly "never a wallet key"; (d)
  prose in docs/README explicitly *disclaiming* these capabilities. No match
  is a real, reachable Solana wallet-signing or broadcast code path.
- **aria-telegram-BOT-APP (`work/hosted-paper-engine-impl`):** same pattern —
  `engine/src/config.ts`'s env-var denylist, migration comments disclaiming
  private-key storage, and Ed25519 device-identity code
  (`src/fleet/hosted-device-identity.ts`, `src/engine-entitlement-signer.ts`)
  whose keys sign entitlement tokens and sync requests, never transactions.
  **One real `signTransaction` implementation exists** —
  `src/signer-adapters/stub-signer-adapter.ts` implementing `SignerPort`
  (`src/signer-port.ts`) — but this **predates both candidate branches**
  (already on `origin/main`, commit `dd02f30`, from the original FREE-1
  work) and is explicitly marked `TEST-ONLY` in its own docblock: it
  generates no real Solana keypair, its `publicKey` is a literal
  `STUB_NOT_A_REAL_ADDRESS_<uuid>` string that can never be a valid address
  or receive real funds, and its docblock states it must never be imported
  from `src/index.ts`/`src/server.ts`/any production wiring. Grepped: it
  is not imported from either. This is a false positive from the grep
  pattern matching a name, not a live capability, and neither branch
  introduces or changes it.

**Conclusion:** the PAPER-only invariant holds on both branches as currently
written. The real risk is not a hidden LIVE code path — it's §2.3's
production-provisioning gap, which is a reliability/deployability problem,
not a safety-invariant violation.

---

## 7. Summary for whoever reads this next

1. **Hosted PAPER cannot run on Railway today.** Not "unverified" — verified
   absent. `realEngineInvocation()` execs a sibling-checkout path that only
   exists on a dev machine; the production `Dockerfile` never provisions an
   `aria-engine` artifact into the container at all. This blocks merging
   `work/hosted-paper-engine-impl` to main regardless of how clean its own
   Task 1–6 record is — Task 6's soak certifies FleetManager's state machine,
   not Railway launchability.
2. **`/healthz` now reports real build identity** (`controlPlaneSha`,
   `branch`, `buildTime`, `releaseId`) on this branch, sourced from Railway's
   git-metadata build ARGs (newly promoted to ENV in the Dockerfile) with a
   build-time-file fallback, and an honest `"unknown"` if neither is present
   — never fabricated. `engineSha` stays `null` until finding #1 is actually
   closed. Not yet deployed (out of scope for this task).
3. **Today's live deployment is genuinely current**: Railway's `main`
   deployment SHA (`f2e1ffd9…`) matches `origin/main` exactly. The
   third link in the chain (running app's self-reported SHA) becomes
   checkable only after this branch merges and deploys.
4. **No LIVE-capable code path exists on either candidate branch** — grep
   swept clean; the one real signing stub predates both branches and is
   explicitly test-only, unimported by production code.
5. Commit classification: bot repo — 6 REQUIRED_FOR_RELEASE, 15 DOC_ONLY, 1
   TEST_ONLY, 1 CERTIFICATION, 1 zero-count categories otherwise; engine
   repo — 7 REQUIRED_FOR_RELEASE, 26 DOC_ONLY, 2 CERTIFICATION, 1 UNRELATED.
