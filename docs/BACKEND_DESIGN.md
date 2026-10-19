# ProgramOps: Backend design

_Draft v1, 2026-10-19. Builds on `docs/PROGRAMOPS_PRODUCT_PROPOSAL.md` (what and why) and `.claude/prds/programops.prd.md` (requirements). This document is the how: data model, API, rules, jobs, tests and build order. It also maps each Stitch reference screen to the API it needs._

Reference screens read for this design: `Downloads/stitch_programops_control_room_portal/` (7 screens plus `DESIGN.md`). Section 10 lists where they differ from the approved proposal; those items need a decision before the frontend is built.

---

## 1. Starting point and constraints

| Today | Consequence |
|---|---|
| FastAPI async, SQLAlchemy 2 + psycopg, Alembic (15 migrations), fastapi-users (Google OAuth, cookie session), APScheduler in-process | Extend, don't rewrite. Routers stay under `/programs`, `/users`, `/api/auth` |
| Authorization is one check, `require_editor` (role in manager, csm) | Replace with capability checks and per-user grants |
| Users have one nullable `role` they pick at first login | Replace with admin-assigned roles; users can hold several (Stitch shows a "Dual-Role" user) |
| Only `tests/test_etl.py` (7 checks, no API or DB tests) | Add an API test harness before any new rule is built |
| Postgres features already in use: ARRAY, JSONB, timestamptz | Tests must run on real Postgres (not SQLite), because we also add triggers and partial indexes |

**Design principles**
1. Every write goes through a service function that checks the rule, writes the row and writes the audit event in one transaction.
2. Rules that must never break (go-live needs approval, audit is immutable, last super admin) are enforced in the database as well as in code.
3. HubSpot is the master for ticket state and Redash for daily registrations. The portal stores only what they cannot.
4. Slow or flaky systems (Redash 6170, Slack, HubSpot writes) never run inside a user request without a stored result or an outbox.
5. Machine-readable error codes on every refusal, so the frontend shows its own wording.

---

## 2. Module layout

```
backend/
  api/
    auth_routes.py            (exists)  + invite acceptance
    admin_routes.py           NEW  users, invites, permissions, settings, audit export
    me_routes.py              NEW  /me, effective permissions
    program_routes.py         (exists)  + portfolio, search
    activity_routes.py        NEW  marketing plan, approval, go-live, metrics, nudge
    registration_routes.py    (exists)  + relevant registrations, sources, lift
    round_routes.py           NEW  rounds and counts
    request_routes.py         NEW  request types, requests, checklists
    update_routes.py          NEW  daily updates, comments
    queue_routes.py           NEW  CSM queue, marketing queue
    system_routes.py          NEW  freshness, slack outbox
  core/
    permissions.py            NEW  catalogue, role defaults, require_permission
    audit.py                  NEW  record_event, immutable log
    errors.py                 NEW  DomainError(code, status, detail)
    invites.py                NEW  create, verify, consume
    activities.py             NEW  service layer for marketing rules
    rounds.py, requests.py    NEW  service layers
    health.py                 NEW  program health from facts
    channel_sync.py           NEW  Redash 6170 snapshot + attribution + lift
    reminders.py              NEW  scan, dedupe, enqueue
    slack_outbox.py           NEW  queue and sender
    settings_store.py         NEW  key/value settings
  hubspot_client/
    writer.py                 NEW  guarded PATCH with conflict check
  tests/
    conftest.py               NEW  real-Postgres fixtures
    test_*.py                 NEW  per area (section 9)
```

Routes stay thin: parse, authorize, call a service, shape the response. Business rules live in `core/*`.

---

## 3. Identity, roles and permissions

### 3.1 Roles
`super_admin`, `csm`, `marketing`, `account_manager`. A user holds one or more (Stitch shows Sai Revanth as Super Admin + CSM). This resolves proposal open item 5: yes, dual roles are supported.

### 3.2 Permission catalogue
Defined in `core/permissions.py`; role defaults live in code, not the database.

| Permission | super_admin | csm | marketing | account_manager |
|---|---|---|---|---|
| `program.view`, `audit.view` | yes | yes | yes | yes |
| `comment.add`, `request.create` | yes | yes | yes | yes |
| `update.post` (daily update) | no | yes | yes | no |
| `activity.edit` | no | yes | yes | no |
| `activity.add_channel` | no | yes | yes | no |
| `activity.approve` | no | **yes** | no | no |
| `metrics.enter` | no | yes | yes | no |
| `relevant.enter` | no | **yes** | no | no |
| `registrations.manage` (manual, target, dates) | no | yes | no | no |
| `rounds.edit`, `counts.enter` | no | yes | no | no |
| `request.manage` (status, checklist confirm) | no | yes | no | no |
| `request_types.edit` | yes | yes | no | no |
| `hubspot.write` | no | yes | no | no |
| `integrations.link` (Redash, Slack, sync) | no | yes | no | no |
| `users.manage`, `settings.edit` | **yes** | no | no | no |

Note: the earlier proposal said a super admin has no program actions. A dual-role super admin gets the CSM defaults through the CSM role.

### 3.3 Effective permissions
`effective = union(defaults of every role the user holds) + grants - revokes`. Overrides live in `user_permission_overrides`. Stitch shows both directions ("Role Defaults + Write to HubSpot", "+ Edit Request Templates").

### 3.4 Enforcement
`Depends(require_permission("activity.approve"))` replaces `require_editor`. A 403 returns `{"detail": "...", "code": "permission_denied", "permission": "activity.approve"}`.

### 3.5 Safeguards (BR-03)
- The last remaining super admin cannot be demoted, removed or revoked (service check plus a deferred database constraint trigger).
- A user cannot change their own roles or permissions (the Stitch "Change Role" button is disabled on the signed-in row).
- Role and permission changes write an audit event.

### 3.6 Invite-only sign-in (BR-01, BR-02)
`invites(email, roles, token_hash, status, expires_at, ...)`. Only the SHA-256 of the token is stored.

Flow:
1. Super admin `POST /admin/invites {email, roles}` returns `{id, link, expires_at}` once. The link is `FRONTEND_URL/invite/<token>`.
2. Frontend opens `GET /invites/{token}`. Public, rate limited. It returns `{valid, email_hint, roles}` (the email partly masked) or 404/410.
3. "Continue with Google" goes to `/api/auth/google/login?invite=<token>`. The signed OAuth state carries the token.
4. In the OAuth callback (override of `UserManager.oauth_callback`):
   - existing active user: sign in as normal;
   - otherwise require a valid pending invite whose email equals the Google email (case-insensitive, verified email only); create the user, grant the invite's roles, mark the invite accepted, audit it;
   - anything else: redirect to `FRONTEND_URL/login?error=not_invited`.
5. Expiry: **3 days**. Expired is computed at read time (no sweeper needed), with an `expired` status written lazily.
6. Super admin can resend (new token, old one dies), revoke, re-issue and delete (Stitch shows all four).

**Roles are set by the inviter, never by the invitee.** The invite carries one or more roles (`roles[]`, any of super_admin, csm, marketing, account_manager), chosen by the super admin in the invite form. On acceptance the user gets exactly those roles. The first-login role picker is removed: `role` is dropped from the `UserUpdate` schema and `PATCH /users/me` rejects it (`permission_denied`), so nobody can pick or change their own role. A signed-in user with no roles sees a "waiting for access" state (`/me` returns `pending: true`).

Bootstrap: `SUPER_ADMIN_EMAILS` env, set to `sai.revanth@hackerearth.com` (Sai Revanth, the only super admin at the start). On startup, idempotently ensure that user exists with the `super_admin` role (and `csm` if dual-role is wanted) so the first Google login succeeds without an invite token. Anyone else is added through the invite form.

Stopgap until this ships: optional `ALLOWED_EMAIL_DOMAIN` check in the same callback.

---

## 4. Data model

New tables, all Alembic migrations (section 8). Conventions: `timestamptz` UTC; `id` is `bigint identity` unless noted; every portal-owned row has `created_by`/`created_at`; foreign keys `ON DELETE CASCADE` from `programs`.

### 4.1 Access
```
user_roles(user_id fk, role text CHECK in (...)), PK(user_id, role)
user_permission_overrides(user_id fk, permission text, granted bool, set_by fk, set_at), PK(user_id, permission)
invites(id uuid pk, email text, roles text[], token_hash text unique, status text
        CHECK in (pending, accepted, revoked, expired), expires_at, created_by fk,
        created_at, accepted_at, accepted_user_id fk null)
  partial unique index: one pending invite per lower(email)
```

### 4.2 Audit (BR-14)
```
program_events(id, ticket_id fk null, entity text, entity_id text, action text,
               field text null, old jsonb null, new jsonb null,
               actor_id fk null, actor_name text, at timestamptz default now())
  index (ticket_id, at desc), index (entity, entity_id, at desc), index (actor_id, at desc)
  trigger: BEFORE UPDATE OR DELETE raises (append-only, even for the app user)
```
`actor_name` is copied at write time so history reads correctly after a rename or removal. `ticket_id` is null for admin events.

### 4.3 Marketing
```
program_activities(
  id, ticket_id fk, code text           -- display code like W1-ACT-04, unique per program
  poa_key text null,                    -- stable key from the POA row (week+channel+title hash)
  source text CHECK in (poa, manual),   -- manual = "ADDED" (unplanned) badge
  week int null, channel text, title text, action text, audience text, outcome text, hook text,
  target_note text null,                -- e.g. "Target: 800 applicants"
  status text CHECK in (not_started, wip, live, off) default not_started,
  approved_by fk null, approved_at timestamptz null,    -- null = not yet approved
  go_live_at timestamptz null, comes_off_at timestamptz null,   -- time matters: "18:00 IST cutoff"
  utm text null, creative_proof_url text null, tracker_ref text null,
  planned_date date null,
  updated_by fk, updated_at, created_at,
  UNIQUE(ticket_id, poa_key) where poa_key is not null,
  UNIQUE(ticket_id, code))
trigger BEFORE UPDATE: if NEW.status='live' AND OLD.status<>'live' AND NEW.approved_at IS NULL
        -> raise 'activity_live_requires_approval'   (BR-04)
```
**Why a trigger and not a CHECK constraint:** BR-08 says withdrawing approval on a live activity must create a *breach*, which is exactly "status = live and approved_at is null". A static CHECK would block that state. The trigger blocks only the *transition* into live. Breach is derived: `status='live' AND approved_at IS NULL`.

```
activity_metrics(activity_id fk, date, views int null, clicks int null, sent int null, opens int null,
                 entered_by fk, entered_at, PK(activity_id, date))      -- BR: CTR derived, never stored
channel_snapshots(id, ticket_id fk, fetched_at, rows jsonb, total int, query_id text, status text)
  index (ticket_id, fetched_at desc)
program_assignments(ticket_id fk, user_id fk, role text CHECK in (csm, marketing, account_manager)),
                    PK(ticket_id, user_id, role)
```
`program_assignments` exists because HubSpot has no marketing-owner field and the Stitch overview shows owners "Priya (CSM), Rahul (Mktg), Meera (AM)". CSM and account manager are also resolved from HubSpot owner email to portal user, so "My programs" works without manual assignment.

### 4.4 Registrations
```
relevant_registrations(id, ticket_id fk, date, count int CHECK >= 0, criteria text null, note text null,
                       source text CHECK in (manual, auto) default manual,
                       entered_by fk, entered_at, supersedes_id fk null)
```
Append-only; a correction inserts a new row with `supersedes_id`. "Current" rows are those not referenced by another row's `supersedes_id`. Total relevant = sum of current rows. `criteria` and `note` come from the Stitch form ("Evaluation criteria / Tier filter", "Audit note & source batch").

`program_registration_settings` gains `target int null`, `campaign_start date null`, `campaign_end date null` (overrides of SOW/HubSpot).

### 4.5 Rounds
```
program_rounds(id, ticket_id fk, seq int, name, kind text CHECK in (assessment, project, interview, onsite, custom),
               starts_on date null, ends_on date null, cutoff_rule text null, cutoff_value numeric null,
               status text CHECK in (planned, live, evaluating, done) default planned,
               source text CHECK in (sow, manual), UNIQUE(ticket_id, seq) DEFERRABLE)
round_counts(id, round_id fk, as_of date, invited int null, attempted int null, cleared int null,
             shortlisted int null, note text null, entered_by fk, entered_at, supersedes_id fk null)
  CHECK (cleared <= attempted), CHECK (attempted <= invited) when both present
```

### 4.6 Requests and checklists
```
request_types(id, key text unique, name, active bool, created_by fk, created_at)
request_type_items(id, type_id fk, seq, label, instruction text, required bool, needs_detail bool)
program_requests(id, ticket_id fk, type_id fk, title, detail text, owner_id fk null,
                 status text CHECK in (open, in_progress, ready, done, declined),
                 due_at timestamptz null, requested_by fk, resolution text null, created_at, updated_at)
request_items(id, request_id fk, seq, label, instruction, required bool, needs_detail bool,    -- snapshot (BR-12)
              confirmed_by fk null, confirmed_at null, detail text null)
```
Items are copied from the type when a request is created, so editing a type later never changes existing requests (BR-12). A request can move to `ready` only when every required item is confirmed (service rule plus trigger).

Seed: type `content_to_marketing` with four required items (image quality meets spec, client approved the copy, logos and brand assets received, eligibility and dates verified).

### 4.7 Updates, comments, notifications, settings
```
program_notes  + columns: kind text CHECK in (note, comment, update) default note,
                          health text null CHECK in (good, warning, critical),
                          blockers text null, author_id fk null
   -- existing HubSpot notes stay kind=note with author_id null; portal rows must have author_id (BR-06 fix)
slack_outbox(id, ticket_id fk null, channel_id text, kind text, payload jsonb, dedupe_key text null,
             status text CHECK in (queued, sent, failed, skipped), attempts int default 0, error text null,
             created_at, sent_at null)
  UNIQUE(dedupe_key) where dedupe_key is not null
settings(key text pk, value jsonb, updated_by fk, updated_at)
  keys: reminder_time ("09:30"), working_hours ({start,end,days}), timezone ("Asia/Kolkata"), retention_days (null = forever)
```

### 4.8 Program health (computed, not stored)
`core/health.py` returns `good | warning | critical` from facts, in this order:
1. critical: any control breach, or latest daily update is critical;
2. warning: any overdue request, round ended without counts, update older than 2 working days, or latest update is warning;
3. good: otherwise.
Stitch also shows "Attention" for a program with no Slack channel and "Breach"; those are flags returned beside `health`, not new states.

---

## 5. API contract

Conventions (from the API design skill, adapted to what exists):
- Keep current unversioned routes. Version later only on a breaking change.
- Resource nouns, plural, kebab-case. Actions that don't fit CRUD use `POST .../{action}` sparingly (`approve`, `go-live`, `nudge`).
- Create returns `201` with `Location`. Delete returns `204`.
- Errors: FastAPI's `{"detail": "..."}` stays; new routes add `"code"` and, where useful, `"errors": [{field, message}]`. Validation is `422`, rule refusals `409`/`422` with a code, permission `403`, auth `401`.
- Lists: small ones return arrays. Long ones (audit log, notes, metrics) use keyset pagination: `?limit=50&before=<opaque cursor>` returning `{items, next_cursor}`.
- All times ISO 8601 UTC; the frontend renders in the settings timezone.
- Every mutating route requires a permission and writes an audit event in the same transaction.
- Optimistic concurrency on edited rows: client sends `If-Match: <updated_at>`; mismatch returns `409 stale_write`.

### 5.1 Identity and admin
| Method + path | Permission | Notes |
|---|---|---|
| `GET /me` | any signed-in | `{user, roles, permissions[], pending: bool}` (pending = no roles yet) |
| `GET /admin/users` | users.manage | filter `role`, `status`, `q`; returns roles, status, effective permission profile, last_active |
| `PATCH /admin/users/{id}` | users.manage | roles, status; enforces BR-03 |
| `PUT /admin/users/{id}/permissions` | users.manage | `{grants[], revokes[]}` replaces overrides |
| `GET /admin/users/{id}/permissions` | users.manage | effective permissions, used by the "View as" preview |
| `POST /admin/invites` | users.manage | `{email, roles}` returns link once |
| `GET /admin/invites` | users.manage | |
| `POST /admin/invites/{id}/resend` / `/revoke` / `/reissue`; `DELETE /admin/invites/{id}` | users.manage | |
| `GET /invites/{token}` | public, rate limited | validity and role preview |
| `GET /admin/audit?actor=&program=&entity=&before=&limit=` | audit.view | keyset; `Accept: text/csv` for export |
| `GET /admin/settings`, `PUT /admin/settings` | settings.edit | reminder time, hours, timezone, retention |

### 5.2 Portfolio, search, status
| Method + path | Notes |
|---|---|
| `GET /programs` | existing; add `health`, `flags[]`, `registrations`, `target`, `marketing: {live, total, awaiting}`, `rounds_summary`, `csm`, `stage_key`; filters `stage`, `health`, `csm`, `client`, `q` |
| `GET /programs/portfolio` | totals for the directory header: active count, health split, total vs target registrations, stage distribution, action-item counts (breaches, pending approvals, UTM gaps) |
| `GET /search?q=` | programs by name, ticket id, client, CSM; ILIKE now, trigram index later |
| `GET /system/status` | last success time and age of HubSpot sync, Redash registrations, channel snapshots, Slack outbox backlog |

### 5.3 Marketing (plan, approval, go-live, results)
| Method + path | Permission | Notes |
|---|---|---|
| `GET /programs/{id}/activities` | program.view | grouped by week; each row includes approval (who/when), breach flag, `utm_ok`, latest metrics |
| `GET /programs/{id}/activities/summary` | program.view | channels live, approved, awaiting, breaches, % ramp (the control strip) |
| `POST /programs/{id}/activities` | activity.add_channel | creates `source=manual` (the ADDED badge) |
| `PATCH /programs/{id}/activities/{aid}` | activity.edit | status, dates, utm, creative_proof_url, tracker_ref, text fields; `If-Match` |
| `POST /programs/{id}/activities/{aid}/approve` | activity.approve | records approver and time; `201`-style idempotent |
| `DELETE /programs/{id}/activities/{aid}/approve` | activity.approve | withdraws; on a live activity it becomes a breach (BR-08) and notifies Slack |
| `POST /programs/{id}/activities/{aid}/go-live` | activity.edit | `{go_live_at}`; refuses with `activity_live_requires_approval`, `activity_requires_utm` |
| `POST /programs/{id}/activities/{aid}/nudge` | activity.edit | manual "Nudge Priya S." to the CSM; rate limited (1 per activity per hour) |
| `GET/PUT /programs/{id}/activities/{aid}/metrics` | metrics.enter | per day views, clicks, sent, opens; CTR computed in the response |
| `POST /programs/{id}/plan/reread` | integrations.link | re-extracts POA; reports `{added, removed, edits_kept}` (BR-06) |
| `GET /programs/{id}/activities/export.csv` | program.view | the bulk export |

### 5.4 Registrations and sources
| Method + path | Permission | Notes |
|---|---|---|
| `GET /programs/{id}/registrations` | existing | adds `relevant_total`, `relevant_pct_of_raw`, pacing (days left, required per day, projected finish) |
| `GET/POST /programs/{id}/relevant-registrations` | relevant.enter (POST) | `{date, count, criteria?, note?}`; list returns current rows and log |
| `POST /programs/{id}/relevant-registrations/{rid}/supersede` | relevant.enter | correction |
| `GET /programs/{id}/sources` | program.view | latest snapshot: rows, share %, organic split, activity matches, `fetched_at`, `stale: bool` |
| `POST /programs/{id}/sources/refresh` | integrations.link | `202`; runs query 6170 in the background |
| `GET /programs/{id}/lift` | program.view | per activity before/after go-live registrations; labelled `kind: "lift"` |
| `PUT /programs/{id}/registrations/config` | registrations.manage | existing; adds target, campaign dates |

### 5.5 Rounds
| Method + path | Permission |
|---|---|
| `GET /programs/{id}/rounds` | program.view (returns rounds with latest counts and funnel steps) |
| `POST /programs/{id}/rounds`, `PATCH .../{rid}`, `DELETE .../{rid}`, `POST .../reorder` | rounds.edit |
| `GET /programs/{id}/rounds/{rid}/counts` | program.view (history) |
| `POST /programs/{id}/rounds/{rid}/counts` | counts.enter |
| `GET /programs/{id}/rounds/suggested` | rounds.edit (rounds read from the SOW) |

### 5.6 Requests, updates, comments
| Method + path | Permission |
|---|---|
| `GET /request-types`; `POST`, `PATCH /request-types/{id}` | request_types.edit |
| `GET /programs/{id}/requests`; `POST` | request.create |
| `PATCH /programs/{id}/requests/{rid}` | request.manage (status, owner, due, resolution) |
| `PUT /programs/{id}/requests/{rid}/items/{iid}` | request.manage (confirm with detail) |
| `GET /programs/{id}/updates?kind=&before=` | program.view |
| `POST /programs/{id}/updates` | update.post (kind=update: `{health, summary, blockers}`) |
| `POST /programs/{id}/comments` | comment.add |

Updates and comments are append-only. Editing is not supported; a correction is a new entry.

### 5.7 Queues
`GET /queues/csm?scope=mine|all&kind=&sort=urgency` and `GET /queues/marketing?program=`. Item shape (shared):
```json
{
  "id": "approval:123:W1-ACT-04",
  "kind": "approval_waiting",
  "severity": "critical | amber | info",
  "ticket_id": "...", "program_name": "...", "client": "...",
  "title": "Email batch 2 - Teaser ramp",
  "detail": "Marketing lead submitted 3h ago ...",
  "waiting_since": "2026-10-19T07:42:00Z",
  "due_at": null,
  "owner": {"id": 7, "name": "Arjun M."},
  "actions": ["review_approve", "view_proof"],
  "ref": {"activity_id": 88}
}
```
CSM kinds: `control_breach`, `approval_waiting`, `request_due`, `counts_missing`, `update_due`, `slack_unlinked`. Marketing kinds: `ready_to_go_live`, `go_live_due`, `missing_utm_or_proof`, `awaiting_approval`, `results_to_record`. Responses include the tile counts shown in the Stitch screens (`counts: {kind: n}`) and the "CSM SLA" figures computed from real data (average approval response time, approvals this week).

---

## 6. Business rules as code

| Rule | Where enforced | Error code |
|---|---|---|
| BR-01 invite-only sign-in | OAuth callback | redirect `not_invited` |
| BR-02 single-use, expiring, email-bound link | invite service + unique token hash | `invite_invalid`, `invite_expired`, `invite_email_mismatch` |
| BR-03 role changes by super admin only; last super admin protected; no self change | service + DB trigger | `permission_denied`, `last_super_admin`, `cannot_change_self` |
| BR-04 no Live without approval | service **and** DB trigger | `activity_live_requires_approval` |
| BR-04b Live requires a UTM (screens: "Cannot publish without verified UTM") | service | `activity_requires_utm` (**needs your confirmation**, section 10) |
| BR-05 approval is CSM only and records who | permission + columns | `permission_denied` |
| BR-06 re-read never overwrites human edits | POA merge by `poa_key` | n/a |
| BR-07 added channels flagged | `source='manual'` | n/a |
| BR-08 withdrawing approval on live creates a breach and alerts | service + outbox | n/a |
| BR-09 counts append-only; cleared <= attempted <= invited | DB checks + supersede | `counts_inconsistent` |
| BR-10 relevant never mixed into Redash totals | separate table and field names | n/a |
| BR-11 lift labelled; organic/unmatched separate | response shape | n/a |
| BR-12 request ready only when required items confirmed; items snapshotted | service + trigger | `request_items_incomplete` |
| BR-13 HubSpot wins on write-back conflict | writer | `hubspot_conflict` (409, carries current value) |
| BR-14 audit and updates immutable | DB trigger, no update/delete routes | n/a |
| BR-15 integration failure never loses a save | outbox, 202 patterns, try/log | n/a |
| BR-16 nothing deleted automatically | no purge job; retention only a setting | n/a |

Canonical UTM format (Stitch marketing queue: `he_mark/<program>_<channel>`): validated as a **warning** (`utm_format_warning`) not a refusal, because real Redash rows include values such as `sp_auto_dm/` and `he_mark/channel3`.

---

## 7. Integrations and jobs

All jobs run in the existing APScheduler (single process). Each takes a Postgres advisory lock so a second worker can't double-run it.

| Job | Schedule | Behaviour |
|---|---|---|
| HubSpot sync | every 10 min (exists) | also upserts POA activities after document extraction (merge by `poa_key`, never overwrite human columns) |
| Redash registrations | every 6 h (exists) | unchanged |
| Channel snapshots | daily 03:00 plus on demand | per linked program run query 6170 with `max_age`; store `channel_snapshots`; mark `status=failed` with error, keep last good |
| Reminder scan | every 5 min | inside configured working hours and time zone, find: approval pending > 4h, go-live due within 2h, no update by reminder time, round ended without counts, request due today/overdue, program without Slack channel; enqueue one outbox row per `dedupe_key` (e.g. `approval:{aid}:{yyyymmdd}`) |
| Outbox sender | every minute | send queued rows with retry (3 attempts, backoff), mark sent or failed, skip programs without a channel and record `skipped` |
| Stale invite | none | expiry computed at read |

**Slack outbox** (screen: "Slack Outbox (BR-15)", "Sent / Payload #9841"): every message goes through `slack_outbox`. The existing registration summary should move to it so there is one delivery path and one log. `GET /system/outbox?program=` returns recent rows for the CSM panel.

**HubSpot write-back** (`hubspot_client/writer.py`, behind `HUBSPOT_WRITEBACK_ENABLED`): client sends `{property, value, expected_old}`. Server reads the ticket's current value from HubSpot; if it differs from `expected_old` return `409 hubspot_conflict` with the current value; otherwise PATCH the ticket, then update the local row and write the audit event. Needs ticket-update scope on the token (dependency D-1).

**Redash 6170 attribution** (`core/channel_sync.py`): rows are `Source/Medium, Campaign, NumUsers...`. Classify: `Organic_But_RegisteredBefore` and `Organic` are organic buckets; rows whose Source/Medium or Campaign contains an activity's `utm` (case-insensitive) attach to that activity; blank source/medium with a `Referrer-*` campaign are referrals; anything else is "unmatched". Output keeps the source's `Total` row for reconciliation. Lift (`/lift`) compares the mean daily registrations of the 3 days before and after `go_live_at` using existing daily counts.

---

## 8. Migration plan (database-migrations skill)

Rules applied: every change is an Alembic migration; schema and data in separate revisions; expand-contract for the role column; indexes created concurrently where the table already has rows; the immutability triggers ship in their own revision; each revision has a downgrade except the trigger/data ones, which are marked irreversible.

| # | Revision | Type | Content |
|---|---|---|---|
| 1 | `access_tables` | schema | `user_roles`, `user_permission_overrides`, `invites` (+ partial unique index) |
| 2 | `backfill_user_roles` | data | copy `user.role` into `user_roles` (manager and csm to `csm`; account_manager and other to `account_manager`). Existing editors keep access |
| 3 | `audit_events` | schema | `program_events` + indexes |
| 4 | `audit_immutability` | schema | append-only trigger on `program_events` |
| 5 | `notes_attribution` | schema | `program_notes` add `kind`, `health`, `blockers`, `author_id` (nullable) |
| 6 | `activities` | schema | `program_activities`, `activity_metrics`, `program_assignments` |
| 7 | `activity_live_trigger` | schema | BR-04 transition trigger |
| 8 | `channel_snapshots` | schema | table + index |
| 9 | `relevant_and_targets` | schema | `relevant_registrations`; settings columns |
| 10 | `rounds` | schema | `program_rounds`, `round_counts` with checks |
| 11 | `requests` | schema | request tables |
| 12 | `seed_request_type_content` | data | `content_to_marketing` with four items |
| 13 | `outbox_and_settings` | schema | `slack_outbox`, `settings` |
| 14 | `drop_user_role_column` | schema | **contract step**, shipped one release after the frontend stops reading `user.role` |

After each: `alembic check` must show no drift; run `upgrade` and `downgrade` once on a copy of the dev database.

---

## 9. Testing

Harness (`tests/conftest.py`): pytest, pytest-asyncio, httpx `AsyncClient(ASGITransport)`. Real Postgres: a `ProgramOps_test` database on the existing `database` container, created once, `alembic upgrade head` per session, transaction-rollback per test. No SQLite (ARRAY, JSONB and triggers). Fixtures: `make_user(roles=...)`, `login_as(user)`, `make_program()`, `make_activity()`. External calls (HubSpot, Redash, Slack) are replaced with fakes.

Required tests (each maps to a rule):
- **Access:** uninvited Google email refused; invite email mismatch refused; token works once; expired refused; revoked refused; accept grants roles; last super admin cannot be removed or demoted; user cannot change own role; permission override adds and removes a capability.
- **Authorization matrix:** for every route, a table-driven test that each role gets 200/201 or 403 as in section 3.2.
- **Marketing:** cannot go Live without approval (API and a direct SQL update both fail); only CSM can approve; marketing cannot; withdrawing approval on a live activity yields a breach and an outbox row; extra channel marked `manual`; POA re-read keeps human edits and reports counts; UTM required for Live.
- **Audit:** every mutating route writes one event with the actor; UPDATE and DELETE on `program_events` fail.
- **Registrations:** relevant is never added into the Redash total; supersede keeps history and totals correct; sources response separates organic and unmatched and the rows sum to `Total`; lift labelled.
- **Rounds:** any number of rounds; counts consistency checks; correction via supersede.
- **Requests:** snapshot of items at creation; editing a type does not change an existing request; cannot be `ready` with a required item unconfirmed.
- **Updates:** author is the signed-in user (body author is ignored); no edit or delete routes.
- **Reminders and outbox:** dedupe key prevents duplicate rows; outside working hours nothing is queued; missing channel yields `skipped`; failed send retries then marks `failed`.
- **HubSpot write-back:** matching expected value writes; mismatch returns 409 with the current value and writes nothing.
- **Existing:** keep `test_etl.py` passing; it already guards the sync.

CI gate (`ecc:quality-gate` style): `python -m tests.test_etl`, `pytest`, `alembic check`, `npx tsc --noEmit`.

---

## 10. Reference screens: how they map, and where they differ

### 10.1 Screen to API

| Stitch screen | Endpoints it needs |
|---|---|
| Programs directory | `GET /programs`, `/programs/portfolio`, `/search`, `/system/status`, CSV export |
| Program overview | `GET /programs/{id}`, `/documents`, `/updates`, `/requests`, checklists from `programs`, `/activities/summary`, `/registrations`, `/rounds` |
| Marketing plan (and drawer) | `/activities` (+ summary), `PATCH`, `approve`, `go-live`, `nudge`, `metrics`, `plan/reread`, export, activity audit via `/admin/audit?entity=activity&id=` |
| Registrations and funnel | `/registrations`, `/relevant-registrations`, `/sources`, `/sources/refresh`, `/lift`, Redash sync endpoints (exist) |
| CSM queue | `/queues/csm`, `POST /updates`, `approve`, round counts, request checklist, `PUT /slack` (exists), `/system/outbox` |
| Marketing queue | `/queues/marketing`, `go-live`, `PATCH` (UTM, proof), `nudge`, `metrics`, `POST /activities` |
| Admin users and permissions | `/admin/users`, `/admin/invites`, `/admin/users/{id}/permissions`, `/admin/audit`, `/me` |

### 10.2 Differences that need your decision

| # | Reference shows | Approved proposal says | Recommendation |
|---|---|---|---|
| 1 | "Request Revisions" next to "Approve Activity" | Approval is approved or not yet (no changes-requested) | Keep the decision. Remove the button, or make it "Not yet" with a required comment |
| 2 | "Cannot publish without verified UTM" blocks Live | Only approval blocks Live | Make UTM required for Live (BR-04b) |
| 3 | Daily update "synced to HubSpot deal properties and broadcast to the client Slack channel" | Daily update stays in the portal; Slack carries reminders only | Post to the program's Slack channel (one outbox row) and add a HubSpot note only when write-back is on. Confirm that the program channel is internal, not shared with the client |
| 4 | Dual-role user (Super Admin + CSM) | Open item 5 | Support multiple roles (done in this design) |
| 5 | Stages: Feasibility, Planning, Pre-launch, Live, Evaluation, Closed | HubSpot stages: New, Pre Sales, Onboarding, Ongoing, Post Campaign, Closed | Show HubSpot's real names; or agree a label mapping, since the stage ids come from HubSpot |
| 6 | Program UID like `HC26-PRG-0089` and tier `P1 Enterprise` | We have the HubSpot ticket id; no tier field | Use the ticket id as the UID. Drop tier unless a HubSpot field exists |
| 7 | "Pause Live Submissions" toggle, Submissions & Judges tab, "Round 1 sandbox test 100% pass", "SLA health 99.8%", cluster and operational-SLA header | Not in scope and no data source | Do not build or render. The screens are labelled demo data; real values must never be mocked |
| 8 | "Share Client Portal Link", "Upload File" deliverables, "New Program" button | Client link out of R1; programs come from HubSpot | Hide in R1. "New Program" should link to the intake form, not create locally |
| 9 | Admin sections: Roles and Policies, Service Credentials, SLA Automation | Only users, invites, permissions, audit, settings | Build users, audit and settings now. Roles and Policies can be a read-only view of section 3.2. Skip the other two |
| 10 | "View as {user}" role switcher | Not in the proposal | Frontend-only preview using `GET /admin/users/{id}/permissions` (super admin only). Writes always use the real session. Needs your OK |
| 11 | Rule numbers (BR-04, BR-08, BR-10, BR-11, BR-14, BR-15) differ in meaning from the proposal | Proposal BR-01 to BR-16 | Reconcile numbering in one pass. The API returns stable string codes, so the UI doesn't depend on numbers |
| 12 | Go-live has a time ("18:00 IST cutoff") | Date only | Store `go_live_at` timestamptz (done here) |
| 13 | Relevant log has "criteria / tier filter" and "audit note" | Count per day | Added optional `criteria` and `note` columns (done here) |
| 14 | Weekly AI brief on each program page | Brief is portfolio-level today | Add a per-program brief later; not R1 |
| 15 | Overview shows SOW fee in USD; portal elsewhere uses rupees | n/a | Display the fee in the currency the SOW states; no conversion |

---

## 11. Build order (concrete tasks)

Each step ends with its tests passing and a changelog line in `docs/PROJECT_LOG.md`.

### Step 0: housekeeping (about half a day)
- Make docs trackable (remove `docs/` from `.gitignore`, or force-add), commit docs, create branch `feat/access-and-audit`.
- Add `ALLOWED_EMAIL_DOMAIN` stopgap in `UserManager.oauth_callback`.
- Test harness and `ProgramOps_test` database (section 9).

### Step 1: access and accountability
- Migrations 1 to 5. `core/permissions.py`, `core/audit.py`, `core/errors.py`, `core/invites.py`.
- Replace `require_editor` everywhere with `require_permission(...)`; keep behaviour identical for existing routes (CSM and old managers keep edit rights).
- `me_routes`, `admin_routes`, invite acceptance in OAuth, `SUPER_ADMIN_EMAILS` bootstrap.
- Notes: author from the session; write audit events from existing write routes.
- **Done when:** access tests and the authorization matrix pass; Sai can invite a CSM by link and that person gets only that role.

### Step 2: marketing tracker
- Migrations 6 and 7. `core/activities.py`, `activity_routes.py`, POA seeding after extraction in `hubspot_client/documents.py`.
- `/queues/marketing`, `/programs/portfolio` (marketing counts), `program_assignments`.
- **Done when:** rule tests for BR-04/05/06/07/08 pass, including the direct-SQL bypass attempt.

### Step 3: registrations by source
- Migrations 8 and 9. `core/channel_sync.py`, `/sources`, `/lift`, `relevant-registrations`, config target and dates.
- **Done when:** a HackCellence snapshot reconciles to 44,148 and the page separates organic and unmatched.

### Step 4: rounds, requests and the CSM workspace
- Migrations 10 to 12. Rounds, counts, request types and requests with checklists, updates and comments, `/queues/csm`, `core/health.py`.
- **Done when:** a program with three rounds and a content-to-marketing request works end to end.

### Step 5: reminders, outbox and settings
- Migration 13. `slack_outbox`, `reminders.py`, `settings`, move registration summaries onto the outbox.
- **Done when:** reminders respect working hours and time zone and never duplicate.

### Step 6: views and CTR
- `activity_metrics` endpoints and the marketing "results to record" queue (table exists from step 2).

### Step 7: HubSpot write-back
- `hubspot_client/writer.py` behind a flag. Needs dependency D-1.

### Step 8: contract and tidy
- Migration 14 (drop `user.role`), remove `backend/storage/`, prune unused UI kit components, fix `package-lock.json`.

---

## 12. Open items for this design
1. Decisions 1 to 3, 5, 6, 9 and 10 in section 10.2.
2. **Settled (2026-10-19):** invite lifetime is 3 days; reminder defaults (approval pending > 4 h, go-live reminder 2 h ahead) are accepted; Sai Revanth (`sai.revanth@hackerearth.com`) is the super admin; the inviter assigns roles at invite time.
3. HubSpot token ticket-update scope (D-1): the product owner will set it later. It is needed only for step 7 (write-back), which stays behind its flag until then.
4. CSM and marketing emails are not needed up front: the super admin invites each person with their role from the portal.
