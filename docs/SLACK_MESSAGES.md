# Slack messages ProgramOps sends

Generated from the real message builders (`core/registration_message.py`, `core/reminders.py`) and the literal
templates in the routes. Every message goes to the program's linked Slack channel, except a special request's own
messages, which go to the channel set on that request. Text is escaped before sending (`<!channel>` and links in a
program name or note stay plain text).

**Two ways out.** *Direct* posts happen inside the request that caused them: a Slack failure is shown or logged and
never blocks the save. *Outbox* messages are queued, sent by a worker every minute, retried up to 3 times, recorded
with their status (queued, sent, failed, skipped when no channel is linked) and de-duplicated by a key.

| # | Message | Sent when | By | Path | Limits |
|---|---|---|---|---|---|
| 1 | Registrations update | Someone saves daily counts, or clicks Fetch from Redash with new or changed days | CSM, anyone with *manage registrations* | Direct | One message per save; needs Notify Slack on and a channel |
| 2 | Auto-fetched from Redash | The scheduled daily Redash fetch (off until a super admin sets a time) | Scheduler | Outbox | Today's count only, once per program per day |
| 3 | Relevant registrations update | The CSM adds or corrects a relevant count | CSM | Direct | Needs Notify Slack on and a channel |
| 4 | Connection test | Someone clicks Send test on the channel box | CSM / integrations | Direct | On demand |
| 5 | Reminders (8 kinds) | Daily, after the reminder time set by a super admin, in working hours | Scheduler | Outbox | Once per item per day; approvals wait 4 h; nothing while reminders are off |
| 6 | Go-live due | An approved activity reaches its planned date and is not live | Scheduler | Outbox | Once per activity per day, same working-hours rules |
| 7 | Daily update | A CSM posts a daily update | CSM | Outbox | Every update, no limit |
| 8 | Nudge: one activity | Marketing clicks Remind on an activity | Marketing / CSM | Outbox | One per activity per hour |
| 9 | Nudge: all waiting | "Remind CSM" on the marketing plan | Marketing / CSM | Outbox | One per program per hour |
| 10 | Control breach | A CSM withdraws approval from a live activity | CSM | Outbox | Immediately, also outside working hours |
| 11 | Special request: raised, status change | A request with its own Slack channel is raised or its status changes | Anyone who can raise; the channel needs *integrations* | Outbox | Only for requests with a channel |

## Previews

### 1. Registrations update (one day)
```
:calendar: *07 Oct 2026* | HackCellence: The Embark Edition
Registrations update
- 844 registrations
:mega: *Marketing activity:* LinkedIn post (Social)

Total so far: *41,793*
```

### 1. Registrations update (several days, roles, relevant counts)
```
:calendar: *06 Oct 2026 - 07 Oct 2026* | HackCellence: The Embark Edition
Registrations update

*Tue, 06 Oct 2026*
- Backend: 900 registrations | 310 relevant
- Frontend: 1,019 registrations | 402 relevant
Day total: *1,919*

*Wed, 07 Oct 2026*
- Backend: 844 registrations | 290 relevant

Total so far: *41,793*
```

### 2. Auto-fetched from Redash
```
:robot_face: _Auto-fetched from Redash_
:calendar: *23 Oct 2026* | HackCellence: The Embark Edition
Registrations update
- 1,203 registrations

Total so far: *43,150*
```

### 3. Relevant registrations update
```
:calendar: *07 Oct 2026* | HackCellence: The Embark Edition
Relevant registrations update
- 310 relevant

Relevant so far: *1,240*
```

### 4. Connection test
```
:white_check_mark: ProgramOps is connected to *HackCellence: The Embark Edition*.
```

### 5. Reminders (one line each; the mark follows the severity)

`control_breach (critical)`
```
:rotating_light: *HackCellence: The Embark Edition* · A7 LinkedIn launch post: Live without a CSM approval
```

`approval_waiting`
```
:warning: *HackCellence: The Embark Edition* · A3 Email blast: Marketing is waiting for your approval
```

`request_due (overdue / due today)`
```
:rotating_light: *HackCellence: The Embark Edition* · Content to marketing: Overdue
```

`counts_missing`
```
:warning: *HackCellence: The Embark Edition* · Round 1: Coding assessment: Ended 07 Oct with no counts entered
```

`update_due`
```
:warning: *HackCellence: The Embark Edition* · Daily update: Last update 3 day(s) ago
```

`dependency_overdue`
```
:rotating_light: *HackCellence: The Embark Edition* · Brand guidelines: 5 day(s) overdue, owed by Meera J. (client AM)
```

`comm_overdue`
```
:warning: *HackCellence: The Embark Edition* · Reminder for All registrants: Planned for 22 Oct 10:00 and not marked sent
```

`change_awaiting_approval`
```
:warning: *HackCellence: The Embark Edition* · Round 2: starts on to 28 Oct: Proposed by Meera J.: Client content approval is late
```

### 6. Go-live due
```
:rocket: *HackCellence: The Embark Edition* · A3 Email blast: approved and planned for 23 Oct, ready to go live
```

### 7. Daily update
```
:memo: *HackCellence: The Embark Edition* · daily update from Priya S. [warning]
Registrations are pacing 12% under target; client content approval still pending.
Blockers: Waiting on brand assets from the client
```

### 8. Nudge: one activity
```
:bell: Priya S.: *A3 Email blast* is waiting for your approval (nudged by Ravi K.)
```

### 9. Nudge: all waiting
```
:bell: Priya S.: 3 marketing activities are waiting for your approval (nudged by Ravi K.)
```

### 10. Control breach
```
:rotating_light: *Control breach* · A7 LinkedIn launch post is live and Priya S. withdrew its approval
```

### 11. Special request (raised, then a status change)
```
New special request: Content to marketing
Due: 25 Oct 2026
Raised by Meera J.
Banner for the finale
Program: HackCellence: The Embark Edition
```
```
Special request Content to marketing is now done
Resolution: banner shipped
Program: HackCellence: The Embark Edition
```
