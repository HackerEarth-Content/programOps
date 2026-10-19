# ProgramOps: Product design (v1 proposal)

_Written 2026-10-19. Design only, nothing here is built yet. Replaces the "dashboard that mirrors HubSpot" shape with a
two-workspace operating tool. Evidence for every claim is in section 2._

**Decisions since this was written (2026-10-19, product owner):** a super admin invites CSMs / marketing by one-time link, then Google sign-in (replaces self-picked roles); client approval is **CSM-only** and shows which CSM did it; relevant registrations are a **separate number** from the Redash count, entered by CSM and marketing (definition still to be confirmed); round data is CSM-entered; release 1 also includes Slack/email reminders, views and CTR per activity, and HubSpot write-back; no client link in R1. Requirements: `.claude/prds/programops.prd.md`. Sections 3 to 9 below predate this and must be read through it.

---

## 1. Purpose and users

A program (hackathon / hiring challenge) is one HubSpot ticket. Two teams run it day to day, and the portal exists so
they stop using spreadsheets and chat threads for it:

| Role | Does | Today in the portal |
|---|---|---|
| **CSM** | Daily upkeep of every program they own, special client requests, rounds / shortlisting counts, keeps stage and checklist true | Read-only HubSpot mirror + manual registration entry + notes |
| **Marketing** | Runs the week-wise plan of action (POA): per channel, client approval, go-live, UTM, creative, results | Read-only POA table extracted from the PDF. Nothing editable |
| Account manager / others | Look, do not edit | Same as today |

**The gap:** the portal can only *display* data. Both teams need to *record* things (approvals, go-live, UTMs, round counts,
requests) and be accountable for them. That is the product.

## 2. What we have today (verified 2026-10-19)

### 2.1 From HubSpot (read-only master, synced every 10 min)
`hubspot_client/client.py` `TICKET_PROPERTIES`, stored in `programs`:

- **Identity:** `program_name` (event name), `campaign_type` (Hackathon / Coding Challenge ...), `campaign_name`, `platform_details`, `event_id`, `company_name`, `blackops_account_name`, `deal_id`, `target_audience[]`, `geography[]`.
- **People:** `account_manager`, `csm_for_the_deal`, `content_poc`, ticket owner (ids resolved to names). **There is no marketing owner field.**
- **Dates / money:** `registration_start_date`, `event_end_date`, expected deal size (SOW > description > HubSpot), created / closed.
- **Progress:** pipeline stage (New, Pre Sales, Onboarding, Ongoing, Post Campaign, Closed), four per-stage checklists (25 items) each with a free-text note, per-stage entered / exited / cumulative time, full change history (audit trail), HubSpot notes.
- **Documents:** `sow_upload`, `marketing_poa_upload` PDFs, extracted by the LLM into `details` JSONB.
  - SOW: fee, objective, rounds (free text), timeline, **registration target and window weeks**, contacts, SLAs.
  - POA: window, and per row date / week / channel (Email, Social, Community, Newsletter, Partner) / activity / objective / description.

**Not in HubSpot (so the portal must own it):** marketing execution state, client approval per activity, UTMs, round-level
counts, special requests, daily CSM status.

### 2.2 Registrations (how counts arrive)
| Path | How | Gives | Limits |
|---|---|---|---|
| **Redash 6123** (auto) | Per program: pick/confirm event slug (list from 6142), refresh every 6 h, upsert into `program_registrations` | Daily registration count per event | Total per day only. Treated as "relevant". No role split. |
| **Manual** | Registrations tab: per day (per role for Coding Challenge), CSV import | Registrations + relevant | Hand-typed |
| Slack | Summary posted on save when channel set | Visibility | - |

### 2.3 Channel attribution already exists in Redash (the meeting thought it did not)
Queries **738** ("Event Registrations From Different UTM Parameters") and **6170** ("Event Registration through Channels")
take one parameter, `Event - Title or Slug`, and return `Source/Medium, Campaign, NumUsers_with_source_as_Latest_visit_before_registration`.
6170 is the newer version of 738 (same columns). Run live for `hackcellence-the-embark-edition` on 2026-10-19:

| Bucket | Users |
|---|---|
| Organic_But_RegisteredBefore | 24,617 |
| Organic | 16,655 |
| `sp_auto_dm/` | 1,944 |
| `chatgpt.com/` | 514 |
| Referrer-Challenges | 397 |
| `he_mark/*` (channel3, channel7, ...) | ~14 |
| `/email` campaign "HackCellence: The Embark Edition" | 2 |
| **Total** | **44,148** (matches the number confirmed in the meeting) |

Consequences:
1. Source / UTM breakdown is **available today**. The blocker is not Redash, it is **mapping** UTM rows to POA activities, which needs each activity's UTM recorded (the reference app has a "UTM used" field for exactly this).
2. ~56 % of the headline total is organic / registered before the campaign. Marketing impact must be shown against that, not against 44k.
3. Both queries are **slow Athena-backed Python queries**: run them in the background, store a snapshot, never on page load.
4. "Email batch impact" cannot be attributed by source (only 2 users carry the email UTM), but it can be shown as **lift**: daily registrations vs the activity's go-live date.

### 2.4 The reference: marketing tracker (he-demo-marketingxcsm-dashboard.lovable.app)
Read from the live page, "HackCellence 2026: Campaign Tracker" (Booking Holdings). One page, fully manual, saved in the browser only:

- **Header inputs:** current registrations, target (SOW), relevant registrations, campaign start, campaign end; chart "Registrations vs target".
- **Control KPIs:** Channels live (3/17), Client approved (3/17), Awaiting approval (14, "cannot go live until approved"), **Control breaches** (live without client approval, must be 0).
- **Filters:** All / Week 1-3 / Approval pending only.
- **Per activity row** (grouped by week, 17 rows: onsite banner, email batches, social, college outreach, community, newsletter, BOFU emails ...): **Approved from client? (Yes/No)**, **Status (Not started / WIP / Live)**, go-live date, comes-off date, **UTM used**, creative/copy ref, tracker/pixel link, plus the read-only plan columns action/strategy, target audience, expected outcome, hook/positioning.
- **Extra channels** (add your own row) and an **audit log of status and approval changes**.
- **Rule:** an activity cannot be set to Live without client approval. Its footer says the CSM-owned audit log is the system of record, i.e. it needs a backend.

This is the marketing workspace. Nearly all of it maps onto data we already extract (the POA rows) plus fields to record.

## 3. Product shape

Two workspaces over one program record. Same data, different default view and different edit rights.

```
Top nav:  Programs | Marketing queue | CSM queue            [role badge] [sync]

Program page tabs:
  Overview | Marketing | Registrations | Rounds | Requests & updates | Documents | Activity log
```

| Tab | Audience | Content | Source |
|---|---|---|---|
| **Overview** | all | Identity, owners, stage progress, checklist, health, next action | HubSpot (RO) |
| **Marketing** | marketing edits, CSM approves/edits | The tracker in 2.4: KPIs, week groups, per-activity row, extra channels, rule enforced | POA seed + portal-owned |
| **Registrations** | CSM edits manual; auto from Redash | Daily chart, target vs pace, estimate, **channel breakdown** (6170), **lift per go-live** | Redash 6123 / 6170, manual |
| **Rounds** | CSM edits | Free-form rounds with cutoffs and counts; funnel registered -> R1 attempted -> cleared -> R2 ... | SOW seed + portal-owned |
| **Requests & updates** | CSM edits | Special requests (status, owner, due) and the daily update (health, summary, blockers) | portal-owned |
| **Documents** | all | SOW / POA view + extracted details (exists) | HubSpot files |
| **Activity log** | all | Every edit in the portal + HubSpot audit trail, one timeline | both |

**Marketing queue** (cross-program): activities awaiting client approval, due to go live this week, overdue / not started,
missing UTM or creative. **CSM queue:** programs with no update today, open requests past due, behind-pace registrations,
stage checklist blockers, rounds with no counts after the round ended.

### Permissions
| Action | CSM | Marketing | Acct mgr / other |
|---|---|---|---|
| Edit marketing activities (status, go-live, UTM, creative, trackers) | yes | yes | no |
| Set "client approved" | yes | **no** (see open question 3) | no |
| Add extra channel | yes | yes | no |
| Registrations / target / dates, rounds, requests, daily update | yes | no | no |
| Sync, Slack, Redash link | yes | no | no |

Enforced server-side by role dependencies, mirrored in the UI.

## 4. Data model (new, all Alembic)

HubSpot-owned data stays in `programs` and is never edited in the portal. Everything below is portal-owned.

| Table | Key columns | Notes |
|---|---|---|
| `role_assignments` | `email` PK, `role` (`csm`, `marketing`, `manager`, `viewer`) | Admin-managed allowlist. Replaces self-selected role (security finding, 2026-10-19). Unknown emails get `viewer`. |
| `program_activities` | `id`, `ticket_id`, `poa_key`, `week`, `channel`, `title`, `action`, `audience`, `outcome`, `hook`, `planned_date`, `source` (`poa`/`manual`), `client_approved` (null/true/false), `status` (`not_started`/`wip`/`live`/`off`), `go_live_date`, `comes_off_date`, `utm`, `creative_ref`, `tracker_ref`, `updated_by/at` | Seeded from POA extraction; re-seed merges by `poa_key` and never overwrites human fields. **CHECK: `status='live'` requires `client_approved = true`.** |
| `activity_metrics` | `activity_id`, `date`, `impressions`, `clicks` (CTR derived), `source` | Views / CTR. Manual first; see open question 5. |
| `channel_snapshots` | `ticket_id`, `fetched_at`, `rows` JSONB (6170 output), `total` | One per refresh; latest wins. |
| `program_rounds` | `id`, `ticket_id`, `seq`, `name`, `kind` (`assessment`/`project`/`interview`/`onsite`/`custom`), `starts_on`, `ends_on`, `cutoff_rule` (text), `cutoff_value` (numeric, nullable), `status` (`planned`/`live`/`evaluating`/`done`), `source` (`sow`/`manual`) | Dynamic: CSM adds, reorders, renames, removes rounds per program. |
| `round_counts` | `round_id`, `as_of` date, `invited`, `attempted`, `cleared`, `shortlisted`, `note`, `entered_by` | Append-only; latest per round is current; history kept. Shortlisting criteria live on the round (`cutoff_rule`). |
| `program_requests` | `id`, `ticket_id`, `kind` (`extension`, `reopen`, `eligibility_exception`, `custom_report`, `other`), `title`, `detail`, `requested_by`, `owner`, `status` (`open`/`in_progress`/`done`/`declined`), `due`, `resolution`, timestamps | CSM special requests. |
| `program_notes` + `kind` | add `kind` (`note` / `daily_update`) and `health` (`green`/`amber`/`red`) | Reuse the existing notes table; no new table for daily updates. |
| `program_events` | `id`, `ticket_id`, `entity`, `entity_id`, `field`, `old`, `new`, `actor`, `at` | Generic audit log written by every portal edit. Feeds the Activity log tab and the approval / go-live history. |
| `program_registration_settings` + | `target`, `campaign_start`, `campaign_end` (overrides of SOW / HubSpot) | Replaces the header inputs of the reference. |

## 5. Backend (FastAPI)

- `role_assignments` lookup in `core/users.py`; `require_csm`, `require_marketing_or_csm` dependencies next to `require_editor`.
- `api/activity_routes.py`: list / patch / create-extra activities; patch writes `program_events`; 409 if going live unapproved.
- `api/round_routes.py`, `api/request_routes.py`: CRUD.
- `core/channel_sync.py`: runs 6170 for linked programs in the background (daily + on demand), stores `channel_snapshots`; **attribution** matches each activity's `utm` to a row's `Source/Medium` / `Campaign` (case-insensitive contains), remaining rows show as "Unattributed" and "Organic".
- Lift per activity: mean daily registrations in the 3 days after `go_live_date` vs 3 days before (from existing `program_registrations`). Labelled "lift", not "attributed".
- POA seeding in `hubspot_client/documents.py` after extraction.
- Auto-link program to Redash event by matching `program_name` to 6142 titles (suggest, user confirms) instead of typing a slug.
- Dashboard summary endpoint (existing design in PROJECT_LOG 6b) so queues are server-side.

## 6. Frontend redesign

Keep the Ticket-Hub-style tokens and shell. Change the structure:

1. **Role-aware landing:** CSM -> CSM queue; Marketing -> Marketing queue; others -> Programs.
2. **Program page** gets the tab set in section 3 (today: SOW / Marketing schedule / Registrations).
3. **Marketing tab** = the reference, rebuilt on our components: KPI strip (Channels live, Client approved, Awaiting approval, Control breaches), week filter chips + "Approval pending only", week groups with inline-editable rows, drawer for the long text, "+ Add channel", audit log section. Edits save immediately, optimistic with error rollback.
4. **Rounds tab:** horizontal round cards (name, kind, dates, cutoff, status) with an inline "enter counts" row and a funnel bar across rounds.
5. Empty / pending states say what is missing and who owns it ("Waiting for client approval", "No UTM yet").
6. Mobile: queues and the marketing rows must work at phone width (marketing edits from a phone).

At build time run the visual pass through the `impeccable` / `taste` frontend skills and `ecc:plan` for the task breakdown; this document fixes the IA and data, not the pixels.

## 7. Rules that must hold (tests)
1. An activity cannot be `live` unless `client_approved` is true (DB CHECK + API 409 + test). Control breaches must always be 0.
2. Portal edits never write back to HubSpot, and HubSpot sync never overwrites portal-owned columns.
3. Re-seeding the POA never deletes or overwrites a human edit.
4. Estimated values are labelled estimated; actuals are never mixed with estimates.
5. Every portal edit writes a `program_events` row with the actor.
6. Slow Redash queries never run on a page request.

## 8. Phased plan
| Phase | Scope | Why this order |
|---|---|---|
| **0 Foundation** | `role_assignments` + `marketing` role, `program_events`, `program_activities` migration, edit permissions | Closes the open role self-assignment hole and everything below needs it |
| **1 Marketing tab** | Seed from POA, inline edit, approval rule, KPIs, extra channels, audit, target / start / end fields | The deliverable promised to Gauri; needs no new data source |
| **2 Channels** | `channel_sync` (6170), UTM attribution, organic split, go-live lift | Answers "which channel worked" with data we already have |
| **3 Rounds** | Rounds + counts + funnel, seeded from SOW rounds | Needed for multi-round programs |
| **4 CSM workspace** | Requests, daily update + health, CSM queue, role-aware landing | Makes the daily CSM loop real |
| **5 Marketing metrics** | `activity_metrics` (views, CTR) | Blocked on a data source |

## 9. Open questions (need an answer before the phase that depends on them)
1. **Who are the marketing users and CSMs?** Phase 0 needs an email -> role list.
2. **What is a "relevant" registration?** Today relevant = Redash count. The reference has a separate manual "Relevant registrations" input. Which is right?
3. **Who sets client approval?** The reference lets marketing toggle it. Should that be CSM-only (they hold the client relationship), or marketing records it with a link or note as proof?
4. **Round data source (phase 3):** is round-1 attempts / cutoff clearances in the HackerEarth DB or Redash (give me the query) or does the CSM type it?
5. **Marketing metrics source (phase 5):** which platforms (LinkedIn, email tool, ...) and who pulls them? Manual entry per activity until then.
6. **Extra channels per program:** are they free-text (as in the reference) or a fixed list?
7. **Do we keep editing HubSpot checklists in HubSpot** (read-only here), or should CSMs tick them in the portal and write back? Current design: read-only, no write-back.
