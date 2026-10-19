# Ticket-Hub Frontend Design Reference

As of 2026-10-16. Source of truth in this repository: `frontend/src/theme.css` (tokens), `frontend/src/App.css` (components), `DESIGN.md` (design rules) and `PRODUCT.md` (users, tone, principles).

## 1. Overview and stack

The Ticket-Hub frontend is a single-page React dashboard with no router, no UI kit and no CSS framework: every colour, size and shadow comes from CSS variables in two hand-written stylesheets. Its design north star is "The Control Room": a dense, data-first instrument panel that a support lead glances at under time pressure. Reuse this document as the baseline for new HackerEarth AI tools, and change only what section 9 marks as open.

| Layer | Choice | Version | Notes |
| --- | --- | --- | --- |
| UI library | React | 18.3 | Function components and hooks only |
| Language | TypeScript | 5.6 | `tsc -b` runs before every build; all API shapes live in `src/types.ts` |
| Bundler | Vite + `@vitejs/plugin-react` | 5.4 | `pnpm dev`, `pnpm build`, `pnpm preview` |
| Charts | Recharts | 2.13 | Area/line, donut, bar; plus hand-built SVG radial rings and CSS bar lists |
| Fonts | `@fontsource-variable/inter`, `@fontsource-variable/jetbrains-mono` | 5.x | Self-hosted through npm, no Google Fonts request |
| Styling | Plain CSS: `theme.css` (tokens) and `App.css` (components) | n/a | No Tailwind, no CSS-in-JS, no component library |
| State | `useState` plus custom hooks | n/a | No Redux, Zustand or React Query |
| Data | `fetch` wrapped in `src/api.ts` | n/a | Same-origin relative URLs, no auth headers (cookie session) |
| Serving | nginx container | n/a | Static files plus a reverse proxy to the backend |

There are only five runtime dependencies (react, react-dom, recharts and two font packages). Keep it that way unless a new project needs something these cannot do.

### Source layout

| Path | Holds |
| --- | --- |
| `src/theme.css` | Every design token, light and dark values, global reset, focus ring, hover motion |
| `src/App.css` | All component classes (header, tabs, cards, tables, chips, modals, charts) |
| `src/App.tsx` | The page shell: owns period, tab, theme and auth state; renders the active tab |
| `src/components/` | About 55 presentational components, one per card or table, named `<Thing>Card` or `<Thing>Table` |
| `src/hooks/` | `useAuth`, `useTheme`, `useDashboardData`, `useLiveStatus`, `useOnShiftNow`, `useFrontlineAgents`, `useFrontlineMetricDashboard` |
| `src/api.ts` | One typed function per backend route, plus `authApi` |
| `src/types.ts` | TypeScript types mirroring every API response (about 530 lines) |
| `src/format.ts` | Number, percent, duration, relative-time and IST helpers |
| `src/priority.ts`, `src/validity.ts` | Domain label maps (priority and P-level, ticket validity) |

### How it is served

- **Production:** nginx on port 80 serves the built files. `/dashboard/` and `/api/` are proxied to the backend at `backend:8000`. Every other path falls back to `/index.html`, so deep links never 404.
- **Development:** the Vite dev server proxies `/dashboard` and `/api` to `http://localhost:8000`. Override with `VITE_API_PROXY_TARGET`. The frontend therefore always calls relative URLs and never needs CORS.
- **Page shell:** `<html lang="en">`, favicon `/hackerearth_logo.png`, title "Helpdesk Operations - HackerEarth Support". Content is centred in a `.wrap` container, max width 1280px, padding 20px 24px 72px.

## 2. Colour system

Colour is defined once as CSS custom properties on `:root` in `theme.css`, with an explicit dark value for every token. The eight accents are taken from HackerEarth's production brand CSS, so reuse them as-is in any new HackerEarth project. Components never hard-code a hex value; they reference `var(--token)`.

### Brand accents (categorical and identity)

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `--accent-blue` | `#0939e6` | `#3987e5` | Links, focus ring, Apply button, Overview tab, first chart slot |
| `--accent-aqua` | `#1baf7a` | `#199e70` | Frontline tabs and headings, live panel, "created vs resolved" second series, time picker |
| `--accent-yellow` | `#eda100` | `#c98500` | Programs/Events, SLA, Priority headings, holiday pill |
| `--accent-green` | `#008300` | `#008300` (no dark override) | NPS heading, chart slot 4 |
| `--accent-indigo` | `#5f59ff` | `#9085e9` | Customers tab, Volume heading, avatar gradient end |
| `--accent-red` | `#e34948` | `#e66767` | Escalations heading, sign-out hover, chart slot 6 |
| `--accent-magenta` | `#e87ba4` | `#d55181` | Service Health heading, Slack Requests tab |
| `--accent-orange` | `#ff5722` | `#d95926` | Backline tab and heading |

### Categorical chart order (fixed)

Charts assign colour by array position, never by value: blue, aqua, yellow, green, indigo, red, magenta, orange. Anything past the eighth category folds into one "Other" item instead of getting a ninth hue.

### Status colours (reserved for meaning)

These are the same in light and dark mode and are never used as a chart series colour. `--accent-red` (a chart slot) and `--status-critical` look similar on purpose but must not be swapped: an SLA breach is always `--status-critical`.

| Token | Value | Meaning in the UI |
| --- | --- | --- |
| `--status-good` | `#0ca30c` | Healthy value, live-sync dot, "on time" |
| `--status-warning` | `#fab219` | Stale sync (older than 30 min), approaching a threshold |
| `--status-serious` | `#ec835a` | Elevated wait, 24 to 48 hours |
| `--status-critical` | `#d03b3b` | SLA breach, wait over 48 hours, error banner |
| `--status-neutral` | `#8a8f98` | Unassigned or unknown |

Chip text for warning and serious uses darker ink in light mode (`#8a5c00` and `#a1461f`) to keep AA contrast on the tinted background, and reverts to the status colour in dark mode.

### Ordinal ramp (single hue, for ordered data)

Use for lifecycle stage or severity order, where position matters more than identity. Light: `#cde2fb`, `#86b6ef`, `#3987e5`, `#1c5cab`, `#0d366b` (`--ord-1` to `--ord-5`). Dark mode reverses the ramp so the lightest step stays the "highest" visually.

### Surfaces, ink and lines

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--plane` | `#f7f9fc` | `#020109` | Page background beneath all cards |
| `--surface` | `#ffffff` | `#18181b` | Cards, menus, modals (cards are always this, never surface-2) |
| `--surface-2` | `#f3f5f9` | `#1f2027` | Toolbars, pills, table hover, inputs, drill-down panels |
| `--ink` | `#020202` | `#ffffff` | Primary text |
| `--ink-2` | `#545459` | `#c3c2b7` | Secondary text, inactive icon buttons |
| `--ink-3` | `#898781` | `#8a8f98` | Subtitles, labels, chart ticks (most-used neutral) |
| `--line` | `#e3e6ed` | `#2c2c33` | Every 1px border and divider |
| `--ring` | `rgba(2,2,2,.08)` | `rgba(255,255,255,.08)` | Subtle ring |

### Tab and section accents

Each tab and each section heading carries one accent, so the reader knows which zone they are in. The tab underline and the heading dot use the same colour.

| Zone | Accent |
| --- | --- |
| Overview, Overview heading | Blue |
| Volume and Distribution, Customers | Indigo |
| SLA and Resolution Priority, Programs/Events, Priority | Yellow |
| Service Health, Slack Requests (content/engg on-call) | Magenta |
| NPS | Green |
| Frontline, Frontline Quality, Team Performance, Frontline Metric Dashboard, Frontline Agents | Aqua |
| Backline Operations | Orange |
| Escalations | Red |

### Tints and mixing

Soft backgrounds are made in CSS with `color-mix(in srgb, <accent> N%, transparent | var(--surface))`, never with a second hard-coded hex. Examples in use: live panel (6% aqua over surface, 30% aqua border), status chips (14 to 18% of the status colour), shift pill (14% aqua), holiday pill (16% yellow), error banner (10% critical over surface, 30% border), hover borders (30 to 40% blue mixed into `--line`).

### Colour rules to keep

- Use `--status-*` for state and the eight accents for identity or categories, never the other way round.
- Never rely on colour alone: every chip, dot and chart legend carries a text label.
- Gradients are banned except one: the brand mark and account avatar use a blue-to-indigo gradient (`135deg`). Do not add gradients elsewhere.
- Text on aqua or blue fills is `#fff` (Apply button, active time-picker segment).

## 3. Typography, spacing, shape and motion

Two typefaces do all the work: Inter Variable for anything read as language and JetBrains Mono Variable for any number that will be compared with another number. There is no display or serif face.

### Type scale

| Style | Font | Size / weight | Other | Used for |
| --- | --- | --- | --- | --- |
| Page title (`h1`) | Inter | 21px / 650 | tracking -0.015em, `text-wrap: balance` | The one app title, once per page |
| Eyebrow | Inter | 10.5px / 600 | uppercase, tracking 0.08em, `--ink-3` | Line above the title |
| Section heading | Inter | 11px / 700 | uppercase, tracking 0.09em, `--ink-2` | Zone dividers ("SLA & RESOLUTION PRIORITY") |
| Tab label | Inter | 14px / 650 | tracking -0.01em | Tab name; subtitle below at 10.5px |
| Card title | Inter | 13.5px / 650 | tracking -0.005em | Every card and table heading |
| Large card title | Inter | 17px / 650 | `.card-lg` only | Feature cards (padding 26/28/24) |
| Body | Inter | 14px / 400 | line-height 1.45, antialiased | Default text |
| Card sub / label | Inter | 11.5px / 600 | `--ink-3` | Subtitles, stat labels, legends |
| Table body | Inter | 12.5px | n/a | Table text |
| Table header | Inter | 10.5px / 650 | uppercase, tracking 0.05em, `--ink-3`, sticky | Table column headers |
| Stat value | JetBrains Mono | 22px / 600 | tracking -0.01em, `tabular-nums` | KPI numbers; unit suffix 13px / 600 |
| Table number cell | JetBrains Mono | 12px | `tabular-nums`, right-aligned (`td.num`) | Numeric columns |
| Bar and legend counts | JetBrains Mono | 11.5px / 600 | `tabular-nums` | Bar rows, donut legends |
| Radial ring value | JetBrains Mono | 13px / 700 | n/a | Centre of progress rings |
| Time picker digits | JetBrains Mono | 34px / 650 | n/a | Clock dialog display |

**Tabular rule:** any number that sits near another comparable number uses `--font-mono` plus `font-variant-numeric: tabular-nums`. Numbers inside a sentence stay in Inter.

### Spacing

- Base grid gap is 14px between cards (`.grid`), 10px inside stat strips, 8 to 12px for small clusters.
- Card padding is `18px 18px 16px`; card head sits 14px above its content.
- Section headings have 30px above and 14px below (0 above when first).
- Tab bar has 26px below it. Page container is 1280px max with 24px side padding.
- Table cells are `9px 10px`; header cells have 8px below.

### Radius

| Value | Used for |
| --- | --- |
| 12px (`--radius`) | Cards, stat tiles, live panel, drill-down, contact hover card |
| 8px (`--radius-sm`) | Error banner |
| 9px | Buttons, toolbar groups, menus, tooltips, sync chip |
| 7px | Inputs, pills inside a segmented control |
| 4 to 6px | Bar tracks, skeletons, menu items |
| 16 to 20px | Modal and time-picker dialogs |
| 999px or 100px | Chips, pills, agent chips |

### Elevation

Flat at rest: a 1px `--line` border does the separating and the shadow is only a light assist. Cards and stat tiles lift on hover only.

| Token | Light | Used on |
| --- | --- | --- |
| `--shadow` | `0 1px 2px rgba(20,24,38,.05), 0 6px 16px -8px rgba(20,24,38,.08)` | Cards, stat tiles, active period pill |
| `--shadow-hover` | `0 2px 4px rgba(20,24,38,.06), 0 14px 28px -10px rgba(20,24,38,.14)` | Card hover (plus 1px upward move), modals, contact card |
| Popover | `0 8px 24px rgba(20,24,38,.14)` | Date-range picker, account menu |
| Tooltip | `0 4px 16px rgba(20,24,38,.12)` | Recharts tooltips |

Dark values are heavier (for example `--shadow` is `0 1px 2px rgba(0,0,0,.35), 0 6px 20px -8px rgba(0,0,0,.45)`). Popover and tooltip shadows are not themed.

### Motion

- All hover transitions (`background-color`, `border-color`, `box-shadow`, `transform`) run at 0.15s ease and are wrapped in `@media (prefers-reduced-motion: no-preference)`.
- Card hover: shadow lifts and the card moves up 1px. Stat tile hover: stronger shadow and a border tinted 30% blue.
- Bar fills animate width over 0.4s; radial rings animate stroke offset over 0.6s; drill-downs fade and slide in over 0.18s; the contact hover card fades over 0.12s.
- Loading skeleton: a shimmer gradient sweep, 1.4s, infinite. This is the only looping animation.

### Focus and cursor

`:focus-visible` shows a 2px `--accent-blue` outline with 2px offset and 4px radius on every element. It is never removed or replaced. Clickable rows use `cursor: pointer`, drag handles use `grab` and `grabbing`, and note markers that carry a tooltip use `cursor: help`.

### Icons

There is no icon library. Small icons are inline SVG with `stroke="currentColor"` and `strokeWidth=2` (mail, phone and warning icons at 12 to 13px, the Google logo in four brand colours). Toolbar buttons use emoji as glyphs: refresh, hourglass for busy, moon and sun for theme, and a download arrow for exports. Each icon-only button has an `aria-label` and a `title`.

## 4. Layout, navigation and theming

Every screen is one centred column (max 1280px) built from the same five stacked layers. New dashboards should keep this order so users learn it once.

1. **Header** (brand left, toolbar right)
2. **Error banner** (only when the API fails)
3. **Live panel** (always-current stats, ignores the date range)
4. **Tab bar** (zones of the product)
5. **Tab content**: section headings, each followed by cards in a grid, then a footer note

### Header

- **Left:** 32px logo mark (swaps to a light logo in dark mode), a small uppercase eyebrow ("HackerEarth · Support") and the `h1` ("Ticket Hub").
- **Right toolbar, in order:** sync chip (green dot, "Synced 3 min ago (4:05 PM IST) · 1,284 tickets"), refresh icon button, period selector, theme toggle, account menu or "Sign in" button.
- **Period selector:** a segmented control with Today, Yesterday, Week, Month and Custom. The active segment is white with a light shadow on a `--surface-2` track. Custom opens a popover with two native date inputs and an Apply button (disabled until both dates are set).
- **Account menu:** a 32px circular avatar button with the same footprint as the icon buttons, so signing in never changes the toolbar width. The name, "Export this period" and "Sign out" live in a dropdown, so a long name can never wrap the header. It closes on outside click.
- The header wraps (`flex-wrap`) on narrow screens instead of shrinking.

### Live panel

A tinted container (6% aqua over surface, aqua-tinted border) holding a static green dot with a soft halo, the title "Live updates", the note "always current · independent of the date range above", a four-tile stat strip, and an "On shift now" row of agent chips with two guidance notes. It is the only region that ignores the period selector, and the label says so explicitly.

### Tab bar

Underline tabs, not filled pills. Each tab has a bold label, a 10.5px subtitle, and its own accent colour (`--tab-accent`) that fills the 2px underline when active. Inactive text is `--ink-3` and steps up to `--ink-2` on hover; the active label turns `--ink`. The bar has a 1px bottom rule. It uses `role="tablist"`, `role="tab"` and `aria-selected`.

| Tab | Subtitle | Accent | Sign-in needed |
| --- | --- | --- | --- |
| Overview | Org-wide | Blue | No |
| Frontline | L1 | Aqua | Partly (team performance section) |
| Backline | L2 | Orange | Partly (AE performance, escalations) |
| Customers | By account | Indigo | Partly (customer health table) |
| Programs/Events | By event | Yellow | No |
| Slack Requests | Content/engg on-call | Magenta | No |
| Frontline Metric Dashboard | Quarterly rollup | Aqua | Yes (tab hidden when signed out) |
| Frontline Agents | Shift timings | Aqua | Yes (tab hidden when signed out) |

### Content grid

- `.grid` is a CSS grid with a 14px gap. `.cols-2` is `1.4fr 1fr` (a main card plus a narrower companion). `.cols-3` is three equal columns.
- Stat strips use six equal columns, or four for the live panel.
- Breakpoints: at 900px and below, `.cols-2` and `.cols-3` become one column and the stat strip drops to three columns; at 540px and below the stat strip drops to two. These are the only two breakpoints.
- Section headings (coloured dot, uppercase title, a rule that stretches to the right, optional action button at the far right) group cards into zones. Page actions such as "Download Excel" sit in the heading's `action` slot.
- The footer states the data source in small `--ink-3` text, separated by a 1px rule.

### Light and dark mode

- Theme is stored in `localStorage` under `helpdesk-theme`. With no stored value, the OS preference decides. The theme is applied as `data-theme` on `<html>`.
- `theme.css` defines tokens three times: in a `prefers-color-scheme: dark` media query, under `[data-theme="dark"]`, and under `[data-theme="light"]`. When you add or change a token, update all three or one mode will silently drift.
- `color-scheme: light dark` is set so native controls (date inputs, scrollbars) follow the theme.
- Dark mode is a fully specified peer of light mode, not an inverted filter. Status colours are identical in both.

### Access model

Signed-out visitors see the full org-wide picture; signing in unlocks per-agent and escalation detail rather than a "better" view of the same data. Gated sections are removed from the page, not greyed out, and gated tabs are removed from the tab bar.

## 5. Component catalogue

### The card contract

Every data card follows one contract, which is the single most reusable idea in this frontend:

- It takes `data` (or the specific slice it needs, typed, and `null` until loaded) and a `loading` boolean. It never fetches by itself.
- It renders in this order: **loading** (a `.skeleton` block sized to the content), **empty** (one plain `.card-sub` sentence such as "No escalations in this period."), **content**.
- Its head is a `.card-head` with a `.card-title` and `.card-sub` on the left and an optional action on the right (a "View as table" toggle, a select, a download button).
- Anything personal or gated is hidden by the parent (`{user && <Card/>}`), not inside the card.

### Building blocks

| Component | Anatomy and behaviour |
| --- | --- |
| Card (`.card`) | Surface, 1px line border, 12px radius, 18/18/16 padding, ambient shadow; lifts 1px on hover. `.card-lg` is the roomier variant (26/28/24 padding, 17px title). |
| Stat tile (`StatTile`) | Label (11.5px, ink-3), mono value (22px) with optional unit, optional foot note (11px). `tone` is `default`, `good`, `warn` or `critical` and changes only the value colour. A skeleton twin exists. |
| Stat strip | Grid of stat tiles: 6 columns, 4 in the live panel; falls to 3 then 2 on small screens. The summary card shows 7 tiles, and an eighth (same-day resolution time) appears only for the "today" period. |
| Radial stat | Hand-built SVG progress ring for ratio KPIs, auto-fit grid of 86px minimum cells; ring animates over 0.6s. |
| Section heading | Colour dot, uppercase title, rule, optional action slot. |
| Tab nav | Underline tabs with per-tab accent (see section 4). |
| Chip (`.chip`) | Pill, 11px / 650, 3px 8px padding. Tones: `good`, `warning`, `serious`, `critical`, `neutral`. Always has text; the dot (`.dot`) is optional. Used for sync state, priority and live wait. |
| Pills | `shift-pill` (aqua), `weekoff-pill` (neutral), `holiday-pill` (yellow); 12.5px, fully rounded, tabular numerals. |
| Bar list (`BarList`) | Rows of label (150px column), 16px track with a coloured fill, mono value. Width is relative to the largest value. With `onItemClick` each row becomes a button with hover tint and an `active` state (blue, semibold label). Fill animates over 0.4s. |
| Donut and pie | Recharts pie with a custom legend grid (`auto-fit`, 150px min), where each row shows swatch, name, count and percentage; hovering a legend row highlights its slice, and hovering a slice highlights its row. |
| Area chart | Recharts `AreaChart`: dashed horizontal grid only, 2.25px stroke, 16% to 0% gradient fill, dots on every point, y-axis fixed to start at `0`, no animation, custom tooltip. |
| Stacked horizontal bar | One row per customer (34px each, minimum 90px), categorical colours, legend above when there is more than one series, 140px label column. |
| SLA stacked strip | 10px segmented bar using the status colours in a fixed order, with a legend carrying counts. |
| Chart tooltip (`.chart-tooltip`) | Surface background, line border, 9px radius, bold title, one row per series with an 8px swatch and a bold ink value. |
| Legend (`.legend`) | Wrapping row of 9px square swatches with 11.5px labels. Shown for every chart with two or more series. |
| Table (`.tbl-wrap` + `table`) | Sticky uppercase header, hairline row dividers, no zebra, row hover tint, scrolls inside a 360px max height. Numeric columns use `th.num` / `td.num`. Ticket column uses `name-cell`: a subject link plus the `#id` in `.card-sub`. |
| Total row | `.tbl-total-row`: bold, 2px top border, `--surface-2` fill. |
| Drill-down panel | Click a bar row or legend row and a `--surface-2` panel (with a Close action) slides in below with the matching tickets. Only one is open at a time; clicking the same item closes it. The shaded panel is shared by the NPS and Slack priority cards; the module and status cards expand a plain table under the bars instead. |
| View as table toggle | Text button in blue (`.table-toggle`) on chart cards that swaps the chart for the same data as a table, so every chart has a non-visual twin. |
| Select (`.select`) | Native `<select>`, 12.5px, `--surface-2` fill, 7px radius. Used for every filter and page-size control. |
| Icon button (`.icon-btn`) | 32px square, 9px radius, `--surface-2` fill with a 1px border; text darkens on hover. |
| Section action (`.section-action`) | Small bordered button for exports, disabled at 50% opacity while busy. |
| Menus | Account menu and customer export menu: trigger button plus an absolutely positioned panel (surface, line border, 9px radius, popover shadow, `z-index: 10`), dismissed on outside click. |
| Date-range popover | Two native `type="date"` inputs plus Apply; stays open until applied. |
| Modal (`.modal-dialog`) | Fixed backdrop at 45% dark, centred surface dialog, 16px radius, title (15px / 700), body (13px, ink-2), right-aligned actions; `z-index: 100`. Used for shift swap confirmation. |
| Time picker dial | Material-style clock: 232px SVG dial, large mono HH and MM segments, AM/PM switch, aqua hand and knob; drag-friendly (`touch-action: none`). |
| Contact hover card | Pure CSS hover and `:focus-within` card (name, mail icon and address, phone icon and number), placement `top` or `bottom`, 0.12s fade. The trigger has `tabIndex=0` so keyboard users get it too. |
| Skeleton (`.skeleton`) | Shimmer block with 6px radius; each card picks a height close to its content (90, 140, 180, 210 or 220px). |
| Error banner | 10% critical tint, 30% critical border, critical text, 8px radius, full width above the live panel. |
| Footnote | Small text pinned at the bottom of the page and under some cards. Data-quality caveats use the same `.card-sub` style so they are visible but quiet. |

### Interaction patterns worth copying

- **Click to drill:** every distribution card is clickable only when the matching ticket list is available (signed in). Without it the rows render as plain text and the subtitle drops the "click a module for its tickets" hint.
- **Client-side listing:** the Slack issues table filters, sorts and paginates in the browser over an already-fetched list (reporter, assignee, priority, validity, sort, 10/25/50/100 per page). Changing any filter resets to page 1, and the page number is clamped so it can never exceed the page count.
- **Collapsible leftovers:** low-priority groups (for example "Uncategorized, no workflow tag") sit inside a native `<details>` element.
- **Inline editing:** the agent roster edits name, email, phone and shifts in place, with Save and Cancel, and disables drag-and-drop while any row is being edited.
- **Drag to swap:** dragging an agent's header onto another agent's header highlights valid targets with a dashed aqua outline (stronger on hover) and opens a confirm modal before swapping their shifts.
- **Sticky columns:** the quarterly metric table pins two columns (metric name 260px, target 84px) so quarters scroll underneath; pinned cells use opaque backgrounds so scrolled content never shows through the seam.

## 6. Screens, content and rules per tab

The page header and live panel are shared. The selected tab decides what renders beneath; everything is driven by the one period selector except the live panel, the roster and the quarterly metric dashboard.

| Tab and section (heading colour) | Cards, in order | Notes |
| --- | --- | --- |
| **Overview**: Overview (blue) | "This period at a glance" stat strip | 7 tiles, 8 for "today" |
| Volume and Distribution (indigo) | Ticket volume area chart; Volume by module + Volume by source (2-col); Status distribution; Tickets by pending stage, by team | Chart has a table twin; module and status drill into tickets when signed in |
| SLA and Resolution Priority (yellow) | SLA panel + Resolution by priority (2-col) | SLA strip turns critical when breach rate is above 10% |
| Service Health (magenta) | CSAT + Data quality (2-col) | CSAT shows an expandable list of responses that could not be matched to a ticket |
| NPS (green) | NPS card with bar list, donut and drill-down | Section action downloads an Excel report; can jump to the Customers tab |
| **Frontline**: Frontline Quality (aqua) | First response and first contact resolution + Resolution ownership (2-col) | Public |
| Team Performance (aqua) | Agent leaderboard with total row; Data anomalies | Signed in only |
| **Backline**: Backline Operations (orange) | Overview with stat tiles, radial rings and a resolution bar list; Stage timing (2-col with AE performance) | AE performance is signed in only |
| Escalations (red) | Escalations past backline table | Signed in only; "Live wait" chip, over 48h critical, over 24h serious, otherwise warning |
| **Customers** (indigo) | Customers at a glance (4 tiles + "Top" chip); Volume by customer + Status by customer (2-col, shared "show all accounts" toggle); Resolver breakdown; Account health table | Export menu in the heading; health table signed in only |
| **Programs/Events** (yellow) | Issues by event | Export control takes the event list from the data |
| **Slack Requests** (magenta) | Overview; "Issues by team" bar list; two reporter donuts (Content, Engg Oncall); Priority card; Slack-reported issues table | Table has a category select, four filters, sort, pagination, and a collapsible "Uncategorized" group |
| **Frontline Metric Dashboard** (aqua, signed in) | Quarterly metric table, then Quick Links | Excel download in the heading |
| **Frontline Agents** (aqua, signed in) | Shift roster table | Add, edit, delete, swap, drag |

### Business-rule colouring (thresholds in code)

| Where | Rule | Colour |
| --- | --- | --- |
| FRT on time (live tile) | at least 80% | good; below 80% warn; no data default |
| SLA breach percentage | above 10% | critical; otherwise good |
| Customer coverage tile | below 10% | warn |
| Escalation live wait | over 48h / over 24h / otherwise | critical / serious / warning |
| Metric dashboard "Achieved" cell | compared with parsed target (`>=70%`, `<=72 Hrs`) | good or critical; bare-number targets are not coloured |
| Sync chip dot | last sync older than 30 minutes, or a sync error | warning (stale) |
| Slack priority chip | LOW, MEDIUM, HIGH, URGENT | good, warning, serious, critical; unknown values fall back to neutral |
| SLA statuses | Completed on time, Completed late, Due Soon, Overdue, Active SLA | good, serious, warning, critical, neutral |

### Domain label maps

- **Priority:** severity order URGENT, HIGH, MEDIUM, LOW, shown with the support P-level (P0, P1, P2, P3/P4). Unknown priorities sort after the known ones.
- **Ticket validity:** stored values `Valid` and `Invalid` display as "Valid Issue" and "Invalid Issue"; `null` displays as "Not yet categorized" and is filterable through a sentinel value (`not_set`). The filter always lists the full option set, because the property is new and a list derived from the loaded rows would be nearly empty.
- **CSAT ratings:** 0, 1, 2 display as Unhappy, Neutral, Happy.
- **Module tail:** "Not Actionable", "Spam", "No Information Received", "Duplicate" and "Not set" are pinned to the bottom of the module list in neutral grey, below every real module.

### Formatting helpers (`format.ts`)

| Helper | Output |
| --- | --- |
| `formatHours` | `null` gives an em dash; under 1h in minutes (`45m`); under 24h with one decimal (`3.5h`); otherwise days (`2.3d`) |
| `formatPercent` | one decimal with `%`, em dash for `null` |
| `formatNumber` | `en-US` thousands separators |
| `formatRelativeTime` | "never synced", "just now", "N min ago", "Nh ago", "Nd ago" |
| `formatIstTime` | absolute time in Asia/Kolkata, always suffixed "IST", regardless of the viewer's timezone |
| `todayIstDate` | `YYYY-MM-DD` for today in IST, used for the date picker's upper bound |
| `hubspotTicketUrl` | deep link to the ticket record in the HubSpot portal |

Missing values are always an em dash, never `0`, `null` or blank. Metric-table values use an en dash and a per-metric format (`percent`, `hours`, `days`, `score`, or a plain number).

## 7. State, data fetching and refresh

There is no global store. `App.tsx` owns the page state and passes plain props down; hooks own each data source. This works because the app is a single page with one shared filter (the period).

### Where state lives

| State | Owner | Persistence |
| --- | --- | --- |
| `period` (default `week`) | `App` | In memory only; a reload resets it |
| `tab` (default `overview`) | `App` | In memory only; tabs are not in the URL, so a tab cannot be deep-linked |
| `theme` | `useTheme` | `localStorage` key `helpdesk-theme`, falls back to OS setting |
| `user` | `useAuth` | Cookie session on the server; `GET /api/users/me` on load, `null` when signed out |
| Dashboard data | `useDashboardData(period, isLoggedIn, refreshKey)` | None; refetched on change |
| Live and sync status | `useLiveStatus` | Polled every 60s |
| On shift now | `useOnShiftNow` | Polled every 30s; public |
| Roster | `useFrontlineAgents` | Polled every 60s; signed in only |
| Quarterly metrics | `useFrontlineMetricDashboard` | Fetched on sign-in and on refresh; signed in only |
| Card-local UI (expanded row, filters, page, toggle) | The card itself | In memory; resets when the tab changes |

### API client (`api.ts`)

- One function per route under the `/dashboard` base: `get<T>(path, params)`, `post`, `sendJson` (POST or PUT with a JSON body), `del`, and blob downloads for Excel exports.
- A non-2xx response throws `ApiError(message, status)` with the text "GET /path failed: 500 Internal Server Error".
- Auth lives in a separate `authApi` on `/api/...` (me, logout). The sign-in link is a plain anchor to `/api/auth/google/login`.
- No tokens or headers are attached by the frontend; the browser sends the session cookie. This is why the app must be served from the same origin as the API (nginx in production, the Vite proxy in development).
- All response shapes are declared once in `types.ts`, and the `DashboardData` type nests each as `T | null` so a card can render before its data arrives.

### Period handling

- A period is a string: `today`, `yesterday`, `week`, `month`, or `custom:YYYY-MM-DD:YYYY-MM-DD`. It is sent as the `period` query parameter.
- Granularity is derived on the client: `hour` for today, yesterday and a single-day custom range; `day` otherwise. This avoids a one-point chart.
- "Today" is computed in IST (`Asia/Kolkata`) to match the backend's period boundaries, not the viewer's timezone or UTC.
- The custom picker is bounded: earliest date `2026-02-02` (the backfill date), latest today in IST, end cannot precede start. Typing into the date inputs is blocked (`onKeyDown` prevented) so only the calendar picker can set a value.

### Fetch strategy

- On a period, sign-in or refresh change, `useDashboardData` fires every period-scoped route in parallel (22 public calls, plus 8 more when signed in) and renders when all have resolved.
- **Public group:** all-or-nothing. If any call fails, `data` becomes `null`, `error` is set, and the error banner shows.
- **Private group:** failure is swallowed (`catch` returns empty values) and never blocks the public group, so a signed-out or partially failing user still sees the org-wide dashboard.
- A `cancelled` flag in the effect cleanup discards late responses from a previous period, so a slow request can never overwrite a newer one.
- While loading, the previous data is kept but every card shows its skeleton (`loading` is `true`).

### Refresh model

1. The backend syncs from HubSpot every 5 minutes.
2. `useLiveStatus` polls `/live/today` and `/meta/sync-status` every 60 seconds.
3. When `last_synced_at` changes (and it is not the first value), `App` bumps `refreshTick`, which refetches all dashboard data. There is no blind timer on the heavy data.
4. "Sync now" posts to `/meta/sync-now`, updates the sync chip, and that same change triggers the refetch.
5. Any edit in the roster refreshes both the roster and the public on-shift strip so they never disagree.

### Downloads

Exports fetch a `Blob`, create an object URL, click a temporary anchor, then revoke the URL. File names embed the period with `:` replaced by `_` (for example `helpdesk-export-custom_2026-03-01_2026-03-31.xlsx`). The trigger shows "⏳ Exporting…" and is disabled while the request runs. Exports available: whole workbook for the period, NPS report, frontline metric dashboard, customer counts, tickets for one customer, tickets for a pasted list of company names, and tickets for one event.

## 8. Edge cases and how each is handled

The first table is what the current frontend already does and should be copied. The second is where the current build falls short; new projects should fix these rather than inherit them.

### Handled today (copy these)

| Situation | Handling |
| --- | --- |
| Data still loading | Each card shows a shimmer skeleton of about the same height as its content, so the page does not jump when data arrives. |
| Empty result | One quiet sentence naming the period, for example "No escalations in this period." Never a blank card or a chart with no data. |
| Missing value in a cell or tile | Em dash (`—`), never `0`, `null` or `undefined`. Percent and hours helpers do this for `null`. |
| Whole API unreachable | A red banner above the live panel with the error and a hint that the backend may not be running; cards fall back to their empty and skeleton states. |
| Private data fails while public works | The private fetch error is swallowed, the page still renders the org-wide view, and gated cards are simply absent. |
| Slow response from an older period | Effect cleanup sets `cancelled`, so a stale response cannot overwrite a newer one. |
| Signed out while on a gated tab | An effect returns the user to Overview. Gated tabs are removed from the tab bar. |
| Sign-in rejected for a non-allowed account | The backend redirects with `?authError=not_allowed`; the app shows an alert, then removes the parameter from the URL without reloading. |
| Single-day range or today | Hourly buckets, so the trend is a line and not one dot. A one-point series also gets a larger dot. |
| Chart y-axis on small numbers | Domain fixed to start at `0`, no decimals on count axes, so ticks never drift negative or fractional. |
| More than 8 categories | Bar lists switch to one neutral grey for the tail instead of a ninth hue; pinned junk buckets (Spam, Duplicate and so on) always sort last. |
| Lists too long | Server caps ticket lists at 100; cards show "(showing first 100)" or "Showing first N of M" from a `truncated` flag. A table scrolls inside a 360px box with a sticky header. |
| Long text in a cell or label | Ticket subjects and bar labels carry the full text in a `title` tooltip; menu names, legend names and link labels use `text-overflow: ellipsis`; bar labels wrap with `overflow-wrap`. |
| Unknown enum value from the API | Priority chips fall back to `neutral`; unknown validity values are shown as-is and sorted after the known ones; unknown CSAT ratings read "Rating N". |
| Data the system could not link | Shown, not hidden: "N responses couldn't be matched to a ticket" with an expandable list; "not found in description, showing assignee" under a fallback reporter. |
| Filters that remove every row | "No tickets match the current filters." and the page counter stays valid (`Page 1 of 1`). |
| Current page beyond the new page count | The page is clamped to the last valid page; any filter or page-size change resets to page 1. |
| Timezone differences | All "today" logic and absolute times are IST regardless of the viewer's locale, with the suffix "IST". |
| Stale data | Sync chip dot turns amber after 30 minutes or on a sync error; "never synced" is shown when no sync exists yet. |
| Duplicate export clicks | The button disables and shows "⏳ Exporting…" until the download finishes. |
| Reduced motion | Hover lifts and transitions only apply under `prefers-reduced-motion: no-preference`. |
| A hover card would be clipped | The contact hover card supports `top` and `bottom` placement; the roster table's column headers use bottom so the card is not cut off by the scroll container's top edge. |
| User edits while a drag could start | Drag-and-drop is disabled while any row is being edited, saving, or a swap confirmation is open. |
| Required form fields blank | Save does nothing until name and email (or name and URL) are filled; trimmed values are sent. |
| Phone number not provided | The hover card omits the phone row; the API receives `null`, not an empty string. |

### Known gaps in the current build (fix in new projects)

| Gap | Where | Suggested fix |
| --- | --- | --- |
| One failed public call blanks the whole dashboard | `useDashboardData` uses one `Promise.all` | Use `Promise.allSettled` and show a per-card error with a Retry button |
| No per-card error state or retry | All cards | Add a shared `CardError` component alongside the skeleton and empty states |
| Export failures are silent | `try/finally` with no `catch` in `App` and export controls | Catch, show an inline error or toast |
| Native `alert` and `confirm` used | Auth error and "Remove this agent" | Reuse the existing modal dialog |
| Tab and period are not in the URL | `App` state | Sync both to query parameters so links and reloads keep context |
| Tab bar has eight items and no overflow handling | `.tab-nav` | Allow horizontal scroll with a fade, or collapse into a menu below 900px |
| Tab bar has no arrow-key navigation or `tabpanel` | `TabNav` | Add roving tabindex, `aria-controls` and `role="tabpanel"` |
| Only about 17 ARIA attributes in the codebase | Charts, drill-down rows, menus | Add `aria-label` to charts, `role="menu"` to dropdowns, `aria-live` to sync status |
| Emoji used as icons | Header and export buttons | Replace with inline SVG so they render the same on every OS |
| Chart colour order differs between components | `StackedBreakdownCard` uses blue, aqua, orange, magenta, indigo, yellow, red, green, and wraps with a modulo; module and source cards use the documented order and stop at neutral | Export one shared `CATEGORICAL_SLOTS` array and one `colorFor` helper |
| Inline `style={{}}` for spacing | Many cards (`marginBottom: 14` and similar) | Add small utility classes or a `Stack` component |
| Three copies of every theme token | `theme.css` | Generate from one source, or keep one `[data-theme]` block plus a media query that sets the attribute in JS |
| Dockerfile uses `npm install` while a `pnpm-lock.yaml` is committed | `frontend/Dockerfile` | Use `pnpm install --frozen-lockfile` for reproducible builds |
| Hard-coded portal ID, Slack channel ID and earliest data date | `format.ts`, `ActiveAgentsStrip`, `Header` | Move to a config module or `VITE_*` environment variables |
| Narrow screens | Only two breakpoints; wide tables rely on horizontal scroll | Test at 375px and add a card-per-row layout for key tables |

## 9. What is fixed and what is flexible

Each row gives a selected default (marked "Use") and the room to deviate. Treat "Fixed" as a house style for every HackerEarth AI tool, so users moving between tools feel at home; treat "Flexible" as a per-project choice made against the criteria shown.

### Fixed across projects

| Area | Rule | Why |
| --- | --- | --- |
| Brand accents | The eight hex values in section 2, light and dark | Taken from HackerEarth's production CSS; recognisable across products |
| Status colours | Five `--status-*` tokens with their meanings | Severity must read the same everywhere |
| Token names | `--plane`, `--surface`, `--surface-2`, `--ink`, `--ink-2`, `--ink-3`, `--line`, `--radius`, `--shadow`, `--shadow-hover`, `--font-sans`, `--font-mono` | Lets components be copied between projects unchanged |
| Typefaces | Inter Variable and JetBrains Mono Variable | Mono for compared numbers is core to the scanning experience |
| Dark mode | Fully specified peer, user toggle, OS default, persisted | Many users work long hours or on dark systems |
| Border does the separating | 1px `--line` plus a faint shadow; lift on hover only | Keeps the interface flat and data-first |
| No decorative gradients, glass or gradient text | Only the brand mark and avatar may use the blue to indigo gradient | Product register, not marketing |
| Never colour alone | Every chip, dot and legend has a text label | Accessibility |
| Card contract | `data` + `loading`, then skeleton, empty sentence, content | Predictable behaviour and easy review |
| Honesty about gaps | Show unmatched, inferred and fallback data with a plain caveat | Stated product principle |
| Visible focus | 2px blue outline, never removed | Keyboard use |
| Missing value | Em dash | Consistency |

### Flexible per project

| Decision | Use (default) | Alternatives and when to pick them |
| --- | --- | --- |
| Framework | **React 18 + Vite + TypeScript** | Next.js if you need server rendering, SEO or file routing; keep Vite for internal tools behind a login |
| Routing | **None, tab state in memory** for a single-screen tool | Add `react-router` (or query-string sync) as soon as users need shareable links, more than about eight views, or per-record pages |
| Data layer | **Hooks plus `fetch`** for under about 30 endpoints with one shared filter | TanStack Query when you need caching, retries, background refetch or request de-duplication; adopt it before the endpoint count grows |
| Global state | **None** | Zustand or context only if three or more distant components share mutable state |
| Charts | **Recharts** for line, area, bar and donut; hand-built SVG or CSS for rings and bar lists | Visx or ECharts for heatmaps, large series (over about 5,000 points), maps or brushing |
| Styling | **Plain CSS with variables** | Tailwind or CSS modules are fine if the same tokens are mapped into the config; never introduce a second palette |
| Component library | **None; use native `select`, `details`, `input type="date"`** | Radix primitives for complex accessible widgets (combobox, dialog focus trap, menu) if a project needs them; style them with the same tokens |
| Icons | **Inline SVG** (stroke 2, currentColor) | An icon set such as Lucide, if one is installed project-wide; avoid emoji |
| Auth | **Cookie session behind same-origin proxy** | Token auth if the API is on another origin; keep the signed-out and signed-in scopes idea |
| Fonts | **Self-hosted via fontsource** | Google Fonts only if the build cannot bundle fonts |
| Package manager | **pnpm** (lockfile committed, frozen installs) | npm or yarn if the platform standard differs |
| Serving | **nginx container with SPA fallback and API proxy** | Static hosting plus a gateway, if the platform provides one |
| Time zone | **One declared zone (IST)** applied in helpers | Viewer-local time for tools used across regions; always show the zone name |
| Page width | **1280px centred** for dense dashboards | Full width for wide tables or maps; narrower (about 960px) for forms and reading |
| Tab count | **Up to about 8 tabs** | Move to a left sidebar when there are more than about 8 zones or nested levels |
| Light or dark default | **Follow the OS** | Force dark for monitoring walls (NOC style) |
| Mobile | **Desktop first, usable on tablet** | Design a real mobile layout (card list instead of tables, bottom nav) if phones are a primary device |
| Polling | **Poll light endpoints (30 to 60s) and refetch heavy data only when the source version changes** | Server-sent events or WebSockets when you need sub-10-second freshness |
| Export | **Server-generated Excel by blob download** | CSV for simple tables, PDF for reports; keep the busy-state and file-name rules |
| Zone accents | **Eight accents map to zones** | Pick your own zone-to-accent mapping, but keep it stable and unique per zone |

### How to extend the palette safely

1. Do not add a ninth categorical hue. Fold extra categories into "Other" in neutral grey.
2. If you need a new state, extend the status set (for example a `--status-info`) with a dark value and a documented meaning, not a new accent.
3. If you need a sequential scale, reuse the ordinal blue ramp instead of inventing one.
4. Check any new pair of text and background for WCAG AA (4.5:1 for body text, 3:1 for large text and UI borders) in both modes.
5. Record the change in your project's `DESIGN.md` so the next team inherits it.

## 10. Starting a new project from this design

Copy `theme.css` unchanged, then write a short `PRODUCT.md` for the new tool before designing any screen.

### Setup checklist

- [ ] Scaffold React 18 + TypeScript + Vite; enable `strict`, `noUnusedLocals`, `noUnusedParameters`.
- [ ] Install only `react`, `react-dom`, `recharts`, `@fontsource-variable/inter`, `@fontsource-variable/jetbrains-mono`.
- [ ] Copy `theme.css` verbatim; import it before the component stylesheet.
- [ ] Copy the base of `App.css` (header, tab nav, grid, card, stat, chip, table, skeleton, error banner, tooltip) and delete anything the new tool does not use.
- [ ] Add `useTheme` (storage key unique to the project) and set `data-theme` on `<html>`; ship a light and a dark logo.
- [ ] Create `api.ts` with the `get`, `sendJson`, `del` and blob helpers and an `ApiError`; one function per endpoint; types in `types.ts`.
- [ ] Configure a dev proxy and an nginx location for each API prefix so the app calls relative URLs only.
- [ ] Copy `format.ts` and set the declared time zone and the "missing" glyph.
- [ ] Build `Header`, `TabNav`, `SectionHeading`, `StatTile`, `BarList` and the card contract first; every other card is composed from these.

### Per-screen checklist

- [ ] One question per card; the answer is a number, a bar or a short table, with detail one click away.
- [ ] Card has loading, empty and content states, and an error state with Retry.
- [ ] Every chart has a text legend (for two or more series), a table twin, and a y-axis starting at 0.
- [ ] Numbers that are compared use mono and tabular numerals and are right-aligned in tables.
- [ ] Colour is by fixed position for categories and by status token for meaning; never mixed.
- [ ] Anything gated by sign-in is removed (not greyed out) for signed-out users, and the tab or section returns to a safe screen if the user signs out.
- [ ] Lists have a cap, a `truncated` note, and a scroll box with a sticky header.
- [ ] Filters reset pagination, and options are derived from data unless the full set is known up front.
- [ ] Exports disable their trigger while running and report failure.
- [ ] Data-quality caveats (unmatched, inferred, fallback) are shown in plain words next to the number they affect.

### Pre-release checklist

- [ ] Review every screen in light and dark mode, and with the OS set to reduced motion.
- [ ] Tab through every control: focus ring is visible, menus and dialogs can be closed with the keyboard.
- [ ] Check contrast of any new colour pair against WCAG AA in both modes.
- [ ] Test at 1440px, 1024px, 900px and 375px; wide tables scroll inside their card, the header wraps, nothing scrolls the whole page sideways.
- [ ] Test empty data, a failing endpoint, a slow endpoint, a very long name, and a number of 0.
- [ ] Confirm the build is reproducible (committed lockfile, frozen install) and the container serves a deep link without a 404.
- [ ] Update the new project's `DESIGN.md` with any deviation from this reference, and why.

### Open questions for the design owner

- Should the known gaps in section 8 (per-card error and retry, URL-synced tab and period, shared categorical colour helper) be fixed in Ticket-Hub first, so new projects copy the corrected version?
- Is a mobile layout in scope for any upcoming tool? The current system is desktop first.
