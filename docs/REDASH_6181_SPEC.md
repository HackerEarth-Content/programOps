# Redash query 6181 ("Event Registration Data with YOE"): changes requested for ProgramOps

> **Status (2026-11-11): implemented and tested as Redash query 6182**
> (`[ProgramOps draft] Event Registration Data with YOE v2`, a fork of 6181; the original is unchanged). All
> invariants in section 4 pass on `hackcellence-the-embark-edition` (66 s, 96 rows instead of 2,889) and on
> `ibm-z-day`; the daily series equals 6123 day by day; `bangalore, HYDERABAD` gives the same numbers as
> `Bengaluru, Hyderabad`; a bad YOE returns one `Error` row. Not yet tested on an invite-based hiring challenge
> (none active). The owner can promote 6182's source into 6181, or keep 6182 as the query ProgramOps calls.
> **ProgramOps now calls 6182** (`REDASH_CANDIDATES_QUERY_ID`, `core/candidates.py`). If the source is promoted into
> 6181, change that one setting (or leave 6182 as it is); the parameters and output columns are identical.

Owner of the query: please apply these to 6181 (or a copy). ProgramOps will call it once per program per day
and store the result, so it must be **correct, complete and reconcilable**. Today it is a Django-ORM Python query
that takes ~77 s for an event with 44k registrants (HackCellence). Target: no slower than that.

Keep the existing parameter names and the four existing columns (`Section`, `Dimension`, `Total Registrations`,
`Matching Required Count`) and sections, so nothing already reading it breaks. Everything below is additive unless
marked **change**.

## 1. Parameters

| Parameter | Accepted values (anything else: return one `Error` row and stop) |
|---|---|
| `Event - Title or Slug` | unchanged |
| `Required YOE` | `any` / `0+` (no requirement), `N+` (at least N), `N-M` (inclusive range). Drop bare-digit "exact" and `=N`, `min:`/`max:` if nothing else uses them. |
| `Required location` | `All`, or a **comma-separated list of cities**, e.g. `Bengaluru, Hyderabad` |

Note: Redash pastes these into the Python source before it runs, so a value containing a quote can break out of
the string literal and run code on the worker. In-query validation cannot stop that (it runs too late). ProgramOps
validates all three values before calling (slug `[A-Za-z0-9_-]`, YOE by the grammar above, location letters /
spaces / commas / hyphens / dots only). Please do not rely on the query to sanitise.

## 2. Matching rules (**change**)

- **Location:** compare the *normalised city* of the candidate with the *normalised* required cities by
  **equality** (never substring, and never `candidate in required`: today a profile location of `b` matches
  `Bengaluru`). A candidate with no location never matches a specific city.
- **YOE:** a candidate with **unknown YOE never counts as meeting a required YOE** (today it always does, which
  inflates "relevant" by every unknown-YOE registrant, 60 % on HackCellence). They are reported separately, see 3.

Normalised city = take the profile `location` (fall back to `city`), keep the part before the first comma,
strip, collapse whitespace, case-fold, then apply this alias list: bangalore, bengalore, bengaluru urban/rural/city
-> bengaluru; gurgaon -> gurugram; bombay -> mumbai; madras -> chennai; calcutta -> kolkata; new delhi, delhi ncr ->
delhi; secunderabad -> hyderabad; trivandrum -> thiruvananthapuram; cochin -> kochi; vizag -> visakhapatnam; poona
-> pune. Text with no Latin letters, or shorter than 3 characters, is `Unparsed`. Display in Title Case.

## 3. Output

Add one column: **`Possibly Relevant Count`** (integer; 0 where not applicable).

| Section | Rows |
|---|---|
| `Overall Registration Metrics` | `Total registrations` (Total). **New** `Relevant registrations (known YOE AND location)` (Matching) and `Possibly relevant (YOE unknown AND location)` (Possibly Relevant). Keep the old `Overall relevant registrations (YOE AND location)` row as it is for compatibility. |
| `YOE Breakdown` | unchanged (one row per YOE plus `Unknown`; Matching follows the new rule, so `Unknown` matches 0). |
| `Location Breakdown` (**change**) | one row per **normalised city**, top 50 by Total, then `Other cities` (sum of the rest) and `Unknown` and `Unparsed`. Matching = confirmed relevant in that city; Possibly Relevant likewise. Replaces the ~2,900 raw-string rows. |
| `Daily Registrations` (**new**) | one row per calendar date: `Dimension` = `YYYY-MM-DD`, Total = registrations that day, Matching = confirmed relevant that day, Possibly Relevant = possibly relevant that day. |
| `Parameters` | unchanged (echo the values as parsed). |

Daily date = date of the user's event **Subscription timestamp** (already read by the query, currently unused). For
a user with only a Participation record, use `Participation.start_time`. Use the same time zone as query 6123's
`Registration Daily JSON` so both agree on which day a registration belongs to.

## 4. Invariants (ProgramOps rejects and does not store a result that breaks one)

For the same run:
1. `sum(YOE Breakdown Total) = sum(Location Breakdown Total) = sum(Daily Registrations Total) = Total registrations`
2. `Relevant + Possibly relevant <= Total registrations`
3. `sum(Location Matching) = Relevant` and `sum(Location Possibly Relevant) = Possibly relevant`
4. `sum(Daily Matching) = Relevant` and `sum(Daily Possibly Relevant) = Possibly relevant`
5. With `Required YOE = any` and `Required location = All`: Relevant = Total and Possibly relevant = 0.

## 5. Acceptance checks

Event `hackcellence-the-embark-edition` (Total 44,148 on 2026-11-11; will keep growing a little):
- `any` / `All` -> invariant 5 holds; YOE and city sections each sum to the total.
- `2+` / `Bengaluru, Hyderabad` -> Relevant counts only known YOE >= 2 in those two cities; Possibly relevant counts
  unknown-YOE people in those cities; no row `b` or other fragments match.
- `Bengaluru`, `bangalore` and `BENGALURU` all give the same numbers.
- Daily Registrations total equals query 6123's total for the event.
