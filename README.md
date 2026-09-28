# Dock Pulse

**Where is Bay Wheels leaving fare revenue on the table, and what should operations do about it?**

Dock Pulse is a bike-share analytics dashboard for San Francisco's Bay Wheels system. It estimates trip-fare revenue from the published Bay Wheels tariff and breaks it down by bike type, rider type, time of day, route and station. Each section ends in something operations can act on: where to rebalance, which corridors to keep stocked, and where to sell memberships.

- **Live dashboard:** _add your Worker URL_
- **Screenshot:** _add `docs/screenshot.png`_

## Key findings

_Fill these in from your live dashboard. The headline card at the top of the page generates the first one automatically._

1. …
2. …
3. …

## What the dashboard answers

| Section | Business question | Data |
|---|---|---|
| Key finding + KPIs | What's the one thing to know? | all views |
| Fleet | Do e-bikes earn more than their share of trips? | `v_fleet_revenue` |
| Riders | How much do casual riders pay vs members? | `v_rider_revenue` |
| When | When do members and casual riders need bikes? | `v_hour_mix` |
| Where | Which corridors earn the most? | `v_route_revenue`, `v_peak_routes` |
| Action | Where should a membership push start? | `v_promo_targets` |
| Stations | Which docks are busy, and which sit idle? | `v_inventory_summary` / `v_inventory_usage` |

## Architecture

```
BigQuery views  ──►  pipeline_engine.js (Node)  ──►  Cloudflare KV  ──►  worker.js (Cloudflare Worker)  ──►  dashboard.html
  (sql/)               query + normalise              one JSON doc        /api/inventory + page
```

- **`pipeline_engine.js`** queries the BigQuery views, normalises the rows and writes one JSON payload to Cloudflare KV. It won't publish if a run returns zero rides.
- **`worker.js`** serves the payload at `GET /api/inventory` and the dashboard page at `/`. The page is plain HTML, CSS and SVG, with no framework and no chart library.
- **`dashboard.html`** builds every chart and insight sentence in the browser from that payload.

## Revenue methodology

Revenue figures are **estimated trip fares**. Each August 2026 Bay Wheels trip is priced using the published Jan 2026 tariff (`sql/04_rideable_and_revenue.sql`):

| Rider | Classic bike | E-bike |
|---|---|---|
| Casual | $1 unlock + $0.19/min | $1 unlock + $0.49/min |
| Member | first 45 min free, then $0.17/min | $0.17/min |

- Trip duration is clamped to 1–180 minutes, so a broken clock can't produce a $500 ride.
- These are not Lyft settlement figures. They exclude membership dues, tax and parking fees, so members look cheaper per trip than they really are.
- **"Paid above member rates"** (`conversion_gap`) re-prices every casual trip at member rates and adds up the difference. It measures the saving a membership would have given those riders, which makes it the size of the membership pitch.

## Running it

```bash
npm install
cp .env.example .env        # fill in values (see below)
npm run pipeline            # BigQuery -> KV  (or double-click run.cmd on Windows)
npm run dev                 # local Worker at http://localhost:8787
npm run deploy              # publish the Worker
```

Environment variables for the pipeline (`.env`):

| Variable | Purpose |
|---|---|
| `PROJECT_ID` | GCP project with the `dashboard_db` dataset |
| `GOOGLE_APPLICATION_CREDENTIALS` | path to a service-account key (never commit it) |
| `KV_ACCOUNT_ID`, `KV_NAMESPACE_ID`, `KV_API_TOKEN` | Cloudflare KV write access for the pipeline. Don't use the `CF_*` or `CLOUDFLARE_*` names: Wrangler would treat this KV-only token as its deploy login, and `npm run deploy` would fail with "No access to the specified service". |
| `PERIOD_LABEL`, `PERIOD_DAYS` | optional: label and length of the data period (used for trips per dock per day) |

### Operator actions (off by default)

The deployed dashboard is **read-only**. Capacity overrides and alert logging are only available when you set `ENABLE_ACTIONS = "true"` in `wrangler.toml` **and** add a secret with `wrangler secret put ADMIN_TOKEN`. Every write needs that token, and inputs are validated. Actions are logged to BigQuery when a `GCP_ACCESS_TOKEN` secret is set.

## BigQuery setup (`sql/`)

Run these in order in the BigQuery console (project `beaming-might-319312`, dataset `dashboard_db`):

| Step | File | What it does |
|---|---|---|
| 1 | `01_check_and_fix_inventory.sql` | Freezes the station list into `station_inventory` and builds a first `v_inventory_usage` from the public 2013–2016 trips |
| 2 | `02_recover_more_stations.sql` | Matches more docks against both public trip tables (by ID, exact name, then fuzzy name) |
| 3 | `06_load_from_gcs.md` | Loads the August 2026 Bay Wheels trip CSV into `baywheels_trips_recent` through Cloud Storage (the file is too big to upload directly) |
| 4 | `03_load_baywheels_month.sql` | Rebuilds station usage from the August 2026 trips |
| 5 | `04_rideable_and_revenue.sql` | Prices every trip (`trip_fares`) and creates `v_fleet_revenue`, `v_route_revenue` and the revenue-aware `v_inventory_usage` |
| 6 | `05_rider_and_peaks.sql` | Adds time windows and member-rate re-pricing, then creates `v_rider_revenue`, `v_hour_mix`, `v_peak_routes` and `v_promo_targets` |
| 7 | `07_check_fare_desk.sql` | Sanity check that the rider, hour and peak views are populated |

Then run the pipeline. Time windows are weekday 7–10am, 10am–4pm and 4–7pm, weekday off-peak, and weekend.

The pipeline reads these columns:

| View | Columns used |
|---|---|
| `v_inventory_summary` / `v_inventory_usage` | `station_id, station_name, capacity, is_overridden, trip_volume, avg_duration_min, usage_turnover_rate, classic_trips, ebike_trips, classic_share, ebike_share, classic_revenue, ebike_revenue, est_revenue, revenue_per_dock, top_route, top_route_trips, top_route_revenue` |
| `v_fleet_revenue` | `bike_type, trips, est_revenue, fare_per_trip, avg_min` |
| `v_route_revenue` | `route, bike_type, trips, est_revenue, avg_min` |
| `v_rider_revenue` | `rider, trips, est_revenue, fare_per_trip, avg_min, ebike_share, conversion_gap` |
| `v_hour_mix` | `hour, window, rider, trips, est_revenue` |
| `v_peak_routes` | `window, rider, route, trips, est_revenue, avg_min, ebike_share` |
| `v_promo_targets` | `station_id, casual_share, conversion_gap, peak_casual_share, casual_trips, member_trips` |
