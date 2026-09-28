import { BigQuery } from "@google-cloud/bigquery";
import dotenv from "dotenv";

dotenv.config();

const CONFIG = {
  projectId: process.env.PROJECT_ID || "beaming-might-319312",
  datasetId: "dashboard_db",
  viewName: "v_inventory_summary",
  usageView: "v_inventory_usage",
  cloudflare: {
    // KV_* names keep Wrangler from picking this KV-only token up as its deploy login.
    // The old CF_* names still work so existing .env files don't break.
    accountId: process.env.KV_ACCOUNT_ID || process.env.CF_ACCOUNT_ID,
    namespaceId: process.env.KV_NAMESPACE_ID || process.env.CF_KV_NAMESPACE_ID,
    apiToken: process.env.KV_API_TOKEN || process.env.CF_API_TOKEN,
    kvKey: "inventory_dashboard_data"
  },
  // Label and length of the period the BigQuery views cover (used for per-day rates on the dashboard).
  periodLabel: process.env.PERIOD_LABEL || "",
  periodDays: Number(process.env.PERIOD_DAYS) || 0
};

const bigquery = new BigQuery({
  projectId: CONFIG.projectId,
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS
});

function num(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "object" && v.value != null) return num(v.value);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalize(rows) {
  return rows.map(r => {
    const capacity = num(r.capacity);
    const trips = num(r.trip_volume);
    let turn = num(r.usage_turnover_rate);
    if ((!turn || turn === 0) && capacity > 0 && trips > 0) turn = Number((trips / capacity).toFixed(2));
    return {
      station_id: String(r.station_id ?? ""),
      station_name: String(r.station_name ?? "Station"),
      capacity,
      is_overridden: r.is_overridden === true || r.is_overridden === "true" || r.is_overridden === 1,
      trip_volume: trips,
      avg_duration_min: num(r.avg_duration_min),
      usage_turnover_rate: Number(turn.toFixed(2)),
      classic_trips: num(r.classic_trips),
      ebike_trips: num(r.ebike_trips),
      classic_share: num(r.classic_share),
      ebike_share: num(r.ebike_share),
      classic_revenue: num(r.classic_revenue),
      ebike_revenue: num(r.ebike_revenue),
      est_revenue: num(r.est_revenue),
      revenue_per_dock: num(r.revenue_per_dock),
      top_route: r.top_route ? String(r.top_route) : "",
      top_route_trips: num(r.top_route_trips),
      top_route_revenue: num(r.top_route_revenue)
    };
  });
}

function stats(rows) {
  const withTrips = rows.filter(r => r.trip_volume > 0).length;
  const trips = rows.reduce((a, r) => a + r.trip_volume, 0);
  return { stations: rows.length, withTrips, trips };
}

async function queryView(name) {
  const sql = `SELECT * FROM \`${CONFIG.projectId}.${CONFIG.datasetId}.${name}\``;
  const [rows] = await bigquery.query({ query: sql });
  return normalize(rows);
}

async function queryOptional(sql, label) {
  try {
    const [rows] = await bigquery.query({ query: sql });
    return rows || [];
  } catch (e) {
    console.warn("missing " + (label || "view") + ": " + e.message.split("\n")[0]);
    return [];
  }
}

function slotOf(r) {
  return String(r.time_window || r.peak_window || r.win || r.slot || r.window || "");
}

async function extras() {
  const fleet = (await queryOptional(
    `SELECT bike_type, trips, est_revenue, fare_per_trip, avg_min
     FROM \`${CONFIG.projectId}.${CONFIG.datasetId}.v_fleet_revenue\``,
    "v_fleet_revenue"
  )).map(r => ({
    bike_type: String(r.bike_type || ""),
    trips: num(r.trips),
    est_revenue: num(r.est_revenue),
    fare_per_trip: num(r.fare_per_trip),
    avg_min: num(r.avg_min)
  }));
  const routes = (await queryOptional(
    `SELECT route, bike_type, trips, est_revenue, avg_min
     FROM \`${CONFIG.projectId}.${CONFIG.datasetId}.v_route_revenue\`
     ORDER BY est_revenue DESC
     LIMIT 25`,
    "v_route_revenue"
  )).map(r => ({
    route: String(r.route || ""),
    bike_type: String(r.bike_type || ""),
    trips: num(r.trips),
    est_revenue: num(r.est_revenue),
    avg_min: num(r.avg_min)
  }));
  const riders = (await queryOptional(
    `SELECT rider, trips, est_revenue, fare_per_trip, avg_min, ebike_share, conversion_gap
     FROM \`${CONFIG.projectId}.${CONFIG.datasetId}.v_rider_revenue\``,
    "v_rider_revenue"
  )).map(r => ({
    rider: String(r.rider || ""),
    trips: num(r.trips),
    est_revenue: num(r.est_revenue),
    fare_per_trip: num(r.fare_per_trip),
    avg_min: num(r.avg_min),
    ebike_share: num(r.ebike_share),
    conversion_gap: num(r.conversion_gap)
  }));
  const hourRows = await queryOptional(
    `SELECT * FROM \`${CONFIG.projectId}.${CONFIG.datasetId}.v_hour_mix\``,
    "v_hour_mix"
  );
  if (hourRows[0] && !slotOf(hourRows[0])) {
    console.warn("hour columns: " + Object.keys(hourRows[0]).join(", "));
  }
  const hours = hourRows.map(r => ({
    hour: num(r.hour),
    window: slotOf(r),
    rider: String(r.rider || ""),
    trips: num(r.trips),
    est_revenue: num(r.est_revenue)
  }));
  const peakRows = await queryOptional(
    `SELECT * FROM \`${CONFIG.projectId}.${CONFIG.datasetId}.v_peak_routes\`
     ORDER BY est_revenue DESC
     LIMIT 80`,
    "v_peak_routes"
  );
  if (peakRows[0] && !slotOf(peakRows[0])) {
    console.warn("peak columns: " + Object.keys(peakRows[0]).join(", "));
  }
  const peakRoutes = peakRows.map(r => ({
    window: slotOf(r),
    rider: String(r.rider || ""),
    route: String(r.route || ""),
    trips: num(r.trips),
    est_revenue: num(r.est_revenue),
    avg_min: num(r.avg_min),
    ebike_share: num(r.ebike_share)
  }));
  const promo = (await queryOptional(
    `SELECT station_id, casual_share, conversion_gap, peak_casual_share, casual_trips, member_trips
     FROM \`${CONFIG.projectId}.${CONFIG.datasetId}.v_promo_targets\``,
    "v_promo_targets"
  )).map(r => ({
    station_id: String(r.station_id || ""),
    casual_share: num(r.casual_share),
    conversion_gap: num(r.conversion_gap),
    peak_casual_share: num(r.peak_casual_share),
    casual_trips: num(r.casual_trips),
    member_trips: num(r.member_trips)
  }));
  return { fleet, routes, riders, hours, peakRoutes, promo };
}

async function pushKv(rows, source, extra) {
  const s = stats(rows);
  const payload = {
    meta: {
      last_updated: new Date().toISOString(),
      total_stations: s.stations,
      project_id: CONFIG.projectId,
      source,
      period: extra && extra.fleet && extra.fleet.length ? "baywheels_202608_tariff" : "historic_public_sf_bikeshare",
      period_label: CONFIG.periodLabel || (extra && extra.fleet && extra.fleet.length ? "August 2026" : "Historic SF Bay Area Bike Share data"),
      period_days: CONFIG.periodDays || (extra && extra.fleet && extra.fleet.length ? 31 : 30),
      fare_note: "Estimated trip fare from published Jan 2026 Bay Wheels tariff. Not Lyft settlement. Excludes membership dues, tax, parking fees."
    },
    summary: {
      total_trips_recorded: s.trips,
      overridden_stations_count: rows.filter(r => r.is_overridden).length,
      stations_with_trips: s.withTrips,
      est_revenue: rows.reduce((a, r) => a + num(r.est_revenue), 0),
      ebike_share: s.trips ? rows.reduce((a, r) => a + num(r.ebike_trips), 0) / s.trips : 0
    },
    fleet: (extra && extra.fleet) || [],
    routes: (extra && extra.routes) || [],
    riders: (extra && extra.riders) || [],
    hours: (extra && extra.hours) || [],
    peak_routes: (extra && extra.peakRoutes) || [],
    data: rows
  };
  const { accountId, namespaceId, apiToken, kvKey } = CONFIG.cloudflare;
  if (!accountId || !namespaceId || !apiToken) {
    throw new Error("Missing KV_ACCOUNT_ID, KV_NAMESPACE_ID or KV_API_TOKEN in .env");
  }
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${kvKey}`;
  const response = await fetch(endpoint, {
    method: "PUT",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`Cloudflare KV Sync Failed (${response.status}): ${await response.text()}`);
  }
  return s;
}

export async function runPipeline() {
  console.log(`[${new Date().toISOString()}] Pipeline start ${CONFIG.projectId}`);
  try {
    let summary = [];
    let usage = [];
    try { summary = await queryView(CONFIG.viewName); } catch (e) { console.warn("summary view: " + e.message); }
    try { usage = await queryView(CONFIG.usageView); } catch (e) { console.warn("usage view: " + e.message); }

    const sSum = stats(summary);
    const sUse = stats(usage);
    console.log(`v_inventory_summary → ${sSum.stations} stations, ${sSum.withTrips} with trips, ${sSum.trips} rides`);
    console.log(`v_inventory_usage → ${sUse.stations} stations, ${sUse.withTrips} with trips, ${sUse.trips} rides`);

    const useUsage = sUse.trips > sSum.trips;
    let rows = useUsage ? usage : summary;
    let s = useUsage ? sUse : sSum;
    const source = useUsage ? CONFIG.usageView : CONFIG.viewName;

    if (s.trips === 0) {
      throw new Error(
        "Refusing to publish 0 rides to KV. That is what made 472 docks look idle. " +
        "Run sql/01_check_and_fix_inventory.sql in BigQuery, then node pipeline_engine.js again."
      );
    }

    const extra = await extras();
    if (extra.promo && extra.promo.length) {
      const by = {};
      extra.promo.forEach(p => { by[p.station_id] = p; });
      rows.forEach(r => {
        const p = by[r.station_id];
        if (!p) return;
        r.casual_share = p.casual_share;
        r.conversion_gap = p.conversion_gap;
        r.peak_casual_share = p.peak_casual_share;
        r.casual_trips = p.casual_trips;
        r.member_trips = p.member_trips;
      });
    }
    if (extra.fleet.length) {
      extra.fleet.forEach(f => console.log(`fleet ${f.bike_type} → ${f.trips} rides, $${Math.round(f.est_revenue)} est. fare`));
    }
    extra.riders.forEach(r => console.log(`rider ${r.rider} → ${r.trips} rides, $${Math.round(r.est_revenue)}`));
    console.log(`hours ${extra.hours.length} rows · peak routes ${extra.peakRoutes.length}`);
    if (!extra.riders.length) {
      console.log("");
      console.log("*** Fare desk and Peak corridors will be EMPTY. ***");
      console.log("Docks are in KV. Member vs casual is not.");
      console.log("Fix: run sql/05_rider_and_peaks.sql in BigQuery, then run.cmd again.");
      console.log("You must see lines: rider member →  and  rider casual →");
      console.log("");
    }
    if (extra.routes[0]) {
      console.log(`top route → ${extra.routes[0].route} ($${Math.round(extra.routes[0].est_revenue)})`);
    }

    const published = await pushKv(rows, source, extra);
    console.log(`KV updated. ${published.withTrips}/${published.stations} stations have rides.`);
  } catch (error) {
    console.error("Pipeline Run Failed:", error);
    process.exit(1);
  }
}

runPipeline();
