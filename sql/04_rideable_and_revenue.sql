-- Ride type + estimated fare from August 2026 Bay Wheels trips.
-- Project: beaming-might-319312. Safe objects only.
--
-- This is NOT Lyft settlement. It is trip-level fare from the published
-- Jan 2026 tariff, excluding membership dues, tax, and out-of-dock fees.
--
-- Casual classic: $1 unlock + $0.19/min
-- Casual e-bike:  $1 unlock + $0.49/min
-- Member classic: first 45 min $0, then $0.17/min
-- Member e-bike:  $0 unlock + $0.17/min
-- Duration capped at 180 min so broken clocks do not mint $500 rides.

-- A) Peek the uploaded table (fail here if the CSV is not loaded yet)
SELECT
  COUNT(*) AS rows_loaded,
  COUNT(DISTINCT start_station_id) AS origin_docks,
  COUNTIF(LOWER(CAST(rideable_type AS STRING)) LIKE '%electric%') AS ebike_rows,
  COUNTIF(LOWER(CAST(member_casual AS STRING)) IN ('member', 'subscriber')) AS member_rows
FROM `beaming-might-319312.dashboard_db.baywheels_trips_recent`;

-- B) Score every ride
CREATE OR REPLACE TABLE `beaming-might-319312.dashboard_db.trip_fares` AS
WITH raw AS (
  SELECT
    CAST(start_station_id AS STRING) AS origin_id,
    CAST(end_station_id AS STRING) AS dest_id,
    CAST(start_station_name AS STRING) AS origin_name,
    CAST(end_station_name AS STRING) AS dest_name,
    LOWER(CAST(rideable_type AS STRING)) AS rideable_type,
    LOWER(CAST(member_casual AS STRING)) AS member_casual,
    COALESCE(
      SAFE_CAST(started_at AS TIMESTAMP),
      SAFE.PARSE_TIMESTAMP('%Y-%m-%d %H:%M:%S', CAST(started_at AS STRING)),
      SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*S', CAST(started_at AS STRING))
    ) AS started_at,
    COALESCE(
      SAFE_CAST(ended_at AS TIMESTAMP),
      SAFE.PARSE_TIMESTAMP('%Y-%m-%d %H:%M:%S', CAST(ended_at AS STRING)),
      SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*S', CAST(ended_at AS STRING))
    ) AS ended_at
  FROM `beaming-might-319312.dashboard_db.baywheels_trips_recent`
)
SELECT
  origin_id,
  dest_id,
  origin_name,
  dest_name,
  CASE
    WHEN rideable_type LIKE '%electric%' OR rideable_type LIKE '%ebike%' OR rideable_type LIKE '%e-bike%'
      THEN 'ebike'
    ELSE 'classic'
  END AS bike_type,
  CASE
    WHEN member_casual IN ('member', 'subscriber') THEN 'member'
    ELSE 'casual'
  END AS rider,
  LEAST(
    GREATEST(TIMESTAMP_DIFF(ended_at, started_at, SECOND) / 60.0, 1),
    180
  ) AS minutes,
  CASE
    WHEN (rideable_type LIKE '%electric%' OR rideable_type LIKE '%ebike%')
      AND member_casual IN ('member', 'subscriber')
      THEN 0.17 * LEAST(GREATEST(TIMESTAMP_DIFF(ended_at, started_at, SECOND) / 60.0, 1), 180)
    WHEN member_casual IN ('member', 'subscriber')
      THEN GREATEST(LEAST(GREATEST(TIMESTAMP_DIFF(ended_at, started_at, SECOND) / 60.0, 1), 180) - 45, 0) * 0.17
    WHEN rideable_type LIKE '%electric%' OR rideable_type LIKE '%ebike%'
      THEN 1.00 + 0.49 * LEAST(GREATEST(TIMESTAMP_DIFF(ended_at, started_at, SECOND) / 60.0, 1), 180)
    ELSE 1.00 + 0.19 * LEAST(GREATEST(TIMESTAMP_DIFF(ended_at, started_at, SECOND) / 60.0, 1), 180)
  END AS est_fare
FROM raw
WHERE origin_id IS NOT NULL
  AND started_at IS NOT NULL
  AND ended_at IS NOT NULL
  AND ended_at > started_at;

-- C) Bike type leaderboard
CREATE OR REPLACE VIEW `beaming-might-319312.dashboard_db.v_fleet_revenue` AS
SELECT
  bike_type,
  COUNT(*) AS trips,
  ROUND(SUM(est_fare), 2) AS est_revenue,
  ROUND(AVG(est_fare), 2) AS fare_per_trip,
  ROUND(AVG(minutes), 1) AS avg_min
FROM `beaming-might-319312.dashboard_db.trip_fares`
GROUP BY 1;

-- D) Named routes (origin → destination)
CREATE OR REPLACE VIEW `beaming-might-319312.dashboard_db.v_route_revenue` AS
SELECT
  origin_name,
  dest_name,
  CONCAT(IFNULL(origin_name, 'Undocked'), ' → ', IFNULL(dest_name, 'Undocked')) AS route,
  bike_type,
  COUNT(*) AS trips,
  ROUND(SUM(est_fare), 2) AS est_revenue,
  ROUND(AVG(minutes), 1) AS avg_min
FROM `beaming-might-319312.dashboard_db.trip_fares`
WHERE origin_name IS NOT NULL AND dest_name IS NOT NULL
GROUP BY 1, 2, 3, 4;

-- E) Rebuild station usage with mix + fare (starts only — one ride, one fare)
CREATE OR REPLACE VIEW `beaming-might-319312.dashboard_db.v_inventory_usage` AS
WITH
clean AS (
  SELECT
    CAST(station_id AS STRING) AS station_id,
    station_name,
    CAST(capacity AS FLOAT64) AS capacity,
    CAST(IFNULL(is_overridden, FALSE) AS BOOL) AS is_overridden,
    LOWER(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(station_name, r'\s*\(.*\)', ''), r'[^a-zA-Z0-9 ]', ' '))) AS nm
  FROM `beaming-might-319312.dashboard_db.station_inventory`
),
by_id AS (
  SELECT
    origin_id AS station_id,
    COUNT(*) AS trip_volume,
    AVG(minutes) AS avg_duration_min,
    COUNTIF(bike_type = 'classic') AS classic_trips,
    COUNTIF(bike_type = 'ebike') AS ebike_trips,
    SUM(IF(bike_type = 'classic', est_fare, 0)) AS classic_revenue,
    SUM(IF(bike_type = 'ebike', est_fare, 0)) AS ebike_revenue,
    SUM(est_fare) AS est_revenue
  FROM `beaming-might-319312.dashboard_db.trip_fares`
  GROUP BY 1
),
by_name AS (
  SELECT
    LOWER(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(origin_name, r'\s*\(.*\)', ''), r'[^a-zA-Z0-9 ]', ' '))) AS nm,
    COUNT(*) AS trip_volume,
    AVG(minutes) AS avg_duration_min,
    COUNTIF(bike_type = 'classic') AS classic_trips,
    COUNTIF(bike_type = 'ebike') AS ebike_trips,
    SUM(IF(bike_type = 'classic', est_fare, 0)) AS classic_revenue,
    SUM(IF(bike_type = 'ebike', est_fare, 0)) AS ebike_revenue,
    SUM(est_fare) AS est_revenue
  FROM `beaming-might-319312.dashboard_db.trip_fares`
  WHERE origin_name IS NOT NULL
  GROUP BY 1
),
top_rt AS (
  SELECT
    origin_id AS station_id,
    CONCAT(origin_name, ' → ', dest_name) AS top_route,
    COUNT(*) AS top_route_trips,
    SUM(est_fare) AS top_route_revenue
  FROM `beaming-might-319312.dashboard_db.trip_fares`
  WHERE origin_name IS NOT NULL AND dest_name IS NOT NULL
  GROUP BY 1, 2
  QUALIFY ROW_NUMBER() OVER (PARTITION BY origin_id ORDER BY SUM(est_fare) DESC) = 1
)
SELECT
  c.station_id,
  c.station_name,
  c.capacity,
  c.is_overridden,
  CAST(IFNULL(COALESCE(i.trip_volume, n.trip_volume), 0) AS INT64) AS trip_volume,
  IFNULL(COALESCE(i.avg_duration_min, n.avg_duration_min), 0) AS avg_duration_min,
  SAFE_DIVIDE(
    IFNULL(COALESCE(i.trip_volume, n.trip_volume), 0),
    NULLIF(c.capacity, 0)
  ) AS usage_turnover_rate,
  CAST(IFNULL(COALESCE(i.classic_trips, n.classic_trips), 0) AS INT64) AS classic_trips,
  CAST(IFNULL(COALESCE(i.ebike_trips, n.ebike_trips), 0) AS INT64) AS ebike_trips,
  SAFE_DIVIDE(IFNULL(COALESCE(i.classic_trips, n.classic_trips), 0), NULLIF(COALESCE(i.trip_volume, n.trip_volume), 0)) AS classic_share,
  SAFE_DIVIDE(IFNULL(COALESCE(i.ebike_trips, n.ebike_trips), 0), NULLIF(COALESCE(i.trip_volume, n.trip_volume), 0)) AS ebike_share,
  ROUND(IFNULL(COALESCE(i.classic_revenue, n.classic_revenue), 0), 2) AS classic_revenue,
  ROUND(IFNULL(COALESCE(i.ebike_revenue, n.ebike_revenue), 0), 2) AS ebike_revenue,
  ROUND(IFNULL(COALESCE(i.est_revenue, n.est_revenue), 0), 2) AS est_revenue,
  ROUND(SAFE_DIVIDE(IFNULL(COALESCE(i.est_revenue, n.est_revenue), 0), NULLIF(c.capacity, 0)), 2) AS revenue_per_dock,
  r.top_route,
  CAST(IFNULL(r.top_route_trips, 0) AS INT64) AS top_route_trips,
  ROUND(IFNULL(r.top_route_revenue, 0), 2) AS top_route_revenue
FROM clean c
LEFT JOIN by_id i USING (station_id)
LEFT JOIN by_name n ON n.nm = c.nm
LEFT JOIN top_rt r USING (station_id);

-- F) Confirm
SELECT 'fleet' AS slice, bike_type AS name, trips, est_revenue FROM `beaming-might-319312.dashboard_db.v_fleet_revenue`
UNION ALL
SELECT 'top_route', route, trips, est_revenue
FROM `beaming-might-319312.dashboard_db.v_route_revenue`
ORDER BY est_revenue DESC
LIMIT 8;

SELECT
  COUNT(*) AS stations,
  COUNTIF(trip_volume > 0) AS with_trips,
  SUM(trip_volume) AS trips,
  ROUND(SUM(est_revenue), 0) AS est_fare,
  ROUND(AVG(ebike_share), 3) AS avg_ebike_share
FROM `beaming-might-319312.dashboard_db.v_inventory_usage`;
