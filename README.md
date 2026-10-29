# Lost and Found Activities App

People who lose something report it; people who find something report it and hand it in at a lost-and-found office (a shopping mall, police station or airport). The system compares every new report with the others and suggests likely matches. Office staff receive the items, confirm matches, and check claims against details only the real owner would know, before handing the item back against an ID document. A system administrator manages the offices, accounts and reference lists, and reports show recoveries, claims and possible fraud per province, city and office.

**Group members:** Khwezi Mbili (240708474) · Nonhlahla Zulu (240982231). Both members share all roles: analysis, database design, development and presentation.
**Stack:** HTML/CSS/JavaScript · Node.js + Express · MySQL 8.4 · **Schema version:** 1.0

## Documents

| File | What it is |
|---|---|
| [docs/Lost-and-Found-User-Manual.docx](docs/Lost-and-Found-User-Manual.docx) (+ `.pdf`) | Installation and user manual: installing on a computer, and guides for members, office admins and the system admin, with 37 screenshots |

Rebuild it with `npm run docs:screenshots` then `npm run docs:manual` (the app must be running; needs `npm install` with dev tools, Microsoft Edge and Word). The screenshot tool creates its own sample data and deletes it afterwards.

## Problems addressed

| Problem | How the system solves it |
|---|---|
| Lost items are reported in many places (mall desks, police stations, airports) that do not talk to each other | One system for all offices; a member reports once and every office's found items are compared with the report |
| Finding the owner of a found item is slow and depends on luck | Automatic matching on category, province, city, dates, colour, brand and words in the description, scored 0–100; staff confirm or reject each suggestion |
| Items go to the wrong person | Claims are checked against **hidden proof details** and private photos that only office staff see; the item is handed over only after an ID document is checked; only one claim per item can ever be approved |
| False claims | Every rejected claim is counted; people with two or more are flagged on claims and in the reports |
| No figures for management | Reports per period, province, city and office: reports, recoveries, claims, decision and return times, flagged people |

## Requirements coverage

| Requirement | Where |
|---|---|
| Register and log in; roles | Self-registration (optional address and date of birth); login with username or email; bcrypt passwords. Roles: **Member**, **Office admin** (staff of one office), **System admin** |
| Persons as owners and reporters (overlapping) | A person becomes an owner and/or a reporter automatically the first time they report or claim; their codes (OWN-…, REP-…) show on **Profile** |
| Report a lost item | **Report lost**: name, category, description, colour, brand, date, province/city, place, optional office where it was also reported, up to 3 photos |
| Report or log a found item | **Report found** (member) or **Log found item** (staff, received at once): office where it is kept, hidden proof details, private photos, storage location |
| Lost-and-found offices: shopping malls, police stations, airports | **Offices** page: each office is exactly one type, with desk location, precinct, or IATA code and terminal; the system admin adds offices and their admins |
| Matching | Suggestions are made whenever an item is reported or changed; **Matches** page and the item page let staff confirm or reject them; an item can have only one confirmed match |
| Claims and verification | **This is mine – claim it** on a found item; claim workflow Pending → Under review → Approved → Returned (or Rejected / Withdrawn); staff see the hidden details beside the claimant's description; hand-over needs the ID check |
| Search | Search box in the top bar (names, descriptions, reference numbers) and filters on **Browse** (type, status, category, province, city, office, dates) |
| Reports | **Reports**: totals, recovery rate, by category, city, month and office, claim figures, possible fraud; office admins see their office and province |
| Administration | **Admin**: people (roles, reset passwords), provinces, cities, item categories, claim status names, activity log |
| Extras chosen | Item photos (public or private); hidden proof details |
| Usability, performance, security, reliability, data accuracy | Pages work on phones; parameterised SQL, hashed passwords, roles checked on every request; CHECK/FK/UNIQUE constraints; concurrency and response-time tests |

## Setup

1. Install **Node.js (LTS)** and **MySQL Server 8.4**.
2. Copy `.env.example` to `.env` and set `DB_PASSWORD` and a random `SESSION_SECRET`.
3. In this folder:

   ```
   npm install --omit=dev
   npm run db:setup
   npm run admin:create -- "First" "Last" you@example.com
   npm start
   ```

4. Open <http://localhost:3005> and log in with the username and temporary password printed by `admin:create`. Choose your own password.
5. As system admin: check the provinces, cities and categories on **Admin**, add the offices on **Offices** and give each office its admins. Members register themselves.

To try the app with fictional data, run `npm run sample:seed`: five offices, office admins, members, and items and claims in every state. Every sample account ends in `@sample.test` and uses the password set in `tools/sample-data.js`. `npm run sample:clean` removes all of it.

## Commands

| Command | What it does |
|---|---|
| `npm start` | Starts the app at http://localhost:3005 |
| `npm run db:setup` | Creates the database or applies new migrations (never deletes data) |
| `npm run db:reset` | **Deletes** the database and creates an empty one |
| `npm run admin:create -- "First" "Last" email [username]` | Creates a system admin (or promotes an existing account) with a temporary password |
| `npm run admin:reset-password -- username` | Gives anyone a temporary password |
| `npm run db:check` | Checks `db/schema.sql` matches the database and that 59 integrity rules are enforced by MySQL (test rows are rolled back) |
| `npm run test:api` | 87 end-to-end tests as all three roles (app must be running; all test data is removed afterwards) |
| `npm run test:ui` | 39 browser tests: the real pages in Microsoft Edge, including on a phone-sized screen |
| `npm run test:load` | 18 concurrency and performance tests: 30 people reporting and claiming at once, admins approving the same item at the same moment, response times |
| `npm test` | Runs every test suite (app must be running) |
| `npm run sample:seed` / `sample:clean` | Adds / removes the fictional demonstration data |
| `npm run docs:screenshots` / `docs:manual` | Retakes the screenshots / rebuilds the user manual (Word + PDF) |
| `npm run db:inspect` | Lists every key, index and constraint in the live database |

## Database

19 tables (plus `schema_migrations`), following the ERD:

- **Places:** `provinces` → `cities` → `addresses`.
- **People:** `persons` (supertype), with the overlapping subtypes `owners` and `reporters`; `it_admins` links an office admin to their office.
- **Offices:** `lost_found_offices` (supertype) with the disjoint subtypes `shopping_malls`, `police_stations` and `airports`.
- **Items:** `items` (supertype) with the disjoint subtypes `lost_items` and `found_items`; `item_categories`, `item_photos`.
- **Process:** `matches`, `claims`, `claim_statuses`, `activity_log`.

Design points:

- **Disjoint subtypes are enforced by the database.** The supertype carries its type (`item_type`, `lfo_type`) with `UNIQUE (id, type)`; each subtype has a type column fixed by a CHECK and a composite foreign key to `(id, type)`. A lost item can never get a `found_items` row, and a mall can never get a `police_stations` row.
- The ERD's secondary identifiers are **generated columns**: `OWN-000012`, `REP-…`, `L-000042`, `F-…`, `MALL-00003`, `SAPS-…`, `AIR-…`. They can never disagree with the key.
- `matches` has a generated column per item that is filled only when the match is confirmed, with a UNIQUE key on it, so each lost item and each found item has **at most one confirmed match**. The same trick on `claims.approved_flag` allows **only one approved claim per found item**, even when two admins click Approve at the same moment.
- A claim can be marked returned only when it was approved and the ID document was checked (CHECK constraint).
- Named constraints throughout: `fk_<table>_<target>`, `uq_<table>_<cols>`, `idx_<table>_<col>`, `chk_<table>_<rule>`.
- `RESTRICT` protects lookups and offices that are in use; `SET NULL` keeps reports, claims and history when an account is deleted; `CASCADE` removes an item's photos, matches and claims with it.
- Full creation script: [db/schema.sql](db/schema.sql). Upgrades: [db/migrations/](db/migrations).

### Changes made to the ERD

| ERD | Change | Reason |
|---|---|---|
| `FOUND_ITEM.CLAIM_ID` | Removed; `claims.found_item_id` links a claim to its item | A found item can have several claims (most rejected), and the link in both directions was circular |
| `AIRPORT` keyed on `PERSON_ID` | Keyed on `LFO_ID`, like the other office subtypes | An airport is a kind of office, not a person |
| `IT_ADMIN` | Table `it_admins` (person ↔ office, one office per person) | Lets an office have several admins and makes "staff of this office" checkable |
| Status, matching and fraud | Added `status` on items, `matches`, `claim_statuses`, `activity_log` | Needed for the matching, claim workflow, fraud flag and accountability in the requirements |

## Project structure

```
server.js              Express app, sessions, readable database errors
routes/                auth, lookups, items, matches, claims, offices, reports, admin, stats
lib/                   account helpers, login/role middleware, input validation, visibility rules, matching, addresses
db/                    schema.sql, migrations/, setup.js, pool.js
public/                Web pages (one per menu item), style.css, js/common.js, fonts/
tools/                 admin commands, schema comparison, tests, sample data
```
