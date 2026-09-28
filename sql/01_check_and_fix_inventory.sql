-- Project: beaming-might-319312
-- Safe objects only. Does not replace live tables.

-- A) What Node is copying today
SELECT
  COUNT(*) AS stations,
  COUNTIF(IFNULL(trip_volume, 0) > 0) AS with_trips,
  IFNULL(SUM(trip_volume), 0) AS trips
FROM `beaming-might-319312.dashboard_db.v_inventory_summary`;

-- B) Freeze the station list into a new table (new name, nothing live is overwritten)
CREATE OR REPLACE TABLE `beaming-might-319312.dashboard_db.station_inventory` AS
SELECT
  CAST(station_id AS STRING) AS station_id,
  station_name,
  CAST(capacity AS FLOAT64) AS capacity,
  CAST(IFNULL(is_overridden, FALSE) AS BOOL) AS is_overridden
FROM `beaming-might-319312.dashboard_db.v_inventory_summary`;

-- C) New usage view: stations + public Bay Area rides (2013–2016 Ford GoBike).
--    Join on station_id first, then on cleaned name.
CREATE OR REPLACE VIEW `beaming-might-319312.dashboard_db.v_inventory_usage` AS
WITH trips_id AS (
  SELECT
    CAST(start_station_id AS STRING) AS station_id,
    COUNT(*) AS trip_volume,
    AVG(duration_sec) / 60 AS avg_duration_min
  FROM `bigquery-public-data.san_francisco.bikeshare_trips`
  GROUP BY 1
),
trips_name AS (
  SELECT
    LOWER(TRIM(start_station_name)) AS station_name,
    COUNT(*) AS trip_volume,
    AVG(duration_sec) / 60 AS avg_duration_min
  FROM `bigquery-public-data.san_francisco.bikeshare_trips`
  GROUP BY 1
)
SELECT
  s.station_id,
  s.station_name,
  s.capacity,
  s.is_overridden,
  IFNULL(COALESCE(tid.trip_volume, tnm.trip_volume), 0) AS trip_volume,
  IFNULL(COALESCE(tid.avg_duration_min, tnm.avg_duration_min), 0) AS avg_duration_min,
  SAFE_DIVIDE(
    IFNULL(COALESCE(tid.trip_volume, tnm.trip_volume), 0),
    NULLIF(s.capacity, 0)
  ) AS usage_turnover_rate
FROM `beaming-might-319312.dashboard_db.station_inventory` s
LEFT JOIN trips_id tid
  ON tid.station_id = s.station_id
LEFT JOIN trips_name tnm
  ON tnm.station_name = LOWER(TRIM(REGEXP_REPLACE(s.station_name, r'\s*\(.*\)$', '')));

-- D) Confirm the new view has rides before you run Node again
SELECT
  COUNT(*) AS stations,
  COUNTIF(trip_volume > 0) AS with_trips,
  SUM(trip_volume) AS trips
FROM `beaming-might-319312.dashboard_db.v_inventory_usage`;
