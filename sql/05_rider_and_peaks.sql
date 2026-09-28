-- Member vs casual + peak corridors.
-- Run AFTER 04 (needs trip_fares). Does not touch live tables.

-- Rebuild fares with clock fields and a "if they had a pass" counterfactual.
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
),
scored AS (
  SELECT
    *,
    CASE
      WHEN rideable_type LIKE '%electric%' OR rideable_type LIKE '%ebike%' OR rideable_type LIKE '%e-bike%'
        THEN 'ebike' ELSE 'classic'
    END AS bike_type,
    CASE WHEN member_casual IN ('member', 'subscriber') THEN 'member' ELSE 'casual' END AS rider,
    LEAST(GREATEST(TIMESTAMP_DIFF(ended_at, started_at, SECOND) / 60.0, 1), 180) AS minutes,
    EXTRACT(HOUR FROM started_at) AS hour,
    EXTRACT(DAYOFWEEK FROM started_at) AS dow
  FROM raw
  WHERE origin_id IS NOT NULL AND started_at IS NOT NULL AND ended_at IS NOT NULL AND ended_at > started_at
)
SELECT
  origin_id, dest_id, origin_name, dest_name, bike_type, rider, minutes, hour, dow,
  EXTRACT(DAYOFWEEK FROM started_at) BETWEEN 2 AND 6 AS is_weekday,
  CASE
    WHEN EXTRACT(DAYOFWEEK FROM started_at) NOT BETWEEN 2 AND 6 THEN 'weekend'
    WHEN hour >= 7 AND hour < 10 THEN 'am_peak'
    WHEN hour >= 16 AND hour < 19 THEN 'pm_peak'
    WHEN hour >= 10 AND hour < 16 THEN 'midday'
    ELSE 'off_peak'
  END AS window,
  CASE
    WHEN rider = 'member' AND bike_type = 'ebike' THEN 0.17 * minutes
    WHEN rider = 'member' THEN GREATEST(minutes - 45, 0) * 0.17
    WHEN bike_type = 'ebike' THEN 1.00 + 0.49 * minutes
    ELSE 1.00 + 0.19 * minutes
  END AS est_fare,
  -- Same ride, priced as a monthly member (conversion what-if)
  CASE
    WHEN bike_type = 'ebike' THEN 0.17 * minutes
    ELSE GREATEST(minutes - 45, 0) * 0.17
  END AS fare_if_member
FROM scored;

CREATE OR REPLACE VIEW `beaming-might-319312.dashboard_db.v_rider_revenue` AS
SELECT
  rider,
  COUNT(*) AS trips,
  ROUND(SUM(est_fare), 2) AS est_revenue,
  ROUND(AVG(est_fare), 2) AS fare_per_trip,
  ROUND(AVG(minutes), 1) AS avg_min,
  COUNTIF(bike_type = 'ebike') AS ebike_trips,
  ROUND(SAFE_DIVIDE(COUNTIF(bike_type = 'ebike'), COUNT(*)), 3) AS ebike_share,
  ROUND(SUM(est_fare - fare_if_member), 2) AS conversion_gap
FROM `beaming-might-319312.dashboard_db.trip_fares`
GROUP BY 1;

CREATE OR REPLACE VIEW `beaming-might-319312.dashboard_db.v_hour_mix` AS
SELECT
  hour,
  window,
  rider,
  COUNT(*) AS trips,
  ROUND(SUM(est_fare), 2) AS est_revenue
FROM `beaming-might-319312.dashboard_db.trip_fares`
GROUP BY 1, 2, 3;

CREATE OR REPLACE VIEW `beaming-might-319312.dashboard_db.v_peak_routes` AS
SELECT
  window,
  rider,
  CONCAT(IFNULL(origin_name, 'Undocked'), ' → ', IFNULL(dest_name, 'Undocked')) AS route,
  COUNT(*) AS trips,
  ROUND(SUM(est_fare), 2) AS est_revenue,
  ROUND(AVG(minutes), 1) AS avg_min,
  ROUND(SAFE_DIVIDE(COUNTIF(bike_type = 'ebike'), COUNT(*)), 3) AS ebike_share
FROM `beaming-might-319312.dashboard_db.trip_fares`
WHERE origin_name IS NOT NULL AND dest_name IS NOT NULL
GROUP BY 1, 2, 3;

CREATE OR REPLACE VIEW `beaming-might-319312.dashboard_db.v_promo_targets` AS
SELECT
  origin_id AS station_id,
  ANY_VALUE(origin_name) AS station_name,
  COUNT(*) AS trips,
  COUNTIF(rider = 'casual') AS casual_trips,
  COUNTIF(rider = 'member') AS member_trips,
  ROUND(SAFE_DIVIDE(COUNTIF(rider = 'casual'), COUNT(*)), 3) AS casual_share,
  ROUND(SUM(est_fare), 2) AS est_revenue,
  ROUND(SUM(IF(rider = 'casual', est_fare - fare_if_member, 0)), 2) AS conversion_gap,
  COUNTIF(window IN ('am_peak', 'pm_peak')) AS peak_trips,
  ROUND(SAFE_DIVIDE(COUNTIF(rider = 'casual' AND window IN ('am_peak', 'pm_peak')), COUNTIF(window IN ('am_peak', 'pm_peak'))), 3) AS peak_casual_share
FROM `beaming-might-319312.dashboard_db.trip_fares`
GROUP BY 1;

-- Confirm
SELECT 'rider' AS slice, rider AS name, trips, est_revenue, conversion_gap
FROM `beaming-might-319312.dashboard_db.v_rider_revenue`
UNION ALL
SELECT 'peak_route', route, trips, est_revenue, 0
FROM `beaming-might-319312.dashboard_db.v_peak_routes`
WHERE window = 'am_peak'
ORDER BY est_revenue DESC
LIMIT 10;
