# ProgramOps: Product Proposal

| | |
|---|---|
| **Status** | DRAFT for team approval |
| **Version** | 1.0, 2026-10-19 |
| **Author** | Sai Revanth |
| **Companion documents** | Requirements: `.claude/prds/programops.prd.md` · Technical design: `docs/PRODUCT_DESIGN.md` · Build history: `docs/PROJECT_LOG.md` |
| **What we are asking** | Approve the scope, roles, rules and release order in this document so build can start. Section 17 says who reviews what. |

---

## 1. Summary

**The problem.** Every hackathon and hiring challenge is a HubSpot ticket, but the work around it happens in spreadsheets and chat: client approvals, go-live dates, UTM tags, round counts, special requests, daily status. The portal today only *displays* HubSpot and Redash data. Nobody can record anything in it, so nobody is accountable inside it. The project was planned for 1 to 2 weeks and has run past two months because status, approvals and marketing impact cannot be seen in one place.

**The proposal.** Turn ProgramOps from a read-only mirror into the place where CSMs and the marketing team **do their work**:

1. **Marketing** runs each program's plan of action as a live tracker, with status, go-live, UTM and creative per channel.
2. **CSMs** are the only people who record **client approval**. An activity cannot go live without it, and the CSM's name stays on the record.
3. **Registrations are shown by source**, not just as one total, using Redash queries that already exist.
4. **CSMs run rounds and shortlisting** for any program shape, with counts and cutoffs, and handle special requests with checklists that fit each request type.
5. A **super admin controls who gets in** (invite link, Google sign-in) and can grant individual permissions.
6. **Every change carries a name and a time.**

**What we ask you to approve.** Scope (section 7), roles (section 8), business rules (section 9), release order (section 13) and the open items (section 16).

**Recommendation: go**, in the order proposed in section 13, with HubSpot write-back last and gated on one dependency (the HubSpot token scope).

---

## 2. Product diagnostic

| Question | Answer |
|---|---|
| **Who is it for?** | CSMs who own programs day to day; marketing team members who execute each program's plan; a super admin who controls access. Read-only for account managers and other internal staff. |
| **What is the pain?** | Approvals live in chat with no owner on record. Marketing keeps its own sheet of UTMs and go-live dates. Round data (attempts, cutoff clearances) is captured nowhere. Marketing impact cannot be measured: the one number everyone quotes (44,148 registrations for HackCellence) says nothing about which channel produced it. |
| **What do they do today?** | Spreadsheets, Slack threads, a separate Lovable tracker built by hand for one client (HackCellence), HubSpot for tickets only. |
| **Why now?** | The data plumbing already exists: HubSpot tickets and documents sync automatically, Redash daily registrations and per-channel breakdowns are queryable, the plan of action is already extracted from each client's PDF. What is missing is the layer where people record their work. The project has also overrun its plan by a factor of four to eight. |
| **10-star version** | One screen per role that says what needs me today. Registrations by channel with lift around each go-live, round funnels, client-ready reports, and reminders that make follow-up chasing unnecessary. |
| **MVP** | Section 7: access, marketing tracker with the approval rule, registrations by source, rounds and CSM workspace. Reminders and views and CTR follow. |
| **Anti-goals** | Replacing HubSpot. A client login. Moving feasibility intake off the Google Form. Consolidating other trackers (phase 2). The feedback analyzer. |
| **How will we know it works?** | Section 12. Headline measures: zero activities live without a named CSM approval; every live program has a CSM update each working day; registrations viewable by source for every linked program; spreadsheets retired. |

### Evidence
- **Meeting notes (Sreejith / Sai Revanth):** "Portal currently displays only dummy data"; "Round 1 assessment data ... is not captured anywhere"; "Marketing stage tracking is missing campaigns, approvals, and post-engagement metrics such as views and CTR"; "marketing and CSM views should be separate tabs"; "CSM missed image quality requirements before forwarding content to marketing, causing delays"; "Project was planned for 1-2 weeks but has run over two months".
- **Redash, run 2026-10-19 for HackCellence (query 6170):** 44,148 total (matches the figure confirmed in the meeting). 24,617 were "Organic, but registered before" and 16,655 "Organic". About 56% of the headline is not attributable to the campaign. The meeting concluded that Redash "shows only aggregate counts"; that is not correct, because queries 738 and 6170 already return source, medium and campaign.
- **Correction on "dummy data":** the portal has run on live HubSpot data since 2026-09-29. The reviewer most likely saw the original Lovable mock, not the current portal.
- **Reference tracker** (HackCellence 2026 Campaign Tracker, built by hand): 17 activities across three weeks, each with client approval, status, go-live, UTM and creative fields, a rule that nothing goes Live without approval, and a "control breaches" counter. This is the workflow marketing already wants.

---

## 3. Who uses it

| Persona | Job to be done | A day with ProgramOps | What they stop doing |
|---|---|---|---|
| **CSM** (primary, daily) | Keep every program they own on track; give clients answers; approve what goes out | Opens a queue of what needs them: updates due, approvals waiting, requests due, rounds without counts. Works the list top to bottom. | Keeping round data in personal sheets; remembering who approved what; typing the same status in three places |
| **Marketing** | Execute the plan of action channel by channel; know what is cleared to go live | Sees activities awaiting approval, fills in UTM and creative, goes live once approved, records views and clicks | Retyping the plan from the PDF; asking a CSM in chat what is approved; keeping a private UTM sheet |
| **Super admin** | Decide who can use the portal and what they can do | Invites a new CSM in under five minutes; changes a role or permission when someone moves | Adding people through the database by hand |
| **Account manager / others** | Know where a program stands | Reads program pages; adds a comment or logs a request | Pinging a CSM for status |

Not users in this release: clients, candidates, anyone outside the invited list.

---

## 4. Today and the gap

| Area | Exists today (built) | Gap |
|---|---|---|
| Program data | HubSpot tickets synced every 10 minutes: identity, owners, stage (6 stages), checklists (25 items across four stages), stage timings, audit trail, notes | Read-only |
| Documents | SOW and plan of action PDFs downloaded and extracted into structured details (fee, rounds, registration target, week-by-week activities by channel) | Extracted plan cannot be acted on |
| Registrations | Daily counts from Redash (refreshed every 6 hours) or typed in; target vs expected pace; Slack summary on save | Total only. No source split. No relevant count |
| Roles | Google sign-in; role picked by the user at first login. Only managers and CSMs can edit | **Anyone with a Google account can sign in and pick an editor role** |
| Marketing | Plan of action shown as a table | Nothing editable. No approval, UTM, status, results |
| CSM | Notes, registration entry | No rounds, requests, daily update, queue |
| Accountability | HubSpot audit trail only | Nothing records who did what inside the portal |

---

## 5. Use cases

Each use case lists the actor, the steps, the rules that apply and what must be true afterwards. Rules (BR-xx) are defined in section 9.

### UC-01 Add a person (super admin)
- **Trigger:** a CSM or marketer joins the team.
- **Steps:** open Admin, choose Invite, enter the email and a role, copy the one-time link, share it (Slack, chat). The person opens the link, signs in with Google using that same email, and lands in their workspace. The admin sees the status turn from invited to active.
- **Rules:** BR-01, BR-02.
- **Edge cases:** different email than invited, or expired or used link: access refused with the reason, admin sends a new link. Invited person never signs in: link expires, status shows expired.
- **Outcome:** the person has exactly the role they were invited with. Nobody can reach programs without an invite.

### UC-02 Change a role or grant a permission (super admin)
- **Steps:** open the user list, change the role, or switch individual permissions on or off (approve, edit request templates, write to HubSpot) for a member regardless of role.
- **Rules:** BR-03.
- **Outcome:** takes effect immediately and is recorded in the activity log with the admin's name.

### UC-03 Start a program's marketing plan (system, then marketing)
- **Trigger:** a program's plan of action PDF is uploaded in HubSpot.
- **Steps:** the sync reads the PDF; each row becomes an activity in the program's Marketing tab (week, channel, action, audience, expected outcome, hook), all "awaiting CSM approval, not started".
- **Rules:** BR-06, BR-07.
- **Outcome:** marketing opens a ready tracker instead of retyping. If the PDF is re-read later, their edits are kept.

### UC-04 Prepare an activity (marketing)
- **Steps:** open the activity, record the UTM tag, creative or copy reference, tracker or pixel link; set status to WIP.
- **Outcome:** activity appears in the CSM's approval list; missing UTM or creative shows in the marketing queue.

### UC-05 Approve an activity (CSM)
- **Steps:** the CSM reviews the activity and creative, selects Approved. Their name and time are recorded and shown on the row.
- **Rules:** BR-04, BR-05. Any CSM can approve any program. Approved or not yet only.
- **Outcome:** marketing can now set the activity to Live.

### UC-06 Go live (marketing)
- **Steps:** set status Live and enter the go-live date.
- **Rules:** BR-04. If there is no approval the system refuses and says why.
- **Outcome:** the control strip counts the activity as live.

### UC-07 Withdraw an approval after go-live (CSM)
- **Steps:** the CSM clears the approval on a live activity.
- **Rules:** BR-04, BR-08.
- **Outcome:** the activity is flagged as a **control breach** until it is taken off or re-approved. The Slack channel for the program is told.

### UC-08 Daily CSM update (CSM)
- **Steps:** per program, choose health (green, amber, red), write a short summary and blockers, save.
- **Outcome:** history kept and searchable. A program with no update by the reminder time appears in the CSM queue and triggers a Slack nudge.

### UC-09 Define rounds for a program (CSM)
- **Steps:** open Rounds, add rounds in order (assessment, project, interview, onsite finale, custom), each with dates, a cutoff or shortlisting criterion and a status. Rounds the SOW states are suggested; the CSM confirms or edits. Rounds can be renamed, reordered or removed at any time.
- **Outcome:** any program shape is supported: one assessment, three rounds plus a finale, anything else.

### UC-10 Enter round counts (CSM)
- **Steps:** after a round, enter invited, attempted, cleared the cutoff and shortlisted for that date, with an optional note.
- **Rules:** BR-09.
- **Outcome:** the funnel shows registered, then each round, with drop-off. Earlier entries stay on record. A round that ended without counts appears in the queue.

### UC-11 Enter relevant registrations (CSM)
- **Steps:** per day, enter the number of new relevant registrations. The portal adds them up and shows them beside the Redash total.
- **Rules:** BR-10.
- **Outcome:** two clearly separate numbers. Later, a scheduled automation can fill the same field.

### UC-12 See registrations by source (anyone)
- **Steps:** open Registrations, then Sources. See Redash totals split by source, medium and campaign; marketing's UTMs are matched to their activities. Organic and unmatched traffic have their own lines.
- **Rules:** BR-11.
- **Outcome:** a channel-level answer to "what worked", with each activity's registrations before and after go-live shown as lift. Lift is not claimed as proof of cause.

### UC-13 Log a special request with its checklist (CSM, marketing, account manager)
- **Steps:** choose the request type (extension, reopen, eligibility exception, custom report, content for marketing, or a type the team has added). The type's checklist appears: each item has a short instruction and a field for what exactly was confirmed. Fill in, assign an owner and due date.
- **Rules:** BR-12.
- **Example, "Content to marketing":** image quality meets spec, client approved the copy, logos and brand assets received, eligibility and dates verified. The request cannot be marked ready until all four are confirmed, and the person who confirmed each is recorded. This is the gate that would have caught the missed image-quality requirement from the meeting.
- **Outcome:** nothing reaches marketing half-ready; any request type can be handled the same way.

### UC-14 Create or edit a request type (CSM or super admin)
- **Steps:** name the type, add checklist items with instructions, mark which are required. Takes effect for new requests; existing requests keep the checklist they were created with.
- **Outcome:** the team adapts without a release.

### UC-15 Comment, update or request (CSM, marketing, account manager)
- **Steps:** on any program, add a comment, post an update or log a request.
- **Outcome:** each item shows who wrote it and when. These roles cannot change approvals, counts or tracking data they don't own.

### UC-16 Change stage or checklist in HubSpot from the portal (CSM)
- **Steps:** tick a checklist item or move the stage.
- **Rules:** BR-13.
- **Edge case:** if HubSpot changed the same field after the CSM opened the page, nothing is overwritten. The portal shows the HubSpot value and asks the CSM to retry.
- **Outcome:** HubSpot stays the source of truth for ticket state.

### UC-17 Reminders (system)
- **Trigger:** approval pending, go-live due, no daily update, round ended without counts, request overdue.
- **Steps:** a message is posted in the program's linked Slack channel at the times set by the super admin.
- **Edge case:** a program with no Slack channel gets no reminder and shows in the CSM queue as "no channel linked".
- **Outcome:** chasing becomes automatic.

### UC-18 Settings (super admin)
- **Steps:** set daily reminder time, working hours, time zone, and the history retention period. Retention is permanent until changed.
- **Outcome:** reminders stay off until times are set. Nothing is deleted automatically in release 1.

---

## 6. Proposed solution

### 6.1 Product shape
One record per program, a working view per role, one admin area.

```
Programs (everyone) | CSM queue (CSM) | Marketing queue (Marketing) | Admin (super admin)

Program page tabs
Overview | Marketing | Registrations | Rounds | Requests & updates | Documents | Activity log
```

### 6.2 Screens at a glance

**Marketing tab**
```
HackCellence 2026: The Embark Edition                          Week: [All] [1] [2] [3]  [Approval pending only]
-----------------------------------------------------------------------------------------------------------
Channels live 3/17 | Client approved 3/17 | Awaiting approval 14 | Control breaches 0
-----------------------------------------------------------------------------------------------------------
WEEK 1 · 6 activities
 Onsite banner (Spotlight)   Approved: Priya S., 14 Oct 17:42   Status [Live]  Go-live 06 Oct   UTM he_mark/channel3
 Email batch 1 - Launch      Approved: Priya S., 14 Oct 17:44   Status [Live]  Go-live 07 Oct   UTM /email
 LinkedIn / Instagram / X    Awaiting CSM approval              Status [Not started]  (cannot go Live)
 ...                                                                              [ + Add channel ]
```

**CSM queue**
```
Needs you today (7)
 [ ] Update due        HackCellence 2026      last update 2 days ago
 [ ] Approval waiting  GoDaddy Challenge      Email batch 2 (marketing asked 3 h ago)
 [ ] Counts missing    HackCellence 2026      Round 1 ended 18 Oct
 [ ] Request due       Booking Holdings       Eligibility exception  due today
 [ ] No Slack channel  XYZ Hackathon          reminders can't be sent
```

**Rounds tab**
```
Registered 44,148  ->  Round 1 (assessment, cutoff 60%)  ->  Round 2 (project)  ->  Finale (onsite)
                       invited 9,800  attempted 7,100        shortlisted 400         finalists 40
                       cleared 1,350  (19%)                  
 Entries: 18 Oct, Priya S. ... history kept        [ + Add round ]  [ Enter counts ]
```

**Admin: users**
```
Email                 Role        Status   Last active   Permissions
sai.revanth@...       Super admin active   today         all
a.csm@...             CSM         invited  link expires in 6 days   [ Copy link ] [ Revoke ]
b.marketing@...       Marketing   active   yesterday     + edit request templates   [ Edit ]
                                                          [ + Invite person ]
```

(Layouts are indicative. Visual design is done at build time.)

### 6.3 Who owns which data

| Data | Owner | Treatment |
|---|---|---|
| Program identity, owners, stage, checklists, SOW and plan of action | HubSpot | Read automatically. Stage and checklist can be changed by CSMs and written back (BR-13) |
| Daily registrations | Redash | Automatic. Never typed over |
| Registrations by source | Redash (6170) | Stored as a snapshot, refreshed in the background |
| Relevant registrations | CSM (portal) | Entered per day, separate from the Redash number |
| Marketing activity state, UTM, creative, views and clicks | Marketing (portal) | Entered here |
| Client approval | CSM only (portal) | Entered here with name and time |
| Rounds, counts, requests, daily updates | CSM (portal) | Entered here |
| Comments and updates | CSM, marketing, account managers (portal) | Entered here |

### 6.4 Integrations

| System | Direction | What | Notes |
|---|---|---|---|
| HubSpot | Read (every 10 min) and write for stage and checklist | Tickets, owners, history, documents | Write needs ticket-update scope on the integration token (dependency D-1) |
| Redash 6123 / 6142 | Read, 6-hourly | Daily registrations per event, active event list | Exists today |
| Redash 6170 (738 is the older version) | Read, background, daily and on demand | Source, medium, campaign counts | Slow query: never run on a page load. A snapshot shows with its age |
| Slack | Write | Registration summaries (exists), reminders, breach alerts | Needs the bot invited to each channel |
| Google | Sign-in | Identity | Invite-only from now on |

---

## 7. Scope and feature catalog

Feature IDs are stable. Quote them in feedback.

### Access and administration (everyone, super admin)
| ID | Feature | Release |
|---|---|---|
| F-01 | Invite by one-time expiring link, then Google sign-in with that email | R1 |
| F-02 | Copy-link delivery. Email invites not in R1 | R1 |
| F-03 | Invite-only access | R1 |
| F-04 | User list, role changes, revoke; grant or withdraw individual permissions | R1 |
| F-05 | Super admin role; the last one cannot be removed. Sai Revanth is the first | R1 |
| F-06 | A name and time on every approval, status change, count and edit | R1 |
| F-07 | Activity log: portal edits plus HubSpot history in one filterable timeline | R1 |
| F-08 | Slack reminders in each program's channel; times set by the super admin | R1 |
| F-09 | HubSpot write-back for stage and checklist; HubSpot wins on conflict | R1 |
| F-10 | Landing page by role | R1 |
| F-11 | Works at phone width | R1 |
| F-12 | Settings: reminder time, working hours, time zone, retention period (permanent for now) | R1 |
| F-13 | Comments, updates and requests for CSM, marketing and account managers | R1 |

### Marketing
| ID | Feature | Release |
|---|---|---|
| F-20 | Plan of action becomes an editable tracker grouped by week; edits survive a re-read | R1 |
| F-21 | Per activity: status, go-live, comes-off, UTM, creative reference, tracker link | R1 |
| F-22 | Approval shown with the CSM's name and time; marketing cannot set it | R1 |
| F-23 | Go-live rule: no Live without approval; withdrawal on a live activity is flagged | R1 |
| F-24 | Control strip with week and approval-pending filters | R1 |
| F-25 | Add extra channels | R1 |
| F-26 | Views and clicks per activity per day, CTR calculated; typed by marketing | R1 |
| F-27 | Registrations by source, UTM matched to activities, organic and unmatched shown separately | R1 |
| F-28 | Registrations before and after go-live, labelled lift | R1 |
| F-29 | Relevant registrations per day, entered by the CSM for now; automation later | R1 |
| F-30 | Marketing queue across programs | R1 |
| F-31 | Reminders for go-live and for missing UTM or creative | R1 |

### CSM
| ID | Feature | Release |
|---|---|---|
| F-40 | CSM queue | R1 |
| F-41 | Daily update with health, summary, blockers; history kept | R1 |
| F-42 | Approve or withdraw approval, optional note or proof link | R1 |
| F-43 | Rounds of any shape with dates and cutoff or shortlisting criteria | R1 |
| F-44 | Round counts: invited, attempted, cleared, shortlisted; history kept | R1 |
| F-45 | Funnel from registered through each round | R1 |
| F-46 | Special requests with configurable types, owner, due date, status, resolution | R1 |
| F-47 | Registrations tab: pace against target, estimated vs actual dates, manual entry | R1 |
| F-48 | Stage and checklist control, written to HubSpot | R1 |
| F-49 | Dynamic request checklists; first template "Content to marketing" | R1 |
| F-50 | Slack summaries and reminders | R1 |

### Whole application
| ID | Feature | Release |
|---|---|---|
| F-60 | Programs dashboard: funnel, active programs, pipeline value, blocked count, campaign mix | R1 (exists, extended) |
| F-61 | Program overview with owners, stage progress, checklist, health | R1 (exists, extended) |
| F-62 | SOW and plan of action documents | Exists |
| F-63 | Weekly AI brief | Exists |
| F-64 | Data freshness shown, manual refresh | R1 |
| F-65 | Estimates labelled as estimates | Exists |
| F-66 | One design language across both workspaces | R1 |

### Out of scope for release 1
- Client login or read-only client link.
- Emailed invites and email reminders.
- Automatic pull of views and CTR from marketing tools.
- Automatic filling of relevant registrations (planned after R1).
- Moving feasibility intake off the Google Form (decided: it stays).
- Consolidating other trackers (phase 2, after this tracker is complete).
- The feedback analyzer (needs rework first, separate project).
- Roles beyond super admin, CSM, marketing and viewer.

---

## 8. Roles and permissions

Roles give defaults. The super admin can grant or withdraw an individual permission for any member.

| Action | Super admin | CSM | Marketing | Account mgr / others |
|---|---|---|---|---|
| View all programs and the activity log | yes | yes | yes | yes |
| Invite and remove users, set roles, grant permissions | **yes** | no | no | no |
| Set reminder time, working hours, time zone, retention | **yes** | no | no | no |
| Approve or withdraw client approval | no | **yes** | no | no |
| Edit marketing activities (status, go-live, UTM, creative, results) | no | yes | yes | no |
| Add an extra channel | no | yes | yes | no |
| Enter relevant registrations | no | **yes** | no | no |
| Manual registrations, target, campaign dates | no | yes | no | no |
| Rounds, counts, daily updates | no | yes | no | no |
| Create and edit request types and checklist templates | yes | yes | no | no |
| Log a request, add a comment or update | no | yes | yes | yes (add only) |
| Change stage or checklist (writes to HubSpot) | no | yes | no | no |
| Link a Redash event or Slack channel, trigger a sync | no | yes | no | no |

Note: "no" for the super admin on CSM actions means they hold the role for administration, not program work. A super admin who also works programs can be given the CSM role as well.

---

## 9. Business rules

| ID | Rule |
|---|---|
| BR-01 | Only invited emails can sign in. An unknown Google account sees no programs. |
| BR-02 | An invite link works once, expires, and only grants access to the email it was issued for. |
| BR-03 | Only a super admin changes roles or grants permissions. Nobody picks their own role. The last super admin cannot be removed. |
| BR-04 | An activity cannot be Live without a CSM approval. This is enforced by the system, not by convention. |
| BR-05 | Client approval is set only by a CSM and always shows which CSM and when. It has two states: approved, or not yet. |
| BR-06 | Re-reading the plan of action never deletes or overwrites a human edit. |
| BR-07 | Activities added by marketing beyond the plan are marked as added, not planned. |
| BR-08 | Withdrawing approval on a live activity creates a control breach, visible until resolved. The count must be zero. |
| BR-09 | Round counts are entered by CSMs only. Corrections add a new entry; earlier entries are kept. |
| BR-10 | Relevant registrations are a separate number from Redash and are never added into the Redash total. Each entry records who made it and whether it was typed or automatic. |
| BR-11 | Anything inferred (lift, estimated dates) is labelled and never shown as a stated fact. Organic and unmatched traffic are always shown separately. |
| BR-12 | A request cannot be marked ready until every required checklist item is confirmed. Each item records who confirmed it. Changing a request type does not change requests already created. |
| BR-13 | HubSpot wins on conflict. If the field changed in HubSpot after the user opened the page, the portal shows the HubSpot value and asks the user to retry. |
| BR-14 | Every portal edit records who and when. Users cannot edit or delete that history. |
| BR-15 | A failure in Slack, Redash or HubSpot never loses what a user saved. The user is told what did not go out. |
| BR-16 | Nothing is deleted automatically. A retention period can be set later by the super admin. |

---

## 10. Data (in plain terms)

New information the portal will hold, all tied to a program and all with a recorded person and time:

- **Users:** email, role, status, extra permissions, invite link state.
- **Marketing activities:** week, channel, action, audience, outcome, hook, source (plan or added), approval (who, when), status, go-live, comes-off, UTM, creative reference, tracker link.
- **Views and clicks:** per activity, per day.
- **Channel snapshots:** the latest source, medium and campaign counts per program, with when they were fetched.
- **Rounds:** name, kind, dates, cutoff text and value, status, order.
- **Round counts:** per round and date: invited, attempted, cleared, shortlisted, note, who entered it.
- **Requests and checklists:** type, details, owner, due date, status, resolution; each checklist item with its confirmation and who confirmed.
- **Request types and templates:** name and checklist items.
- **Relevant registrations:** per day, who entered, typed or automatic.
- **Comments and updates:** text, health for daily updates, author.
- **Activity log:** one line per change: what, old value, new value, who, when.
- **Settings:** reminder time, working hours, time zone, retention period.

The technical model and sequence are in `docs/PRODUCT_DESIGN.md`.

---

## 11. Quality requirements

- **Accountability:** no edit without a recorded person and time.
- **Security:** invite-only, one-time expiring links, role and permission changes only by a super admin, role never self-selected.
- **Reliability:** a failing integration never loses saved work.
- **Speed:** slow Redash queries never block a page; the last good snapshot is shown with its age.
- **Accessibility:** keyboard-usable, readable contrast, status never shown by colour alone.
- **Phone:** queues and marketing rows work at phone width.
- **Auditability:** history is kept permanently until a retention period is set.

---

## 12. Success measures

Targets marked proposed need sign-off. Nothing is measured today.

| Measure | Target | Confirmed by |
|---|---|---|
| Activities Live without CSM approval | 0, always | CSM lead |
| Approvals and status changes with a named person | 100% | Product owner |
| Live programs with a CSM update by end of day | 90% within 4 weeks (proposed) | CSM lead |
| Rounds with counts entered within 1 working day of ending | 90% (proposed) | CSM lead |
| Linked programs with registrations viewable by source | 100% | Marketing lead |
| Spreadsheet trackers still in use | 0 after two programs run end to end | To be named |
| Time to add a new user | under 5 minutes | Super admin |

Baseline to collect before launch: hours per week spent on status chasing by 3 CSMs and 2 marketers (not known today).

---

## 13. Priorities and release plan

### 13.1 Prioritisation
Each capability scored by impact (1-5) times confidence (1-5) divided by effort (1-5). These are the author's estimates for the team to challenge, not measurements.

| Capability | Impact | Confidence | Effort | Score |
|---|---|---|---|---|
| Access, invites, permissions, named edits | 5 | 5 | 2 | 12.5 |
| Relevant registrations (manual) | 3 | 4 | 1 | 12.0 |
| Registrations by source | 4 | 4 | 2 | 8.0 |
| Marketing tracker with approval rule | 5 | 4 | 3 | 6.7 |
| Slack reminders | 3 | 4 | 2 | 6.0 |
| Rounds and counts | 4 | 4 | 3 | 5.3 |
| CSM queue, daily update | 4 | 4 | 3 | 5.3 |
| Dynamic request checklists | 3 | 3 | 3 | 3.0 |
| Views and CTR (manual) | 2 | 3 | 2 | 3.0 |
| HubSpot write-back | 3 | 2 | 5 | 1.2 |

**Reading it:** access comes first because everything depends on it and it closes a real security gap. HubSpot write-back scores lowest (highest effort, lowest confidence because of the token dependency and conflict handling) so it goes last and is gated.

### 13.2 Release order

| Step | What people can do afterwards | Depends on |
|---|---|---|
| **1. Access and accountability** | Super admin invites by link; only invited emails get in; per-member permissions; every edit shows who | none |
| **2. Marketing tracker** | Marketing records activities; CSM approves; go-live rule enforced; control strip | 1 |
| **3. Registrations by source** | Source split, UTM matching, lift around go-live, relevant registrations per day | 2 (UTMs recorded) |
| **4. Rounds and CSM workspace** | Rounds and counts, funnel, daily updates, requests, CSM queue, comments | 1 |
| **5. Reminders** | Slack nudges in program channels; settings screen | 2, 4 |
| **6. Views and CTR** | Marketing types views and clicks; CTR and trends | 2 |
| **7. HubSpot write-back** | CSMs change stage and checklist from the portal | D-1 (token scope) |
| **Request checklists** | Ships with step 4 | 4 |

Steps 1 and 2 give CSMs and marketing a usable tool before the larger items land. Dates are set after approval, when the work is broken into plans.

**Change from the earlier plan:** the first PRD paired reminders and write-back in one milestone. This proposal splits them: reminders are cheap and high value, write-back is expensive and dependent. Please confirm.

---

## 14. Risks and dependencies

### Dependencies
| ID | Dependency | Owner | Needed by |
|---|---|---|---|
| D-1 | HubSpot integration token with ticket-update scope | HubSpot admin | Step 7 |
| D-2 | Slack bot invited to each program channel; channel linked per program | CSM | Step 5 |
| D-3 | Redash API key with access to queries 6123, 6142 and 6170 | Data team | Step 3 (key exists today) |
| D-4 | Marketing records UTMs on every activity | Marketing | Step 3 |

### Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Scope is large for one release | High | High | Ordered steps; 1 and 2 usable alone; write-back last and gated |
| Low adoption, teams keep spreadsheets | Medium | High | The CSM queue is the home page; measure spreadsheets retired |
| UTMs not recorded, source split can't be matched to activities | High | High | UTM is a prompted field and a queue item when missing |
| Organic traffic (about 56% on HackCellence) makes marketing look ineffective | Medium | Medium | Organic always shown separately from campaign sources |
| Write-back conflicts with HubSpot edits | Medium | High | HubSpot wins; user is shown the HubSpot value and retries |
| A program has no Slack channel and gets no reminders | Medium | Medium | Queue lists programs without a channel |
| Views and CTR are typed in and skipped | High | Medium | Reminder plus a queue item; automate later |
| Today's open role selection gives anyone editing rights until step 1 ships | High (now) | High | Step 1 is first; meanwhile restrict sign-in by domain as a stopgap if needed |

---

## 15. Decisions made (2026-10-19, product owner)

| Topic | Decision |
|---|---|
| First user and super admin | Sai Revanth is the only super admin at the start and invites everyone else |
| Invites | Super admin invites by link, then Google sign-in. Copy-link only, no email in R1 |
| Reminders | Slack only, in each program's channel. Time, working hours, time zone set by the super admin. Off until set |
| Client approval | CSM only, with the CSM's name visible. Approved or not yet. Any CSM can approve any program |
| Relevant registrations | Separate from Redash. New relevant per day, summed. CSM enters for now, automation later |
| Views and CTR | Typed by the marketing team. Integration later |
| HubSpot write-back | In R1. HubSpot wins on conflict |
| Round data | CSM-entered only |
| Content readiness | Four items (image quality, client-approved copy, logos and brand assets, eligibility and dates) inside a dynamic checklist that any request type can use |
| Request types and templates | CSMs and super admins create and edit |
| Comments, updates, requests | CSM, marketing and account managers can add them |
| Permissions | Super admin grants per-member permissions on top of role defaults |
| Retention | Permanent for now. The period is a setting for later |
| Client link | Not in R1 |

---

## 16. Open items

| # | Item | Owner | Blocks |
|---|---|---|---|
| 1 | Confirm the HubSpot token has ticket-update scope, or have it added | HubSpot admin | Step 7 |
| 2 | Rule or query that decides a registration is "relevant", for later automation | CSM, data team | Automation only, not R1 |
| 3 | Confirm the release order change in 13.2 (reminders split from write-back) | Product owner | Planning |
| 4 | Confirm success targets marked "proposed" in section 12 | CSM lead, marketing lead | Launch review |
| 5 | Confirm whether a super admin who also works programs should hold both roles | Product owner | Step 1 |

---

## 17. Approval

### What each reviewer should check
| Reviewer | Read | Decide |
|---|---|---|
| Super admin (Sai Revanth) | Sections 5 (UC-01, 02, 14, 18), 8, 9 | Is the invite and permission model workable? |
| CSM lead | Sections 3, 5 (UC-05 to UC-17), 8, 9, 12 | Do the approval rule, rounds, requests and queue match how CSMs work? Are targets realistic? |
| Marketing lead | Sections 3, 5 (UC-03 to UC-07, UC-12), 6.2, 9, 12 | Do the per-activity fields and the go-live rule fit? Who records UTMs? |
| Leadership and account managers | Sections 1, 2, 12, 13, 14 | Is the scope and order right? Are the measures the right ones? |

### How to give feedback
Quote the ID (F-26, UC-05, BR-04, D-1) and say: **add**, **change**, **remove** or **question**. Feedback missing an ID is welcome and will be given one.

### Sign-off
| Name | Role | Decision (approve / approve with changes / reject) | Date |
|---|---|---|---|
| Sai Revanth | Product owner, super admin | | |
| | CSM lead | | |
| | Marketing lead | | |
| | Leadership | | |

**Approval means:** the scope in section 7, roles in section 8, rules in section 9 and the release order in section 13 are accepted as the basis for build. Changes after approval go through a change note in `docs/PROJECT_LOG.md`.

---

## Appendix A: Glossary

| Term | Meaning |
|---|---|
| Program | A hackathon or hiring challenge, one HubSpot ticket |
| Plan of action (POA) | The client-approved marketing plan, week by week by channel, from the SOW package |
| SOW | Statement of work: scope, rounds, target registrations, fees |
| Activity | One row of the plan of action, for example an email batch or social post |
| Control breach | An activity that is Live without a CSM approval |
| Relevant registrations | The count of registrations that matter for the program's goal, separate from the raw Redash total |
| Lift | Change in daily registrations after an activity's go-live compared with before. Not proof of cause |
| UTM | The tag on a link that identifies where a visitor came from (source, medium, campaign) |
| Round | A stage of selection in a program: assessment, project, interview, onsite finale or custom |

## Appendix B: Source material

- Meeting notes with Sreejith / Sai Revanth, with action items, decisions and open questions.
- Reference marketing tracker: he-demo-marketingxcsm-dashboard.lovable.app (HackCellence 2026 Campaign Tracker).
- Redash queries: 6123 (daily registrations), 6142 (active events), 6170 and 738 (registrations by source), checked 2026-10-19.
- `docs/PROJECT_LOG.md`: what is built today.
