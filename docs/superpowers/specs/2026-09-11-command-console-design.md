# ARIA Command Console — Design Spec

## Problem

The user has been explicit and final on this: **no PC terminal, for anyone,
ever** — not for free users, not for paid users. A local terminal is
"not understandable for users who will pay, or who just want to try," and
disappointed users don't pay. This spec supersedes any earlier framing of
"advanced local mode" as a terminal alternative — there is no local-terminal
tier in this product anymore.

Instead: a **terminal-styled UI living inside the Telegram Mini App**,
backed by a safe, closed command DSL that talks to ARIA's own hosted
backend — never a shell, never arbitrary code execution, never local
install. It must feel like the power and immediacy of a real terminal
(type a command, get a structured response) without any of a real
terminal's attack surface.

## Non-Goals

- Not raw shell access, not PowerShell/bash exposed to the browser, not
  `eval`, not filesystem or environment access from a typed command.
- Not a new trading engine — every command that touches PAPER state calls
  through to the EXISTING `aria-engine` CLI (via the Fleet Manager, see
  `2026-09-08-hosted-engine-design.md`) or reads the existing journal/sync
  data already flowing through `/api/engine/sync`. This spec adds a command
  layer, not new trading logic.
- Not a LIVE execution surface. Every command this spec defines operates
  on PAPER state or read-only status. `aria live *` commands are named
  here (per the user's own original prompt) as placeholders that return
  a clear "not yet available" response — they do nothing until the
  separate, much more heavily reviewed REAL2 execution program (firewall,
  signer boundary, route builder — explicitly deferred, not this spec)
  is built and the user has explicitly armed it.

## Architecture

```
Telegram Mini App
  → Command Console UI (terminal-styled input/output, web frontend)
  → POST /api/console/execute  { command: string }
      (Telegram-authenticated, same initData verification as every
       existing endpoint — see telegram-auth.ts)
  → Command Parser (tokenize + validate against a closed allowlist)
  → Command Registry (one handler per command, typed input/output)
  → [reads/writes] Fleet Manager API (hosted-engine-plan, Task 4)
     and/or the existing engine_clients/entitlement tables
  → Structured response: { status, message, data, warnings, nextActions }
  → Rendered in the Mini App's terminal-styled output pane
```

This is a THIN layer. It does not reimplement PAPER accounting, safety
evaluation, or exit logic — every command that needs real engine behavior
delegates to the Fleet Manager (which spawns the real, unmodified
`aria-engine` CLI) or reads the real, existing journal/sync data. The
console's only genuinely new code is: command parsing, the allowlist,
tier gating, rate limiting, and response formatting.

## Command surface (v1)

Every command below returns the same envelope shape:
`{ status: "ok"|"error", message: string, data?: object, warnings?: string[], nextActions?: string[] }`.
Never a raw stack trace, never a raw infrastructure error message (per
the user's own Phase 2 requirement) — errors are translated to plain
language with a `nextActions` hint.

| Command | Tier | What it does |
|---|---|---|
| `aria help` | Free | Lists available commands for the caller's tier |
| `aria status` | Free | Hosted engine status (OFF/STARTING/ONLINE/DEGRADED/STOPPED) — reads Fleet Manager state |
| `aria paper start` | Free | Calls Fleet Manager `spawnTenant` |
| `aria paper stop` | Free | Calls Fleet Manager `stopTenant` |
| `aria paper report` | Free | Summarizes the caller's own journal (candidates, entries/exits, PnL) — reuses `trading-journal.ts`'s existing aggregation, exposed read-only |
| `aria journal` | Free (capped history) / Paid (full history) | Same data as `aria journal` in the CLI today, tier-gated on how far back it reads |
| `aria risk show` | Paid | Read the caller's current PAPER risk config (take-profit/stop-loss/trailing-stop bps, position caps) |
| `aria risk set <field> <value>` | Paid | Validated, bounded write to the caller's PAPER config — reuses the EXACT validation already in `aria-engine`'s `paper-config.ts` (never reimplement bps-range checks here) |
| `aria strategy list` / `aria strategy use <name>` | Paid | Placeholder in v1 — returns "no named strategy presets yet" honestly; do not fabricate presets that don't exist |
| `aria wallet status` | Paid | Placeholder — "wallet connection not yet available," never accepts input in v1 |
| `aria live status` / `aria live checklist` | Paid | Placeholder — returns the REAL2 program's actual current readiness state once that program exists; until then, an honest "LIVE is not available" |
| `aria emergency-stop` | Free | Immediately calls Fleet Manager `stopTenant` — always available regardless of tier, since safety controls are never a paywall |

## Security (this is the load-bearing section)

- **Closed allowlist, not a blocklist.** The parser recognizes an exact,
  enumerated set of command strings — anything not on the list is
  rejected with `status: "error"`, never partially interpreted. No
  regex-based "looks safe" filtering; a token either matches a known
  command exactly or it doesn't exist.
- **No shell invocation anywhere in this code path.** The console process
  never calls `child_process.exec`/`spawn` with user-supplied string
  content — commands map to typed function calls with typed, individually
  validated arguments (e.g. `aria risk set max-trade 0.02` parses to
  `{ field: "max-trade", value: 0.02 }`, validated against the same
  bounds `paper-config.ts` already enforces, never string-interpolated
  into anything executed).
- **No secrets in output, ever.** Command responses are constructed from
  an explicit allowlist of fields to include — never `JSON.stringify`
  of an internal object that might contain a token, key, or credential.
- **Per-tenant isolation identical to the Fleet Manager's.** A command
  can only ever read/write the CALLING user's own `client_id`-scoped
  state — enforced the same way `getLatestActiveClientForUser()` already
  derives "this user's device" from verified Telegram identity, never
  from client-supplied input.
- **Rate limiting** on `/api/console/execute`, matching the existing
  `/api/submit` pattern (3/hour/Telegram user is that endpoint's rate;
  this endpoint's limit should be higher since legitimate use is
  interactive, but still bounded — a specific number is a Task 1
  decision for the implementation plan, not invented here).
- **Audit log** — every command invocation (caller, command, arguments,
  result status) is logged, matching this repo's own "every DB mutation
  calls `audit()`" convention from `CLAUDE.md`.
- **Tier gating is enforced server-side**, never trusted from client
  state — a paid-only command called by a free-tier user returns a clear
  "upgrade required" response, not a silent no-op or a client-side-only
  hidden button.

## What does NOT change

- The Fleet Manager, hosted engine, sync protocol, and `aria-engine`
  itself are all untouched by this spec. This is purely a new,
  additional way to CALL the capabilities those systems already expose
  (once the Fleet Manager's API exists — Task 4 of the hosted-engine
  plan is a hard dependency for every command above that touches a live
  hosted process).
- PAPER accounting, safety evaluators, exit logic — unchanged, per the
  hosted-engine plan's own Global Constraints, which this spec inherits.

## Sequencing dependency

This program cannot usefully start its own Task 2+ (command execution
against a real hosted engine) until `hosted-paper-engine-plan.md`'s
Task 4 (Fleet Manager wired to Telegram commands) is done — this spec's
`aria status`/`aria paper start`/`aria paper stop`/`aria emergency-stop`
commands are thin wrappers around exactly that API. Task 1 of THIS
plan (parser, allowlist, registry, the placeholder/read-only commands
that don't need a live hosted process) can start immediately and does
not block on the hosted-engine program.

## Future Work (explicitly deferred)

- `aria strategy`/`aria wallet`/`aria live` commands becoming real,
  once their respective programs (strategy presets, non-custodial wallet
  connection, REAL2 execution) exist — each is its own separate,
  dedicated design/review process, not built here as a side effect of
  the console's UI shell.
