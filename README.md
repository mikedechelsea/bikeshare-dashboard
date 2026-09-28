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

Revenue figures are **estimated trip fares**, based on the published Jan 2026 Bay Wheels tariff. They are not Lyft settlement data and exclude membership dues, tax and parking fees. That means members look cheaper per trip than they really are, because their dues aren't counted.

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
| `CF_ACCOUNT_ID`, `CF_KV_NAMESPACE_ID`, `CF_API_TOKEN` | Cloudflare KV write access |
| `PERIOD_LABEL`, `PERIOD_DAYS` | optional: label and length of the data period (used for trips per dock per day) |

### Operator actions (off by default)

The deployed dashboard is **read-only**. Capacity overrides and alert logging are only available when you set `ENABLE_ACTIONS = "true"` in `wrangler.toml` **and** add a secret with `wrangler secret put ADMIN_TOKEN`. Every write needs that token, and inputs are validated. Actions are logged to BigQuery when a `GCP_ACCESS_TOKEN` secret is set.

## BigQuery views (`sql/`)

The pipeline expects these views in `dashboard_db`:

| View | Columns used |
|---|---|
| `v_inventory_summary` / `v_inventory_usage` | `station_id, station_name, capacity, is_overridden, trip_volume, avg_duration_min, usage_turnover_rate, classic_trips, ebike_trips, classic_share, ebike_share, classic_revenue, ebike_revenue, est_revenue, revenue_per_dock, top_route, top_route_trips, top_route_revenue` |
| `v_fleet_revenue` | `bike_type, trips, est_revenue, fare_per_trip, avg_min` |
| `v_route_revenue` | `route, bike_type, trips, est_revenue, avg_min` |
| `v_rider_revenue` | `rider, trips, est_revenue, fare_per_trip, avg_min, ebike_share, conversion_gap` |
| `v_hour_mix` | `hour, time_window, rider, trips, est_revenue` |
| `v_peak_routes` | `time_window, rider, route, trips, est_revenue, avg_min, ebike_share` |
| `v_promo_targets` | `station_id, casual_share, conversion_gap, peak_casual_share, casual_trips, member_trips` |

The SQL that creates these views belongs in `sql/`.
