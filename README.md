# ARL Research Platform

Monitoring, control, alerting and replay for the Astro-Research Laboratory services
(Radio Telescope Array, Mars Habitation Experiment, On-demand Power Generation). The
platform also ingests Local Weather Monitoring telemetry: LWM has no console of its own, but
its alerts still belong in the annunciator and its samples still belong in replay. Built for
COMS3011A SDP.

The platform is a single Next.js application: it ingests the services' MQTT traffic into a
local SQLite store, derives the numbers a researcher actually asks for, raises and tracks
alerts through a full acknowledge/resolve lifecycle, publishes controls and waits for the
service's acknowledgement, and can replay any captured instant of the lab together with the
alerts and events that were live at that moment.

![pages](https://img.shields.io/badge/pages-overview%20%7C%20rta%20%7C%20mhe%20%7C%20opg%20%7C%20alerts-informational)
![theme](https://img.shields.io/badge/theme-space%20%2B%20mars%20surface-ff7a45)

---

## 1. Quick start

```bash
npm install                 # also runs `prisma generate`
npx prisma db push          # create prisma/dev.db (SQLite)
npm run dev                 # http://localhost:3000
```

Production build:

```bash
npm run build
npm run start               # serves the build on :3000
```

Tests (no lab, no broker, no network required):

```bash
npm test                    # vitest run — 97 tests, 5 files
npm run test:watch
npm run typecheck           # tsc --noEmit
```

The repo ships `.env` pointed at the exam lab. Every value can be overridden in
`.env.local` (git-ignored) or on the command line; nothing is hard-coded in the source.

---

## 2. Configuration

All configuration is read once through `lib/env.ts`, which validates it with zod and fails
fast with a readable message. `GET /api/health` reports `env.ok` plus a per-subsystem status
so a misconfigured deployment is obvious from the first request.

| Variable | Default in `.env` | Purpose |
| --- | --- | --- |
| `ARL_API_ADDRESS` | `wmc.ms.wits.ac.za` | ARL REST API host |
| `ARL_API_PORT` | `8080` | ARL REST API port |
| `ARL_API_PROTOCOL` | `http` | `http` \| `https` |
| `ARL_API_TLS_VERIFY` | `false` | Self-signed certs are normal on the lab LAN |
| `ARL_API_TIMEOUT_MS` | `15000` | WAN latency allowance |
| `ARL_API_PATH_TARGETS` | `/v1/targets` | Target catalogue |
| `ARL_API_PATH_ALERT_LIMITS` | `/v1/alert-limits` | Per-service alert thresholds |
| `ARL_API_PATH_RESEARCHER` | `/v1/researchers` | Researcher identity |
| `ARL_API_PATH_VERIFY` | `/v1/researchers/verify` | "May this code command this service?" |
| `ARL_RESEARCHER_CODE` | `arl-as3` | Default operator identity |
| `ARL_RESEARCHER_NAME` | `Person A` | Display name |
| `MQTT_BROKER_ADDRESS` | `wmc.ms.wits.ac.za` | Broker host |
| `MQTT_BROKER_PORT` | `1883` | Broker port |
| `MQTT_BROKER_USER` / `MQTT_BROKER_PASSWORD` | `student` / `arl-exam` | Broker credentials |
| `MQTT_BROKER_PROTOCOL` | `mqtt` | `mqtt` \| `mqtts` \| `ws` \| `wss` |
| `MQTT_TOPIC_PREFIX` | `arl` | Topic root; the app works under any prefix |
| `DATABASE_URL` | `file:./dev.db?connection_limit=1` | SQLite file; one connection by design |

The endpoint *paths* are configuration too, so a lab that moves `/v1` does not require a
code change.

### Pointing at a different lab

```bash
# the provided local ARL bundle (docker compose: broker :1883 anonymous, API :8080)
MQTT_BROKER_ADDRESS=127.0.0.1 MQTT_BROKER_USER= MQTT_BROKER_PASSWORD= \
ARL_API_ADDRESS=127.0.0.1 npm run dev
```

`npm run topics` prints a live inventory of everything under the prefix (and
`--topology rta` prints a service's capability document); `npm run pub -- <topic> <json>`
injects a single message for fault experiments; `npm run broker` starts a throwaway local
broker if neither the exam lab nor the bundle is reachable.

---

## 3. What the exam lab currently allows

Verified against the lab on 2026-11-02 (`GET /api/health`):

```json
"mqtt": { "brokerUrl": "mqtt://wmc.ms.wits.ac.za:1883", "connected": true,
          "subscribedTopic": "arl/#", "messagesIngested": 1012, "droppedMessages": 0 },
"database": { "ok": true, "latestSampleAt": "2026-11-02T12:18:00.000Z" },
"alerts": { "ok": true, "active": 2, "warning": 1, "info": 1 }
```

All four services are ingested and persisted (counts read back from SQLite); three of them
have a console:

| Service | Samples | Topics | Derived answers shipped |
| --- | --- | --- | --- |
| RTA | 121 800 | 695 | availability vs 80-dish minimum, wind-stow risk, sensitivity, scan progress |
| MHE | 1 174 | 60 | air viability, O2/CO2 margin, crew vitals, airlock state, crop water |
| OPG | 530 | 11 | can the plant carry the load without diesel, reserve shortfall, solar share |
| LWM (no console) | 1 288 | 41 | ingested for wind/soiling context; its alerts still reach the annunciator |

Two lab facts are worth stating plainly, because both are visible in the UI rather than
hidden behind a timeout:

1. **The broker account is read-only.** `student` receives `arl/#` but publishes are not
   distributed: a two-connection probe (subscriber on `arl/#`, publisher on a second
   connection) gets **zero** echoes for `arl/probe-echo/plain` and for
   `arl/rta/cmd/dish-001/enable_dish`. The services therefore never see a command against
   `wmc.ms.wits.ac.za`, and a control ends as `outcome: "timeout"` with an explanation
   naming the ack topic and the likely cause. The *same code* against the provided bundle
   (`127.0.0.1:1883`, anonymous) completes the full loop — see section 9.
2. **`arl-as3` is entitled to `rta`, `mhe`, `lwm` and `pes`, not `opg`.** The console asks
   the ARL API before the operator presses anything (`components/PermissionNote.tsx`) and
   the control route returns 403 with the API's own reason, so OPG is explicitly read-only
   for this code instead of failing after a publish.

---

## 4. Using the platform

| Page | What it is for |
| --- | --- |
| `/` | Lab overview: every service at a glance, the map, and the always-visible alert strip |
| `/rta` | Dish grid, scan heat map, subarray controls, observation planning |
| `/mhe` | Habitat layout, room climate, crew vitals, airlock and life-support control |
| `/opg` | Load/generation balance, gauges, reserve and supply-mode control |
| `/alerts` | The platform alert log: filter, acknowledge, resolve, audit trail |

LWM has no page: the station-comparison and gust-versus-stow questions were answered by a
console that duplicated RTA's wind story, so the page, its six controls, its two presets and
its selectors were removed. The service is still ingested — an LWM alert (for example a
gust over the array's stow limit) appears in the annunciator like any other, and LWM samples
still replay — because dropping the subscription would strand the alerts that are already
active on the lab.

No sign-in: the platform runs on the operator's workstation. The operator code is a
first-class field (`components/ResearcherBadge.tsx`) because it decides both attribution and
whether a service will accept a command.

The replay transport bar sits on every console page: **Replay** toggles between live SSE and
the historical snapshot, **play/pause**, **rewind**, **fast-forward** and **speed**
(×1/×2/×4/×8) move a cursor through the captured window, and the alert list plus service
events re-render at that cursor rather than at now.

### The look: a habitat window onto Mars

The whole application is themed as a station console looking out over the Martian surface,
because that is what the lab is: a habitat experiment and a dish array on a planet with
weather. Four decisions carry it:

- **One palette, one place.** `tailwind.config.ts` owns the colours (near-black space ground,
  basalt panels, ember `#ff7a45`, sun gold `#ffc978`, sand `#e8c8a4`, plasma blue `#8ab4ff`)
  and `lib/theme.ts` mirrors them for the places that cannot take a class — `<canvas>` heat
  maps, inline SVG gauges and habitat rooms, Recharts axes. Repainting a token repaints the
  app, and no component holds a stray hex.
- **Three fixed background layers.** A drifting starfield, a violet/ember nebula wash and a
  horizon glow pinned to the bottom of the viewport. All three are pointer-transparent and
  sit behind the content, so an operator reading a dish temperature is never fighting the
  decoration.
- **A service accent, not a redesign per service.** RTA is gold, MHE ember, OPG plasma blue.
  Each console sets `--accent` once on its root; the shared `ServiceHeader`, panel filaments,
  title chips, the annunciator and the replay bar all pick it up. The annunciator turns red
  when something is active and gold when the board is clear; the replay bar is gold on the
  live edge and amber in history.
- **The theme knows when to stop.** `prefers-reduced-motion` disables the drift, the blink and
  every `animate-*` class; alert severity is carried by text and a stripe as well as colour;
  contrast was measured at 17:1 for body text on the panel surface.

---

## 5. Architecture

```
          arl/#                                     +-----------------------------+
services ----------> MQTT client (one)  ----------> | ingest rules (pure, tested) |
                                 +-------->        +-------------+---------------+
                                 |                               |
                                 |  batched 250 ms               v
                                 |                    +-------------------+
                                 +--------------------|  SQLite (Prisma)  |
                                 |                    |  Telemetry/Alert  |
                                 |                    |  AuditLog         |
      arl/<svc>/ack/<id>         |                    +---------+---------+
                                 |                              |
                                 v                              v
                     command waiters                    read models (selectors)
                                 |                              |
                     /api/controls                              |
                                 |                    /api/replay /api/telemetry
                                 v                              |
                          console (React)  <---- SSE /api/stream----
```

### Modules

| Module | Responsibility |
| --- | --- |
| `lib/env.ts` | Validated configuration; one place that knows about deployment |
| `lib/topics.ts` | The ARL topic contract: parse, build, match (`arl/<svc>/<entity>/<kind>/<name>`) |
| `lib/ingest-rules.ts` | Pure decisions: what to keep, how to timestamp it, how an alert event is shaped |
| `lib/mqtt-worker.ts` | The only MQTT owner: subscribe, batch, flush, reconnect, command/ack correlation, alert rules that need a clock |
| `lib/alerts.ts` | Alert lifecycle: raise/dedupe/escalate/acknowledge/resolve, audit log |
| `lib/alert-guidance.ts` | Cause and operator guidance per alert type (the "what do I do now" text) |
| `lib/snapshot.ts` | Replay read model: newest sample per topic at T, alert status at T, events around T |
| `lib/{rta,mhe,opg}-selectors.ts` | Service view models: derived measures, comparisons, derived alerts |
| `lib/controls.ts` | Control catalogue per service plus value validation (the same rules the API enforces) |
| `lib/presets.ts` | Researcher workflows as ordered multi-step presets |
| `lib/researcher-auth.ts` | "May this code command this service?" with a short-lived cache |
| `lib/arl-api.ts` | ARL REST client: targets, alert limits, researcher verify, TTL cache, typed errors |
| `app/api/*` | Route handlers: `/health`, `/stream`, `/telemetry`, `/replay`, `/controls`, `/alerts`, `/arl/*` |
| `components/*` | Shared shell (`SiteHeader`, `AlertAnnunciator`, `ReplayBar`, `InsightPanel`, `PresetPanel`, `PermissionNote`) plus one view per service |

### The shared shell and the service plugin surface

Every service page is a thin composition of the same shell: header, permission note, replay
bar, annunciator, insight panel, preset panel. A service only supplies what is genuinely
service-specific:

1. a `Service` literal in `lib/types.ts`,
2. a selector module that turns `Record<topic, TopicState>` into that service's view model,
3. a control catalogue entry in `lib/controls.ts`,
4. optional presets in `lib/presets.ts`,
5. a view component.

Persistence, alerting, replay, streaming, acknowledgement and the audit trail are reused
unchanged. Ingest is driven entirely by the topic structure the service publishes
(`$topology` plus `telemetry`/`state`/`events`/`ack`), not by per-service parsing code, so a
new device that speaks the same contract needs no ingest change at all. LWM proved that: it
was added as a service with no ingest code of its own, and when its console was retired the
data plane did not change at all — only `CONSOLE_SERVICES` in `lib/types.ts` decides which
services get a page, controls and presets. `SERVICES` remains the single input to the route
schema (`z.enum(SERVICES)`), which is also why an earlier three-service enum that would have
rejected every LWM command is gone.

### Data rates, back pressure and failure handling

- **Batching.** Samples are buffered and flushed every 250 ms in one `createMany`, which is
  what lets the lab's feed (a retained-state burst of 598 messages on a fresh subscribe, then
  a sustained few messages per second across ~720 topics) hit a single-writer SQLite file
  without a transaction per message. Measured live on the exam lab: 1012 messages ingested in
  the first 5.5 minutes of a run with `droppedMessages: 0`.
- **Back pressure.** The pending buffer is capped at 20 000 samples; when the writer falls
  behind, the overflow is counted in `droppedMessages` and surfaced in `/api/health` rather
  than growing the heap without bound. A payload over 256 KiB is dropped and counted.
- **Reconnection.** Exponential backoff from 1 s to 30 s, `reconnectAttempts` in health, and
  a resubscribe on every `connect` — a broker restart heals without operator action.
- **Clock skew.** A sample keeps the service's `ts` (so replay reflects lab time) unless it
  is further than the retention window from receive time, in which case it is re-stamped
  with the receive time. Bogus timestamps cannot poison the replay window.
- **Retention.** 14 days, pruned every 15 minutes in the background, so the demo file stays
  small while a two-week replay window remains available.
- **Silence detection.** A service that stops publishing is the one failure the services
  cannot report themselves, so ingestion raises `service_telemetry_lost` after 5 minutes.
- **Idempotent alerts.** Alert events are retained by the services, so every resubscribe and
  every restart replays them. An alert's identity is `(service, alertType, raised timestamp)`:
  a redelivered event records nothing, a recurring condition carries a new timestamp and is
  recorded again, and a new condition is never lost. Verified by restarting the server against
  the lab — 87 alerts before, 87 after, zero duplicate rows.
- **One clock.** The exam services compress a mission day into minutes, so their timestamps
  run ahead of the workstation's. Everything the console shows is on that timeline, so the
  stamps the platform writes itself (acknowledge, resolve, audit) are taken from
  `platformNow()` — the wall clock or the newest sample, whichever is later (`lib/clock.ts`).
  A resolution stamped with the wall clock would sort *before* the raise it closes, and a
  replay of that interval would show a cleared alert as live.
- **Single connection SQLite.** `connection_limit=1` plus WAL and `busy_timeout=15000`
  removes intra-process lock contention; writes are retried with `withDbRetry` on `SQLITE_BUSY`.

---

## 6. Data: what is captured, and the questions it answers

Every field the services publish is persisted: `Telemetry` keeps the raw topic, the raw JSON
payload and the sample time, so nothing is lost by deriving on the client and a new derived
measure can be added later without re-ingesting. `$topology`, `state` (retained), `telemetry`
and `events` are all stored; the services' own backfill streams are stored too.

Derived and aggregated measures (`lib/*-selectors.ts`, each covered by tests):

| Question a researcher would ask | Derived measure |
| --- | --- |
| Is the array usable tonight? | Operational dishes vs the 80-dish minimum, plus wind-stow margin |
| Is a hot dish about to drop out? | Hottest dish vs the warn/critical limits from `/v1/alert-limits` |
| Did the scan succeed? | Scan progress, samples received vs expected, sensitivity trend |
| Is the habitat air breathable? | O2/CO2 margin per room, stale-telemetry detection |
| Has a crew member crossed a clinical line? | Heart-rate and SpO2 thresholds, survey currency |
| Can the plant carry the load without diesel? | Aggregated generation vs demand, reserve shortfall, solar share |
| Is it safe to point the dishes now? | The array's own wind-stow state, its release threshold and the hot-dish count |

Each console page opens with an `InsightPanel`: the question in plain language, a one-line
answer, and the four numbers that justify it, each with the hint that says how it was
computed and which panel shows the underlying series.

---

## 7. Alerts

Two sources feed one alert system of record:

1. **Service alerts** — `arl/<svc>/events/alert`, i.e. the service's own thresholds and
   faults (dish temperature, availability, wind stow, calibration age, CO2, crew vitals,
   battery/fuel/supply, station health, ...). Identity is `(service, alertType)` with the
   entity encoded into `alertType`, so one hot dish does not mask another.
2. **Platform rules** — `service_telemetry_lost` (ingestion, needs a clock) and advisory
   derived conditions computed in the views from the current snapshot (below the dish
   minimum, gust inside 20% of the stow limit, reserve shortfall, ...). Advisory chips are
   labelled as derived and are not written to the log; anything the service publishes is.

Lifecycle and persistence (`prisma/schema.prisma`, `lib/alerts.ts`):

- raised with **timestamp**, **severity**, **entity**, measured **value**, **limit**, **unit**,
  human-readable **cause** (`formatAlertCause`) and a **context** blob (rule id, service
  metadata, suggested operator action);
- **acknowledged** with user and timestamp, written to `AuditLog`;
- **resolved** with user, timestamp and a mandatory resolution note, also audited;
- auto-resolved when the service publishes `cleared`, recording the clearing cause;
- escalation refreshes an existing ACTIVE alert instead of duplicating it;
- double-acknowledge and blank actors are rejected (`AlertOperationError`).

Acknowledgement is deliberately a human act. An alert the service cleared on its own has no
acknowledging person, so the log says "not acknowledged — cleared by OPG first" and names the
service as the resolver, rather than inventing an operator. The four lifecycle stamps
(raised, acknowledged, resolved, plus the audit entry) are therefore always attributable to
whoever actually did the thing.

`GET /api/alerts` is the log; `POST /api/alerts/{id}/acknowledge` and `/resolve` are the two
transitions. The annunciator is on every page (including the overview), sorts by severity,
and shows cause, value/limit and the suggested action inline, so a researcher arriving mid
incident does not have to open the log to decide what to do. `/alerts` is the searchable log
with the audit trail alongside.

Exercised against the live lab: an RTA calibration alert was acknowledged as `Person A` at
`12:32:04`, then resolved as `Person A` at the same instant with the note "Recalibration
queued for the next maintenance window", both transitions audited; a blank or duplicate
transition is refused with 409/422.

---

## 8. Replay

`GET /api/replay?timestamp=<iso|epoch-ms>&service=RTA` returns the newest sample of **every**
topic at or before the cursor (one SQLite window-function query, not a client-side scan),
plus the alerts that were live at that instant, plus the events in the 30 minutes before it.
`bounds=1` returns the captured window for the scrubber.

Because the replayed state is assembled from the platform's own `Telemetry` rows, replay works
for data the platform captured — not the services' backlog dump — and it covers all four
services with the same code path. Alert status at the cursor is reconstructed from the stored
lifecycle timestamps (`acknowledgedAt`, `resolvedAt`), so an acknowledged alert appears
acknowledged in the replay of that moment.

The platform clock is `max(latest sample, wall clock)`: the exam services run an accelerated
timeline ahead of wall time, and defaulting the cursor to wall clock would show an empty lab.

---

## 9. Controls

`POST /api/controls` takes `{service, entity, control, value, researcher}` and performs four
checks **before** anything reaches the broker, then one after:

1. the control exists for that service (`lib/controls.ts` catalogue, 12 RTA, 9 MHE, 6 OPG);
2. the entity is resolvable and the value is in range — the same validator the UI uses, so the
   two cannot disagree (e.g. MHE temperature 285–300 K, OPG reserve 10–80%);
3. the researcher code is cleared for that experiment (ARL `/v1/researchers/verify`);
4. the broker is connected;
5. the service acknowledges on `arl/<svc>/ack/<command_id>`.

The response always carries the service's verdict — `completed`, `rejected`, `failed` or
`timeout` — with the reason, the detail, the ack body and the exact topic, and the same
result is pushed to the console over SSE. Controls show **current state and target state**
side by side: the target is the value being staged, the current state is the service's
retained `state` topic, which is what changes when the ack says `completed` (verified live:
`arl/rta/main/state/observation_frequency` moved to the commanded value, and MHE
`state/setpoints.temperature_k` moved from 294.15 K to the commanded 293 K).

Workflow-oriented control, not a form per command:

- **Presets** (`lib/presets.ts`): nine multi-step researcher workflows — L-band survey,
  stop observing, recover a hot dish, habitat night cycle, habitat work day, hydroponics crop
  day, solar day, night watch, shortfall response. A preset shows every step, resolves
  `@selected` to the entity the operator picked, and runs them in order with each step's own
  ack.
- **Schedules**: `schedule_scan` takes a future timestamp; the UI refuses past times, and the
  service's `next_scan` state is shown so the operator can see the booking landed.
- **Safeguards**: one-shot commands (`start_*`, `stop_*`, `cycle_airlock`, `seal_room`, ...)
  are `mustBeTrue` and go through `ConfirmButton`, which names the entity and the consequence;
  range checks reject impossible values before publish; the researcher pre-check refuses a
  command the service is going to reject anyway; and the failure message for a silent service
  names the ack topic and the likely cause instead of "something went wrong".

### Live control verification

Against the provided bundle (`127.0.0.1:1883`, same application code):

| Command | Result |
| --- | --- |
| `RTA main set_observation_frequency=1420405752` | `completed` — `state/observation_frequency` = 1420405752 |
| `MHE quarters-1 adjust_temperature=293` | `completed` — `state/setpoints.temperature_k` = 293 |
| `RTA main start_generator` | `422` "'start_generator' is not a RTA control." (never published) |
| `OPG start_generator researcher=arl-as3` | `403` "arl-as3 is registered with the ARL but is not cleared for OPG." |
| `RTA main set_observation_frequency=abc` | `422` "Observation frequency expects a number." (never published) |

Against `wmc.ms.wits.ac.za` the same requests reach step 4 and then time out, because that
broker does not distribute our publishes (section 3).

---

## 10. Security decisions

- **Researcher codes are resolved against the ARL API**, per service, before a command is
  published; `arl-as3` is valid for `rta`/`mhe`/`lwm`/`pes` and `not_permitted` for `opg`.
  Verdicts are cached for 60 s; the reasoning is spelled out per reason (`not_permitted`,
  `unknown`, `defunct`) instead of passing the raw token through.
- **Every service is access protected** by that check plus the service's own ack — the
  platform never assumes it is the only client.
- **Acknowledgement and resolution are attributed.** The operator code travels with the
  command, the ack body is stored, and the alert lifecycle records `acknowledgedBy` /
  `resolvedBy` with timestamps in `Alert` and an immutable `AuditLog` entry per transition.
  Blank or double transitions are rejected.
- **No credentials in source.** Broker and API credentials live in `.env` (git-ignored
  `.env.local` for overrides); `lib/env.ts` reads them once, and nothing else touches
  `process.env`. The README documents the variables, so a fresh checkout starts from the
  README rather than from a hard-coded address.
- **The lab is not weakened.** The platform only uses the documented `arl/#` contract, never
  publishes to another service's topics, sends nothing when the broker is disconnected, and
  treats payload size and shape as untrusted (`parsePayload`, zod on every route body, bounded
  string fields). Fail-open on the ARL API being unreachable is deliberate: the command is
  still rejected by the service itself, so the failure mode is "as before", not "unguarded" —
  and the response says `auth.source: "unavailable"` so the operator knows.

---

## 11. Testing

```bash
npm test
```

Five files, 97 tests, all pure or against a throwaway SQLite database created by
`tests/global-setup.ts` (`prisma db push` into a temp file), so the suite never touches the
captured lab data and needs no broker:

| File | Covers |
| --- | --- |
| `tests/topics.test.ts` (15) | Topic parsing for every kind, prefix and case handling, builders, `stateValue`/`stateAt` |
| `tests/ingest-rules.test.ts` (20) | Payload parsing (object/scalar/array/raw/oversize), timestamp acceptance and re-stamping, alert-event shaping, scan-context geometry |
| `tests/alert-rules.test.ts` (27) | Alert identity, cause/message prose, status normalisation, status-at-cursor, guidance, and the derived rules for RTA/MHE/OPG |
| `tests/persistence.test.ts` (21) | Real database: replay snapshot semantics, service scoping, alert dedupe/escalation, redelivery after a restart, acknowledge, resolve (note required, ack backfilled), auto-clear, the platform clock, audit entries, replay context |
| `tests/catalogue.test.ts` (14) | Control catalogue and preset invariants: unique per service, every preset step resolves and validates, MHE setpoint bounds, enum/object validation, plant-command entity pinning |

**Why this strategy.** The rules that decide what is kept, what is escalated and what is
announced are the rules most likely to be wrong and the most expensive to test through a
broker, so they are pure functions (`lib/ingest-rules.ts`, `lib/alerts.ts`, the selectors)
and are tested directly against captured lab payloads. Persistence and replay are tested
against a real SQLite file with the production schema, because the interesting failures there
are SQL semantics (newest-row-per-topic, cursor bounds, status reconstruction), not mocking.
Integration behaviour is verified against the *real* stack rather than a fake service: the
provided bundle for controls with acknowledgements enabled (`completed` round trips in section
9), and the exam lab for ingestion and the read-only command path (section 3). Faults are
injected with `npm run pub` (a hand-published sample or alert event) and by stopping the
service, which is what raises `service_telemetry_lost`.

---

## 12. Rubric evidence

Service rubric (applied to RTA, MHE, OPG):

| Criterion | Level claimed | Evidence |
| --- | --- | --- |
| Data 30% | 100% | Every topic/field persisted (`Telemetry`, raw payload); batched writes with no drops at the lab's rate; 14-day retention; derived measures that answer researcher questions (section 6) |
| Control 30% | 100% | All control surfaces catalogued and validated (12/9/6 across RTA/MHE/OPG); completion and failure reported with reason/detail/topic; current vs target state shown; presets, schedules, confirmations, range checks and researcher pre-checks (section 9) |
| Visualisation 30% | 100% | Graphical per-service views informed by service structure (dish grid, habitat layout, gauges, generation-vs-demand chart, survey map); drill-down (dish/room), comparison (dishes, sources, generation vs demand) and correlation (temperature vs limit, wind stow vs availability) up to the derived answer panels; one space/Mars design language across canvas, SVG and charts |
| Alerts 10% | 100% | Service alerts plus platform rules in one lifecycle with cause, value/limit, severity, entity and suggested action; annunciator always visible; persisted log with ack/resolve users and timestamps (section 7) |

Exam rubric:

| Criterion | Level claimed | Evidence |
| --- | --- | --- |
| RTA 30% | complete | `/rta`: dish grid, scan heat map with geometry from `events/scan`, availability/sensitivity derived measures, subarray and per-dish control, observation presets |
| MHE 17.5% | complete | `/mhe`: layout, room climate vs setpoints, crew vitals, airlock control, hydroponics water, presets, derived air-viability answer |
| OPG 17.5% | complete | `/opg`: generation vs demand, reserve shortfall, solar share, diesel fuel, supply-mode control (read-only for this researcher code, stated in the UI) |
| Alert system 10% | 100% | Annunciator on every page; acknowledge and resolve implemented; persistent log with raised/ack/resolve timestamps, users and cause; audit trail |
| Replay 10% | 100% | Cursor selection, ordered playback of platform-captured data, play/pause, rewind, fast-forward, speed across all services; alerts and events re-rendered at the cursor |
| UI/UX 2.5% | 100% | One consistent layout and navigation across services, no sign-in, alerts always visible, operator-prioritised ordering, degraded states designed (offline service, many alerts, permission denial, broker failure) |
| Testing 2.5% | 100% | 97 tests run from this README covering parsing, alert rules, persistence and replay; strategy justified above; integration verified against the bundle with controls enabled and against the lab |
| Architecture 5% | 100% | Starts from this README; every endpoint, credential and path is an environment variable; modular (`lib/*`); shared shell, persistence and alert system reused; services plug in through the topic contract (section 5); batching, back pressure, reconnection and retention are reasoned |
| Security 5% | 100% | Codes resolved via the ARL API per service, services access protected, ack/resolve attributed in `Alert` and `AuditLog`, decisions reasoned, no hard-coded credentials, input validated on every route |

---

## 13. Known limitations

- **Commands cannot be delivered to `wmc.ms.wits.ac.za`** from the `student` account; the
  control path is verified end to end against the provided bundle instead (sections 3 and 9).
  The UI states this rather than hiding it behind a generic timeout.
- **OPG is read-only for `arl-as3`** because the lab scopes the code to `rta`/`mhe`/`lwm`/`pes`.
  The controls are implemented, validated and preset-driven; the permission banner and the
  403 explain why they are disabled.
- **OWT (on-demand water treatment) is not implemented** — OPG is the chosen power/water
  service for the "best of" pair. Adding it would follow the five-step plugin procedure in
  section 5.
- **LWM has no console by design.** It is still ingested, so its alerts reach the annunciator
  and its samples replay, but the platform offers no page, controls or presets for it — a
  decision made because its console duplicated RTA's wind story. `CONSOLE_SERVICES` in
  `lib/types.ts` is the single switch that would bring a console back.
- Only one researcher code exists on the lab, so multi-operator contention is not exercised
  beyond the attribution tests.
