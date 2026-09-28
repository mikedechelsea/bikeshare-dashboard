-- Map layers for the dashboard's 3D map.
-- Run AFTER 05 (needs trip_fares) and after the August 2026 trips are loaded
-- (uses start/end lat/lng from baywheels_trips_recent). Safe objects only.

-- A) One point per station: median of the GPS positions riders started/ended at,
--    plus departures, arrivals, fare and the station's top-earning route.
CREATE OR REPLACE VIEW `beaming-might-319312.dashboard_db.v_station_geo` AS
WITH pts AS (
  SELECT
    CAST(start_station_id AS STRING) AS station_id,
    CAST(start_station_name AS STRING) AS station_name,
    SAFE_CAST(start_lat AS FLOAT64) AS lat,
    SAFE_CAST(start_lng AS FLOAT64) AS lng
  FROM `beaming-might-319312.dashboard_db.baywheels_trips_recent`
  WHERE start_station_id IS NOT NULL
  UNION ALL
  SELECT
    CAST(end_station_id AS STRING),
    CAST(end_station_name AS STRING),
    SAFE_CAST(end_lat AS FLOAT64),
    SAFE_CAST(end_lng AS FLOAT64)
  FROM `beaming-might-319312.dashboard_db.baywheels_trips_recent`
  WHERE end_station_id IS NOT NULL
),
loc AS (
  SELECT
    station_id,
    ANY_VALUE(station_name) AS station_name,
    APPROX_QUANTILES(lat, 2)[OFFSET(1)] AS lat,
    APPROX_QUANTILES(lng, 2)[OFFSET(1)] AS lng
  FROM pts
  WHERE lat BETWEEN 37.2 AND 38.2 AND lng BETWEEN -122.8 AND -121.6
  GROUP BY 1
),
dep AS (
  SELECT
    origin_id AS station_id,
    COUNT(*) AS departures,
    ROUND(SUM(est_fare), 2) AS est_revenue,
    ROUND(SAFE_DIVIDE(COUNTIF(bike_type = 'ebike'), COUNT(*)), 3) AS ebike_share,
    ROUND(SAFE_DIVIDE(COUNTIF(rider = 'casual'), COUNT(*)), 3) AS casual_share
  FROM `beaming-might-319312.dashboard_db.trip_fares`
  GROUP BY 1
),
arr AS (
  SELECT dest_id AS station_id, COUNT(*) AS arrivals
  FROM `beaming-might-319312.dashboard_db.trip_fares`
  WHERE dest_id IS NOT NULL
  GROUP BY 1
),
top_rt AS (
  SELECT
    origin_id AS station_id,
    CONCAT(origin_name, ' → ', dest_name) AS top_route
  FROM `beaming-might-319312.dashboard_db.trip_fares`
  WHERE origin_name IS NOT NULL AND dest_name IS NOT NULL
  GROUP BY origin_id, origin_name, dest_name
  QUALIFY ROW_NUMBER() OVER (PARTITION BY origin_id ORDER BY SUM(est_fare) DESC) = 1
)
SELECT
  l.station_id,
  l.station_name,
  ROUND(l.lat, 6) AS lat,
  ROUND(l.lng, 6) AS lng,
  IFNULL(d.departures, 0) AS departures,
  IFNULL(a.arrivals, 0) AS arrivals,
  IFNULL(d.est_revenue, 0) AS est_revenue,
  d.ebike_share,
  d.casual_share,
  t.top_route
FROM loc l
LEFT JOIN dep d USING (station_id)
LEFT JOIN arr a USING (station_id)
LEFT JOIN top_rt t USING (station_id);

-- B) Departures per station per hour of day (drives the column heights on the map)
CREATE OR REPLACE VIEW `beaming-might-319312.dashboard_db.v_station_hour` AS
SELECT
  origin_id AS station_id,
  hour,
  COUNT(*) AS trips,
  COUNTIF(bike_type = 'ebike') AS ebike_trips
FROM `beaming-might-319312.dashboard_db.trip_fares`
GROUP BY 1, 2;

-- C) Origin → destination flows (the pipeline keeps the busiest few hundred for the animation)
CREATE OR REPLACE VIEW `beaming-might-319312.dashboard_db.v_top_flows` AS
SELECT
  origin_id,
  dest_id,
  COUNT(*) AS trips,
  COUNTIF(bike_type = 'ebike') AS ebike_trips,
  COUNTIF(rider = 'casual') AS casual_trips,
  ROUND(SUM(est_fare), 2) AS est_revenue,
  ROUND(AVG(minutes), 1) AS avg_min
FROM `beaming-might-319312.dashboard_db.trip_fares`
WHERE dest_id IS NOT NULL
GROUP BY 1, 2;

-- D) Round trips (start and end at the same station) vs everything else
CREATE OR REPLACE VIEW `beaming-might-319312.dashboard_db.v_round_trips` AS
SELECT
  COUNT(*) AS trips,
  COUNTIF(origin_id = dest_id) AS round_trips,
  ROUND(SUM(est_fare), 2) AS est_revenue,
  ROUND(SUM(IF(origin_id = dest_id, est_fare, 0)), 2) AS round_trip_revenue,
  COUNTIF(origin_id = dest_id AND rider = 'casual') AS round_trips_casual,
  ROUND(SUM(IF(rider = 'casual', est_fare, 0)), 2) AS casual_revenue,
  ROUND(SUM(IF(origin_id = dest_id AND rider = 'casual', est_fare, 0)), 2) AS round_trip_casual_revenue
FROM `beaming-might-319312.dashboard_db.trip_fares`;

-- E) Confirm (expect a few hundred stations with coordinates and one row per station-hour)
SELECT 'stations_with_coords' AS piece, COUNT(*) AS n FROM `beaming-might-319312.dashboard_db.v_station_geo`
UNION ALL
SELECT 'station_hours', COUNT(*) FROM `beaming-might-319312.dashboard_db.v_station_hour`
UNION ALL
SELECT 'flows', COUNT(*) FROM `beaming-might-319312.dashboard_db.v_top_flows`;
