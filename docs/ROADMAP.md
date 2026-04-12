# GRVT Grid — Roadmap

> **Last updated**: 2026-04-10
> **Current state**: Phase A (engine) and Phase B (dashboard + multi-tenancy) complete. Bot running in production.

---

## Completed

### Phase A — Grid Engine ✅
Core grid trading engine on GRVT perpetual futures. LONG/SHORT strategies, post-only orders with retry, fill deduplication, rate-limit handling. Deployed and running live.

### Phase B — Dashboard + Multi-Tenancy ✅
Full SPA (Vite + React + Tailwind + shadcn). GridChart with candle + grid overlays, equity curve, sparklines, 4-step create-bot wizard, live range update with preview, compound rebalancing, roundtrip tracking via FIFO fill pairing, multi-tenant auth (JWT + encrypted credentials), Docker self-host kit, Telegram notifier, light/dark theme.

**Last commit**: `cf17018` — Roundtrips tab

---

## Phase C — Hardening & Reliability

Production is running but has gaps in resilience, observability, and data integrity. This phase makes the system trustworthy for real capital.

| # | Task | Why | Files |
|---|------|-----|-------|
| C.1 | **Structured logging** — replace ~80 `console.log` calls in grid-engine with pino logger | Logs are unstructured, can't filter/aggregate. Pino is already imported in server/ but not used in engine | `bot/grid-engine.ts` |
| C.2 | **Credential test on save** — call GRVT `getAccountSummary` when user saves credentials, set `last_test_ok` | Credentials are accepted blindly; bot creation fails with cryptic error if keys are wrong | `bot/src/server/v2-router.ts`, `api/grvt-client-factory.ts` |
| C.3 | **Per-user GRVT client completion** — inject user's GrvtClient into GridBotInstance on create/start | Legacy bots still fall back to module-level singleton; multi-tenant is half-wired | `api/grvt-client-factory.ts`, `bot/grid-engine.ts` |
| C.4 | **Liquidation proximity safeguard** — auto-pause bot if mark price is within X% of liquidation price, emit `safeguardTriggered` | Liquidation price is calculated but never acted on. Real money at risk | `bot/grid-engine.ts` (monitor loop) |
| C.5 | **Graceful shutdown** — await in-flight `pollFillArchive` and `pollFundingHistory` before closing DB | Process kill during poll can lose fill data or corrupt SQLite WAL | `bot/grid-engine.ts`, `server/v2-bootstrap.ts` |
| C.6 | **Health check depth** — `/api/health` should verify DB read + GRVT API reachability, not just uptime | Current health check is a lie — returns 200 even if DB is locked or GRVT is down | `server/v2-router.ts` |
| C.7 | **Pagination on heavy endpoints** — add `?limit=` and `?offset=` to fills, orders, roundtrips, snapshots | `SELECT *` on fills_archive can return 100k+ rows, killing response time and memory | `server/v2-router.ts` |
| C.8 | **Prune processedFills Set** — cap at last N entries or prune entries older than 24h | Set grows unbounded per bot instance; memory leak on long-running bots | `bot/grid-engine.ts` |
| C.9 | **One-bot-per-instrument guard** — reject `POST /bots` if another active bot uses the same pair on the same sub-account | Fill attribution breaks silently if two bots share an instrument | `server/v2-router.ts`, `database/db.ts` |
| C.10 | **Notifier health check** — add health endpoint or Docker HEALTHCHECK to notifier | Notifier can die silently; Docker won't restart it without a health check | `notifier/Dockerfile`, `docker-compose.yml` |

---

## Phase D — Test Suite

Coverage is <10%. No API tests, no dashboard tests, no notifier tests, no integration tests. This phase builds confidence for future changes.

| # | Task | Scope |
|---|------|-------|
| D.1 | **Bot lifecycle integration test** — create → start → simulate fills → verify grid state → pause → close | `tests/integration/` |
| D.2 | **REST API endpoint tests** — auth flow, CRUD bots, grid-state, range update, compound config | `tests/api/` |
| D.3 | **Grid calculation tests** — `calculateGridLevels`, level spacing, qty/level, notional validation | `tests/grid-engine.test.ts` |
| D.4 | **Compound rebalance tests** — threshold, interval, qty/level recalc, cash movement ledger | `tests/grid-engine.test.ts` |
| D.5 | **Range update tests** — `buildRangeUpdatePlan`, `applyRangeUpdatePlan`, edge cases (no position, full position) | `tests/range-update.test.ts` |
| D.6 | **Database migration tests** — schema creation, idempotent ALTERs, version tracking | `tests/db.test.ts` |
| D.7 | **Notifier tests** — template rendering, fill batching, drawdown dedup, daily summary | `packages/notifier/tests/` |
| D.8 | **Dashboard component tests** — BotCard, CreateBotWizard, GridChart, DataTable (vitest + testing-library) | `packages/dashboard/tests/` |
| D.9 | **WebSocket tests** — subscribe/unsubscribe, reconnect, tick delivery, fill events | `tests/ws.test.ts` |

---

## Phase E — Dashboard Polish

The dashboard is functional but missing some design-doc features and UX polish.

| # | Task | Why |
|---|------|-----|
| E.1 | **Drawdown gauge** — animated risk meter on bot detail (design doc §6.4) | Specified in design language, not built. Key risk visualization |
| E.2 | **Keyboard shortcuts modal** — `?` key opens overlay showing all shortcuts (design doc §11) | Design specifies `g o/b/s`, `n b`, `?`, `t`, `/` — none wired |
| E.3 | **Optimistic UI updates** — start/pause/close reflect immediately in UI before server confirms | Current UX: button disables → waits for poll → updates. Feels sluggish |
| E.4 | **Mobile breakpoints** — add `sm:` breakpoints for 375-640px, fluid GridChart height | Cards and tables cramped on small phones; chart has fixed px height |
| E.5 | **Modal responsiveness** — modal width should shrink on mobile (currently fixed 560/720px) | Wizard overflow on phones <400px wide |
| E.6 | **Grid activity heatmap** — fill density per level per time bucket (design doc §6.5, optional P1) | Nice-to-have for power users, shows which levels earn the most |
| E.7 | **Global error toast for network failures** — catch fetch errors globally, show reconnecting state | Currently individual query errors; no global "offline" banner |
| E.8 | **Range picker drag handles** — wizard step 2 range selection with chart drag (design doc §7.3) | Current implementation is numeric inputs; design shows drag-on-chart UX |
| E.9 | **Password recovery flow** — "Forgot password" link on login, email-based reset token | No way to recover access if password is lost; currently requires server CLI access |

---

## Phase F — Notifications & Alerting

Telegram works. But a serious trading tool needs more channels and per-bot configuration.

| # | Task | Why |
|---|------|-----|
| F.1 | **Per-bot alert thresholds** — configurable drawdown %, profit target, fill batch size per bot | Global 15% drawdown threshold doesn't fit all strategies; 2x leverage ETH vs 10x BTC need different thresholds |
| F.2 | **Liquidation proximity alert** — notify when mark price is within configurable % of liq price | Engine calculates liq price but notifier never checks it |
| F.3 | **Webhook sink** — generic HTTP POST to user-configured URL on any alert event | Enables Discord, Slack, PagerDuty, or custom integrations without code changes |
| F.4 | **Muted hours** — configurable quiet period (e.g., don't alert 2-6am UTC) | Night alerts cause alert fatigue; users disable notifications entirely |
| F.5 | **Email notifications** — SMTP or SendGrid for daily summaries and critical alerts | Some users don't use Telegram; email is universal |
| F.6 | **Alert history in dashboard** — show past alerts in a table on Settings or per-bot | No way to see what alerts fired or were missed |

---

## Phase G — Operations & Monitoring

For users running this on a VPS with real money long-term.

| # | Task | Why |
|---|------|-----|
| G.1 | **Prometheus metrics endpoint** — `/metrics` exposing bot count, fill rate, equity, error count, latency | No observability beyond logs. Can't set up Grafana alerts without metrics |
| G.2 | **Grafana dashboard template** — JSON dashboard for the metrics above | Self-host users get a working dashboard out of the box |
| G.3 | **Automated backups** — compose service or cron that snapshots `data/` to S3/Backblaze nightly | INSTALL.md mentions backups but nothing is automated; SQLite data loss = total loss |
| G.4 | **Rollback mechanism** — versioned deploys with `docker compose` rollback instructions | Current update is `git pull + build`; a bad build with no rollback can brick the system |
| G.5 | **Log rotation for ./logs/** — logrotate config or pino-roll integration | Logs grow unbounded on disk; compose logs to stdout but file logs in `./logs/` don't rotate |
| G.6 | **Connection loss behavior docs** — document what happens when GRVT API is unreachable (orders stay? engine retries? pauses?) | Users don't know if their bot is safe during an outage |

---

## Phase H — Advanced Trading Features

New trading capabilities beyond basic grid.

| # | Task | Why |
|---|------|-----|
| H.1 | **More pairs** — SOL, DOGE, ARB, or whatever GRVT lists; dynamic pair list from API | Only ETH and BTC hardcoded today; GRVT already supports more |
| H.2 | **Dynamic grid** — auto-shift range when price exits bounds (trailing grid) | Static grid becomes useless after a 20% move; user has to manually update range |
| H.3 | **Stop-loss / take-profit** — auto-close bot at configurable loss/profit threshold | No automated exit strategy; user must watch and close manually |
| H.4 | **DCA mode** — dollar-cost-average into a position on a schedule, not grid-based | Common request for users who want exposure without grid complexity |
| H.5 | **Multi-sub-account** — let a user connect multiple GRVT sub-accounts, run bots on each | Power users want isolation between strategies (conservative vs aggressive) |
| H.6 | **Backtesting** — simulate grid on historical candles, show expected profit/drawdown | Users want to test parameters before risking capital |
| H.7 | **Portfolio view** — aggregate equity, PnL, and risk across all bots in one view | Overview page shows per-bot cards but no aggregate stats beyond count |

---

## Priority Order

```
C (hardening)  →  first, because production money is at risk
D (tests)      →  second, so future changes don't break prod
E (polish)     →  third, UX quality-of-life
F (alerts)     →  fourth, better risk management
G (ops)        →  fifth, operational maturity
H (features)   →  sixth, new capabilities once foundation is solid
```

Each phase is independent enough to start in parallel if needed, but the dependency arrow above is the recommended order.
