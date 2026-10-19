# ProgramOps — Project Log

Living document. **Update it in the same change as any feature, fix, schema change or
decision** (add a line to the Changelog, and adjust the sections above it if they changed).
Newest changelog entries go at the top.

_Last updated: 2026-10-19_ · Product direction: see `docs/PRODUCT_DESIGN.md`

---

## 1. What this is

ProgramOps is an internal HackerEarth dashboard that tracks hackathon / hiring-challenge
programs. Its source of truth is the HubSpot **Programs Feasibility Support** pipeline
(id `934067746`); tickets in that pipeline are synced into Postgres and shown with stage
progress, checklists, an audit trail, notes, and the ticket's SOW / marketing-POA documents.

| Layer | Stack |
|---|---|
| Frontend | TanStack Start (React, Vite), Tailwind, shadcn/ui, TanStack Query — `frontend/` (design origin: the Lovable project `d4f59791-…`, which runs on mock data; we reuse its look, not its data layer) |
| Backend | FastAPI (async), SQLAlchemy 2 + psycopg, Alembic, APScheduler, fastapi-users (Google OAuth, cookie session) — `backend/` |
| Database | PostgreSQL 18 (`pgvector/pgvector:pg18-trixie`) in Docker container **`database`**, port 5432, db `ProgramOps` |
| AI | OpenAI (`OPENAI_MODEL`, currently `gpt-4.1-mini`) — weekly brief + SOW/POA extraction with strict structured output |

### Running locally
- **Database:** `docker start database` (it stops when the machine reboots).
- **API:** `cd backend && .venv/bin/uvicorn main:app` → :8000. **No auto-reload — restart after backend changes.** Runs a scheduled sync on startup and every 10 minutes.
- **Frontend:** `cd frontend && npm run dev` → :5173.
- **Migrations:** `cd backend && .venv/bin/alembic upgrade head` (create new ones with `alembic revision --autogenerate -m "…"`, then check with `alembic check`).
- **Checks:** `cd backend && .venv/bin/python -m tests.test_etl` · `.venv/bin/python -m hubspot_client.documents` · `.venv/bin/python -m api.program_routes`; frontend `npx tsc --noEmit` (one pre-existing error in `vite.config.ts` is expected).

### Config (`backend/.env`, never committed)
`DATABASE_URL`, `HUBSPOT_SERVICE_KEY`, `PROGRAM_PIPELINE_ID`, `OPENAI_API_KEY`, `OPENAI_MODEL`, Google OAuth ids, `FRONTEND_URL`, `API_BASE_URL`.
HubSpot token scopes needed include CRM tickets/notes/owners read and **`files.ui_hidden.read`** (SOW/POA downloads).

---

## 2. How data flows (ETL)

```
HubSpot ──search (modified since cursor)──▶ ProgramTicket.from_raw ──▶ programs (upsert, chunked)
        ──batch read: property history + notes──▶ program_stage_history / program_notes
        ──Files API (signed URL)──▶ program_documents (PDF bytes) ──OpenAI structured output──▶ details JSONB
        ──ids in pipeline──▶ delete programs no longer in HubSpot
```

- **Entry point:** `hubspot_client/pipeline.py` → `run_tracked()` (scheduler and the "Sync now" button). One sync at a time: in-process `asyncio.Lock` + Postgres advisory lock `872001` (safe with several API workers).
- **Cursor:** `sync_cursors.hubspot_programs`, set to *start of run − 5 min* because HubSpot's search index lags edits.
- **Fetch:** `hubspot_client/client.py` — every call via `_request` (60 s timeout; retries with backoff on 429/5xx/connection errors, honours `Retry-After`). Ticket search restarts from the last modified-time before HubSpot's 10,000-result cap.
- **Bad data:** a malformed ticket is logged and skipped (`skipped` in the run stats); a junk deal-size value becomes "unset". Neither blocks the sync.
- **Documents:** `sync_documents()` scans *all* programs each run (not just changed tickets), so failures heal: re-download when the file id changes; failed extractions retried up to `MAX_ATTEMPTS` (5); a cleared HubSpot property removes the stored document.
- **Deletions:** `fetch_pipeline_ticket_ids()` vs the table; missing programs are deleted (children cascade). Guard: never deletes > 50 % of a table of ≥ 10 rows in one pass.
- **Deal value:** SOW fee (when the SOW's customer matches the ticket's company) → ticket description "Expected Deal Size" → HubSpot field. Source stored in `programs.deal_size_source`.
- **Names:** owner ids / audit-trail user ids are resolved through HubSpot owners (active **and** deactivated). `get_user_names()` is cached 10 min and never raises.

### API surface (`backend/api/program_routes.py`, all require login)
`GET /programs` (light columns only) · `GET /programs/{id}` · `/history` (newest first, with `changed_by_name`) · `/notes` (newest first) · `POST /notes` · `/documents` · `/documents/{sow|poa}/file[?download=true]` · `POST /programs/sync` (202, background) · `GET /programs/sync/status` · `GET/POST /programs/{id}/registrations` · `PUT …/registrations/config` · `DELETE …/registrations/{entry}` · `GET …/slack/lookup?channel_id=` · `PUT …/slack` · `POST …/slack/test` (`api/registration_routes.py`) · `GET /programs/analytics/{stage-funnel, checklist-status, campaign-types (active stages only), events, due-today?on=YYYY-MM-DD, weekly-brief?days=1..90}`.

---

## 3. Database schema

Managed by Alembic (`backend/migrations/versions/`). All timestamps are `timestamptz` (UTC).

| Table | Purpose / notes |
|---|---|
| `programs` | One row per HubSpot ticket (PK `ticket_id`). Normalised columns + `raw_properties` JSONB safety net + `stage_timings`. Indexes: `created_at`, `last_modified_at`, `stage_label`, `campaign_type`. `event_name` = HubSpot **Program Name** (falls back to the old event dropdown); `platform_details`; `deal_size_source`. |
| `program_stage_history` | Append-only audit log from HubSpot property history. Unique `(ticket_id, property_name, changed_at)`; index `(ticket_id, changed_at)`. |
| `program_notes` | HubSpot notes (source `hubspot`) + notes written in-app (source `programops`). Index `(ticket_id, created_at)`. |
| `program_documents` | SOW / POA per ticket, PK `(ticket_id, kind)`: file bytes (`content`), extraction `status`/`attempts`/`error`, validated `details` JSONB. |
| `program_registration_settings` | Per program (PK `ticket_id`): `roles[]`, `fields[]`, `slack_channel_id`, cached `slack_channel_name`, `notify_slack` (default true). |
| `program_registrations` | Daily counts: unique `(ticket_id, date, role)` (role `''` for non-hiring), `registrations`, `relevant`, `extra` JSONB. |
| `sync_cursors` | Incremental-sync cursor. |
| `user`, `oauth_account` | fastapi-users tables (Google login; `role` chosen at first login). |

Migration order (latest `11a50e20a20b` relevant nullable; before it `da97f2dfabb6` / `89088fe6f0d4` Redash slug): … `c898e9307afe` (platform_details) → `3b96137f8397` (timestamptz, indexes, documents in DB) → `af15727fc3b0` (registrations + Slack settings).

---

## 4. Features delivered

**Dashboard** — stage funnel, KPIs (active programs, pipeline value in ₹, blocked), attention queue, programs table (account manager / CSM), campaign-mix chart (**active stages only**), "Due today" strip, weekly AI brief, view filters (hackathons / hiring). Values shown in ₹ with Indian grouping (₹9,50,000; compact ₹9.5L / ₹1.2Cr).

**Program page** — header (account manager / CSM), stage progress, stage checklist (completed / pending), **audit trail** (newest first, scrollable, shows user *names*), Program brief (event = Program Name, campaign type, **platform**, **ticket owner**, account manager, CSM, content POC, created), **notes** (newest first, scrollable, add local notes), then the **SOW & plan of action** section.

**SOW & POA section** (below the existing sections) — file cards with View / Download; extracted SOW details (contract value, headline figures, objective, delivery timeline, rounds & content, client requirements, reports, contacts, SLAs) and the marketing schedule grouped by week with channel icons. Timeline and POA activities carry **no status tags** (no Done/Upcoming/Ongoing); the only date-driven cue is that the item covering the "Tracking as of" date **glows** (`doc-glow`). A date picker lets you preview other days.

**Sync UX** — "Live from HubSpot" pill → **Sync now**: starts a background sync, shows progress, refreshes the page data when done. Pages also auto-refresh every 60 s.

**Auth** — Google OAuth via fastapi-users; role capture on first login. **Roles:** only `manager` and `csm` can edit; `account_manager` and `other` are view-only. Enforced server-side by `require_editor` (`core/users.py`) on every POST/PUT/DELETE in `program_routes.py` / `registration_routes.py` (403 "View-only access"), and mirrored in the UI by `useCanEdit()` (`lib/api.ts`), which hides sync menu items, the note composer, Slack/Redash boxes and the registration entry editor (the table stays, read-only). A role can't be changed via the API once set (`on_before_update`); change it in the DB.

---

## 5. Fixes & hardening

| # | Area | Change |
|---|---|---|
| 1 | Load | Upserts are chunked to stay under Postgres' 65,535 bind-parameter limit (programs table would have failed at ~1,300 rows per batch). |
| 2 | Reliability | One malformed ticket no longer blocks every sync; junk deal-size text is ignored. |
| 3 | Reliability | HubSpot calls have timeouts and retry with backoff (429 / 5xx / network). |
| 4 | Scale | Ticket search pages past HubSpot's 10k cap (restart from last modified-time, de-duplicated). |
| 5 | Data loss | Document download/extraction failures are retried on later syncs (bounded), independent of ticket edits. |
| 6 | Data drift | Tickets deleted / moved out of the pipeline in HubSpot are removed locally (with a mass-delete guard). |
| 7 | Concurrency | Single-flight syncs (in-process lock + Postgres advisory lock). |
| 8 | Latency | `POST /programs/sync` returns 202 immediately (was holding the request for the whole sync); 20 s cooldown on manual syncs; `GET /programs` and the documents endpoints no longer load large columns. |
| 9 | Staleness | Cursor backs off 5 min for HubSpot index lag; UI auto-refreshes every 60 s. |
| 10 | Query speed | Indexes on `stage_label`, `campaign_type`, history `(ticket_id, changed_at)`, notes `(ticket_id, created_at)`. |
| 11 | Correctness | All timestamps are `timestamptz`. (Side effect fixed: the cursor was read back as naive-UTC and converted with local time.) |
| 12 | Deploy | SOW/POA files live in the database, not on local disk (survives redeploys, works with several instances). |
| 13 | Robustness | Audit-trail name lookup never 500s the request (falls back to the raw id); weekly-brief `days` limited to 1–90; owner lookup includes deactivated users. |

Earlier fixes: audit trail showed HubSpot user ids → now names; "Unassigned" caused by deactivated owners missing from the lookup; Sync menu wired to refresh data; watermark logo removed; `$` → `₹`.

---

## 6. Known limitations / backlog

- `GET /programs` returns all programs (no server-side paging) and the dashboard computes its metrics client-side; no ETag / conditional requests, so every open tab refetches ~6 endpoints per minute. Fine for hundreds of programs — **planned fix in §6b.**
- "Sync now" is limited to managers/CSMs (plus the single-flight lock + 20 s cooldown).
- Notes written in-app take the author name from the request body rather than the logged-in user.
- Programs skipped as malformed are only retried when edited in HubSpot (no dead-letter table yet).
- SOW-derived deal value briefly reverts to the description value between the programs upsert and the SOW re-apply within a sync (milliseconds; no user impact observed).
- The SOW/POA "event name" match is company-only; event name is not compared (it is empty on most tickets).
- Extraction quality depends on the LLM; results are schema-validated but not fact-checked against the PDF.
- Postgres runs in a local Docker container; no backups/PITR configured. Supabase or a managed Postgres is under consideration (see decisions).
- `backend/storage/` is obsolete (files moved to the DB) and can be deleted.

## 6b. Planned enhancements

### Fast dashboard: server-side aggregates, paging and caching _(designed 2026-09-30, not built)_
**Problem:** the dashboard downloads every program and computes KPIs, funnel, campaign mix, attention queue and filters in the browser; every open (and every 60 s refresh) re-queries the DB. Fine for hundreds of programs, too slow/heavy at thousands.

**Design (build in this order):**
1. **Aggregates in SQL** — `GET /programs/dashboard` returns only the numbers (active count, pipeline value, blocked count, per-stage counts + values, campaign mix). `GROUP BY` over the existing indexes; response is a few KB regardless of table size. Move the "blocked / attention queue" logic to SQL too.
2. **Version + cache (biggest win, do first with #1)** — data only changes when a sync finishes, so keep a `data_version` (bumped at the end of each sync; single-row table or reuse the cursor row). Cache the dashboard + first-page responses in memory keyed by that version, rebuilt once per sync. Send the version as an `ETag` so returning browsers get `304`. Add a tiny `GET /programs/version`. In-process cache is enough for one API process; with several workers each checks the shared version (one-row query); Redis only if that stops being enough.
3. **Cursor-paged list** — `GET /programs?limit=25&cursor=…` with server-side filters (stage, campaign type), sort, and search. Cursor = last row's `(last_modified_at, ticket_id)` (constant-time deep pages, unlike offset). Search via `pg_trgm` GIN index (migration). Program detail page keeps fetching a single program.
4. **Frontend** — replace the client-side aggregation with the summary endpoint; table uses the paged endpoint; TanStack Query persisted to localStorage so the page paints instantly from the last copy, then polls `/programs/version` and refetches only when it changed (replaces the 60 s refetch of ~6 endpoints).

**Open choices:** page size (proposed 25); in-memory cache vs Redis (proposed in-memory).

### Registrations tab + Slack notifications _(built 2026-09-30)_
- **Registrations tab** (third tab beside SOW / Marketing schedule; `components/program-registrations.tsx`, ported from Lovable commit `b683088` but wired to the API — no seed data, no `localStorage`): stat cards, per-day bar chart (+ "relevant" line for hiring), role filter, add-a-day form, roles / extra fields, CSV import (parsed in the browser, sent as one batch → one Slack summary), editable table.
- **Slack channel box** at the top of the tab: type a channel ID → the `#name` is looked up live (`conversations.info`) before saving; after saving the name is shown with Change / Send test / Remove. **Notify Slack** toggle button next to "Update registrations", **on by default**, persisted per program.
- **Behaviour:** saving counts (same date+role replaces) posts one summary (per-day totals, roles, that day's POA marketing activities, running total) when notify is on and a channel is set. A Slack failure never blocks the save — the UI shows "Saved N. Slack notification failed: …".
- **Open follow-ups:** the Slack app token needs `channels:read` + `groups:read` (lookup) and `chat:write` (post), and the bot must be invited to each channel (`/invite`). No daily "due today" digest.

---

### Dating undated plans from the SOW + Redash _(feasibility checked 2026-10-07, not built)_
- HackCellence SOW states **durations, not dates**: "2/3-week registration window", target 10,000+ candidates, 4 sequential stages, 2-day onsite, registration data report "weekly on Mondays". Only absolute date is the order date (2026-09-08).
- **Bug found:** the SOW `timeline` for HackCellence shows all four stages starting 2026-09-08 (the order date) — the model defaulted a date because `Milestone.start` is required. Same class as the POA "January" bug; fix = make `start` nullable and sanitise like `sanitize_poa`.
- Real anchor dates exist in Redash (queries 6142/6123: event Start/End; HackCellence 2026-09-21 to 2026-10-08, about 2.5 weeks, consistent with the SOW). The HubSpot ticket's own registration/event dates are empty.
- Plan: once a program is linked to its event, derive **estimated** dates for undated POA rows (`Week N` -> Start + 7 x (N-1), clipped to End), labelled "estimated"; derive Monday report due dates; compare registrations against the SOW target and the expected pace. Estimates must be visibly distinct from document-stated dates.

---

## 7. Decisions

- **Database:** stay on PostgreSQL (relational/OLTP fits: upserts, notes, point lookups; data is small). Supabase is acceptable as *hosting* — use only the Postgres (own FastAPI handles auth), use the pooled connection for the app and direct for Alembic. Add an analytical store (BigQuery/ClickHouse) later *alongside* Postgres if reporting outgrows it; keep history append-only and keep `raw_properties` to make that easy.
- **Event name** = HubSpot `program_name`; old `event_name` dropdown is the fallback.
- **Deal value precedence:** SOW > ticket description > HubSpot field.
- **Documents in Postgres** (`bytea`) rather than object storage while files are small PDFs; revisit if volume or file size grows.
- **Extraction sends the PDF itself** to the model (the POA is a table whose column decides the channel; plain-text extraction loses that).
- **No manual "done" ticks** on timelines — status is derived from dates only (removed after review).

---

## 8. Changelog

- 2026-10-19 (backend decisions) — Invite lifetime 3 days; reminder defaults accepted (approval pending > 4 h, go-live reminder 2 h ahead); HubSpot token write scope deferred (write-back stays behind its flag); Sai Revanth `sai.revanth@hackerearth.com` is the super admin via `SUPER_ADMIN_EMAILS`; roles are chosen by the inviter in the invite form and the first-login role picker is removed. Items 1-3, 5, 6, 9, 10 of the Stitch-vs-proposal list in `docs/BACKEND_DESIGN.md` §10.2 are still unanswered. No code changed.
- 2026-10-19 (backend design) — `docs/BACKEND_DESIGN.md` written: capability-based permissions with multi-role users and per-user grants, invite-only OAuth, immutable `program_events`, marketing activity tables with a DB trigger for BR-04, rounds/requests/relevant-registrations/channel-snapshot/outbox/settings tables, endpoint contract per use case, 14-step migration plan, test plan on real Postgres, and a screen-to-API map for the 7 Stitch reference screens. Records 15 differences between the Stitch references and the approved proposal that need decisions. Finding: `docs/` and `.claude/` are gitignored, so these docs are untracked. No code changed.
- 2026-10-19 (proposal) — Team-approval document written: `docs/PROGRAMOPS_PRODUCT_PROPOSAL.md` (diagnostic, personas, 18 use cases, solution, features, roles, 16 business rules, ICE prioritisation, release plan, risks, decisions, sign-off table). Proposes splitting reminders from HubSpot write-back and putting write-back last (gated on token scope). Checklist count corrected to 25 items (earlier text said 28). No code changed.
- 2026-10-19 (answers 2) — PRD open questions answered: CSM enters relevant registrations for now (scheduled automation later, entries record typed vs automatic); CSMs + super admins edit request types/templates; super admin edits reminder time/hours/time zone; marketing may log requests, comment and post updates; retention permanent but a super-admin setting (nothing auto-deleted in R1); super admin grants per-member permissions on top of role defaults. New features F-12 (settings), F-13 (comments/updates/requests). Remaining: HubSpot token needs ticket-update scope (dependency), relevant-registrations automation rule (later). No code changed.
- 2026-10-19 (answers) — 12 PRD questions answered and recorded in the PRD (Decisions table): relevant registrations per day, summed; Sai as only initial super admin; copy-link invites + Slack-only reminders (no email in R1); marketing types views/CTR; HubSpot wins on write-back conflicts; approval is approved/not yet; any CSM can approve any program; account managers view + log requests/comments; reminders in the program Slack channel; round counts CSM-only; content gate is a dynamic per-request-type checklist; retention to leadership/legal (keep everything meanwhile). 6 questions remain open. No code changed.
- 2026-10-19 (later) — PRD written: `.claude/prds/programops.prd.md` (features F-01..F-66 by stakeholder, flows, metrics, 12 open questions). Decisions recorded: invite link + Google sign-in via super admin; CSM-only client approval with named actor; separate relevant-registrations number; round data CSM-entered; R1 includes reminders, views/CTR, HubSpot write-back; no client link in R1. No code changed.

- 2026-10-19 — Product design written: `docs/PRODUCT_DESIGN.md` (marketing + CSM workspaces, data model, phases, open questions). Findings: Redash 6170/738 already give per-channel / UTM registrations (the "aggregate only" meeting claim is wrong; ~56 % of HackCellence's 44,148 is organic/pre-registered); role self-selection at first login lets any signed-in Google user become an editor (fix = `role_assignments` allowlist, phase 0). Commit `a67ccae` (restyle + role gating) landed. No code changed.

- 2026-10-16 — Frontend restyled as a sibling of Ticket-Hub (see `frontend-reference.md`): its 8 brand accents + 5 `--status-*` colours as tokens in `styles.css` (shadcn token names kept as aliases; hex, light + dark), pipeline `stage-*` colours now the ordinal blue ramp + aqua/neutral, Inter + JetBrains Mono self-hosted via fontsource (Google Fonts links removed), flat surfaces (1px border + faint shadow, hover lift only; no blur, glow or entrance animations), compared numbers in mono tabular, missing value is `—`. Behavioural patterns (skeleton/retry cards, URL sync, etc.) deliberately not adopted.

- 2026-10-08 — Role-based access: managers and CSMs edit, everyone else is view-only (backend 403 + frontend controls hidden); role is locked after first login so a viewer can't self-promote via `PATCH /users/me`.

- 2026-10-08 — Registrations chart: removed the marketing-activity dots (ambiguous; marketing dates stay in the Marketing schedule tab and the hover tooltip). Redash box hidden (manual entry only) for programs whose `platform_details` includes "Non-HE Platform" (frontend-only gate; the Redash API routes are not blocked).

### 2026-10-01
- Registrations: Auto (Redash) vs Manual per program, wired to the **real** he-metrics queries (verified live 2026-10-07). **6142** (`REDASH_EVENTS_QUERY_ID`) lists active events (slug, name, type Hackathon/HC, company, live) and feeds the slug picker (`GET .../registrations/redash/events`, cached 10 min server-side). **6123** (`REDASH_REGISTRATIONS_QUERY_ID`, param `event_slug`) returns one row per event whose `Registration Daily JSON` is `[{date, count}]`: registrations only, **no role split and no "relevant" count**. Each day's `count` is treated as that day's **relevant registrations** (confirmed with the user): stored with `role=''` and `registrations = relevant = count`, so the chart bars are fully bright and the Relevant card equals the total; manual entry is hidden in auto mode. (`relevant` stays nullable from migration `11a50e20a20b`; nothing writes NULL now.) Flow: pick/type slug, **Check shows the event name, company, type, live flag and dates and asks "Is this the right event?"** (`POST .../redash/check`, returns event info only, no registration data, nothing saved), then "Yes, use this event" (`PUT .../redash`, `auto: true`, stores `redash_event_title`, migration `6203af446889`) which immediately fetches the days (`POST .../redash/run`). Fetch/sync (`core/redash_sync.py`) upserts only new or changed days and writes `registrations` + `relevant` on conflict; the Slack summary lists just those changed days. A silent **hourly scheduler job** refreshes every auto program (no Slack). Dashboard table has a **Registrations** total column (`GET /programs` adds `registrations`).
- Docker deployment (mirrors Ticket-Hub / Content-Pulse): `backend/Dockerfile` (python 3.13 + uv, :8000), `frontend/Dockerfile` (build with `--build-arg VITE_API_BASE_URL=<public API url>`, served by `frontend/serve.mjs` via srvx, :3000), `docker-compose.yml` with two independent services (no `depends_on`, no nginx proxy, no inter-container hostnames; they only meet through public URLs). Backend env: `DATABASE_URL` must be reachable from the container, `FRONTEND_URL` / `API_BASE_URL` set to the public URLs, `ENVIRONMENT=production` (cookie `SameSite=none; Secure`, so both need HTTPS). Run migrations once: `docker compose run --rm backend uv run --no-sync alembic upgrade head`. Known: `frontend/package-lock.json` is out of sync (image uses `npm install`); the `preset: "node-server"` in `vite.config.ts` is ignored by the installed plugin, hence `serve.mjs` instead of a Nitro `.output`.
- Removed em-dashes from frontend/backend source (UI copy, placeholders, comments); empty-value placeholder is now "-". Docs left as is.
- Registrations: Slack channel box shows a warning note ("Slack channel not added — add one before posting updates") when no channel is saved. Frontend only.
- SOW timeline / Marketing POA: removed Done/Upcoming/Ongoing badges, past-item dimming and the "X of N activities done" progress bar (now "N planned"); only today's item glows. Frontend only (`program-documents.tsx`).

### 2026-10-07 (production still showed January POA dates, PR #1)
- **Cause:** documents extracted under the old rules were never re-read (only SOWs had a staleness check), so invented dates already saved in the DB survived the fix. **Fix:** `EXTRACTION_VERSION` is stamped into every stored `details["_v"]`; a document with a different/missing version is re-extracted once on the next sync (one LLM call each). Bump the constant whenever extraction rules change. Verified locally: 8 documents re-read, dated POAs kept their stated dates, undated stayed undated.
- Estimate anchor gains a last-resort fallback: the POA's own stated campaign window (`start_source = "POA window"`), after Redash event start, HubSpot registration_start_date and first entry.
- **Production checklist:** deploy the PR, `alembic upgrade head`, restart, then let the sync run (or force "Sync HubSpot now"); undated rows then show estimated ranges once a start date exists (link the Redash event, or HubSpot registration start date, or enter a first count).

### 2026-10-07 (security fix, PR #1)
- **Redash slug injection:** query 6123 is a Redash *Python* query that substitutes `{{event_slug}}` into its source (`EVENT_SLUG = "{{event_slug}}"`), so an unvalidated slug typed in the UI could run code on the Redash worker. Slugs are now validated (`[A-Za-z0-9_-]{1,100}`) in `redash_sync.fetch_event` (covers check, save, fetch and the 6-hourly job) and on save, returning 422. Never pass user text to a Redash parameter that a Python/SQL query interpolates without validating it first.
- **Open (pre-existing, not changed here):** `core/config.py` documents that any Google account can sign in (no `ALLOWED_EMAILS`/domain check), so every signed-in user can read all programs and use the Slack/Redash endpoints. Recommend restricting sign-in to the company domain.

### 2026-10-07 (later)
- `sanitize_poa` now keeps stated dates up to 30 days outside the document's own window (was: any date outside it was nulled, which would have dropped real post-campaign dates).
- **SOW extraction:** `Milestone.start` is nullable (no more order-date stand-ins: HackCellence's four stages now come back undated), plus structured `registration_window_weeks_min/max` ("2/3-week" -> 2,3) and `registration_target` ("10,000+" -> 10000); `sanitize_sow`. SOWs extracted before these fields existed are re-read once automatically (`needs_processing` schema check).
- **Estimated registration timeline** (Registrations tab, manual and Redash alike): `GET .../registrations` now returns `estimate` = start (Redash event start if linked, else HubSpot registration_start_date, else first entry) and end (real Redash event end, else start + SOW weeks; `end_min` optimistic), target. UI panel: opens/closes (labelled "estimated" unless actual), progress vs target, expected-by-today and the gap, even pace/day; chart gets an "Expected / day" reference line. Redash event start/end persisted (`redash_event_start/end`, migration `612fbfda5ff5`).
- **Estimated POA dates:** undated POA rows with a "Week N" label show an estimated range (start + 7 x (N-1), clipped to the end) marked "Est." with a "This week" badge (no glow: only document-stated dates glow). Without a start they stay "Date TBC". Undated SOW stages show "Date TBC" and run in listed order.
- **Schedules + overrides:** HubSpot sync every 10 min (unchanged), Redash registrations refresh every **6 h** (`REFRESH_HOURS`, silent, single-flight, per-program failures counted not fatal). Both have a header override under the "Live from HubSpot" pill: "Sync HubSpot now" (`POST /programs/sync`) and "Reload registrations now" (`POST /programs/redash/sync`, status at `/programs/redash/sync/status`, 20 s cooldown).
- Bug fixed on the way: event title/dates were only committed when a day's count changed.

### 2026-10-07
- Redash follow-up: day count = relevant registrations (graph bright), event is confirmed by name before dates are fetched, event title persisted. Verified live: sync picked up the HackCellence ticket (49246541494); its POA has no dates in the document and came back with all 14 activities undated, window empty (no invented dates).
- **Fix: POA dates.** The extraction schema forced a date on every POA row, so the model invented one (e.g. 1 Jan) when the document had none. `PoaActivity.date` and the window are now nullable, the prompt forbids guessing, and `sanitize_poa` nulls any date outside the stated window (or >120 days from the median of the document's dates when there is no window). Undated rows show as "Date TBC", never glow, and are skipped by due-today and the Slack message; a banner counts them.
- **Fix: SOW checklist.** An uploaded SOW now counts as `SOW Shared` + `SOW Signed` in the Pre Sales checklist even if the HubSpot boxes aren't ticked (`derived_items`, shown as "(from uploaded SOW)"; constant `SOW_ITEMS` in `program_routes.py`). If "signed" should need the HubSpot tick, drop it from `SOW_ITEMS`.
- **Redash:** aligned the existing (never-run) auto-registrations feature with the real queries 6123/6142 (see section 4), added the active-event picker, hourly auto refresh and the dashboard Registrations column. `registration.relevant` is now nullable (migration `11a50e20a20b`). Slack summary omits "relevant" for days where it is unknown.
- Process note: an earlier Redash implementation already existed in the repo; a duplicate written this session was rolled back (migration `3f8a941ea2ac` downgraded and deleted) before building on the existing one.

### 2026-09-30
- Relevant registrations is now mandatory for every entry (per role for Coding Challenge, per day for Hackathon): required in the form, strict CSV (whole file rejected with the line number if a row lacks it or relevant > registrations), required by the API; relevant shown in stats, stacked chart, tooltip and table for all programs.
- Registrations form: hiring programs with no roles yet show a hint and disable Add (Lovable pre-seeded fake roles; we start empty). Roles appear only for `Coding Challenge` programs, as in the Lovable design.
- Hiring registrations chart: stacked bars (bright relevant + dim remainder = total) replace the relevant line; API rejects relevant > registrations.
- Notify Slack moved into the add-day form (small toggle beside Add, default on); Slack message now leads with the date and includes the counts (role, registrations, relevant; extra fields are not posted) + that day's marketing activities + running total; live message preview in the form (`POST …/registrations/preview`, same formatter as the real post).
- Built the Registrations tab + Slack channel box + default-on Notify Slack toggle (§6b); new tables via `af15727fc3b0`; `core/slack.py` client; `SLACK_BOT_TOKEN` setting. Fixed the Hiring view / hiring-only UI to use HubSpot's real `Coding Challenge` campaign type (was `Hiring Challenge`).
- Reviewed the latest Lovable commit (registrations tab & graph) and planned registrations persistence + Slack notify (§6b) — not built yet.
- Documented the planned fast-dashboard design (server-side aggregates, version/ETag cache, cursor paging, instant-paint frontend) in §6b — not built yet.
- Pipeline hardening pass (see §5 items 1–13): chunked upserts, skip-bad-ticket, retry/backoff, 10k-cap windowing, document retry pass, deletion reconcile, single-flight sync with advisory lock, background `POST /programs/sync` + `/sync/status`, light list/document queries, indexes, `timestamptz`, documents stored in DB. Migration `3b96137f8397`.
- Frontend "Sync now" now polls sync status and refreshes when finished; auto-refresh interval 30 s → 60 s.
- Added `backend/tests/test_etl.py` (7 checks: chunking, delete guard, backoff, document retry policy, junk deal size, search windowing, malformed-ticket skip).
- Added this document + `CLAUDE.md` rule to keep it current.
- Ops: DB container `database` was stopped by a reboot; restart with `docker start database`.

### 2026-09-29
- SOW & POA: download from HubSpot (`files.ui_hidden.read`), schema-validated OpenAI extraction, section below the program brief with View / Download, date-driven glowing timeline; "Due today" dashboard strip. Migrations `c8b5492f2997`, `d6c65373f2c5` (tick table added then dropped).
- Deal value from SOW / description; company name fallback from description "Client's Name".
- Audit trail and notes show user names (HubSpot owners `userId` map), newest first, scrollable; "Ticket owner" in the brief.
- Event name ← HubSpot `program_name`; `platform_details` shown in the brief; campaign mix counts active stages only. Migration `c898e9307afe`.
- Owner lookup includes deactivated users; company/account line replaced by account manager + CSM names.
- "Sync now" option on the "Live from HubSpot" pill; ₹ formatting; HackerEarth watermark removed; DB cleared of dummy data.

### 2026-09-25 → 2026-09-28
- Initial build: FastAPI backend, HubSpot ticket sync (programs, stage history, notes, checklists), Google OAuth login with role capture, dashboard and program detail wired to the API, weekly AI brief. Migrations up to `e6e381ee997e`.
