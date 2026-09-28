-- After you upload August 2026 Bay Wheels trips (see click-by-click),
-- join today's dock ids to a current month. That is how 407 recover.

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
recent AS (
  SELECT
    CAST(start_station_id AS STRING) AS station_id,
    LOWER(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(start_station_name, r'\s*\(.*\)', ''), r'[^a-zA-Z0-9 ]', ' '))) AS nm,
    TIMESTAMP_DIFF(ended_at, started_at, SECOND) AS duration_sec
  FROM `beaming-might-319312.dashboard_db.baywheels_trips_recent`
  WHERE start_station_id IS NOT NULL
  UNION ALL
  SELECT
    CAST(end_station_id AS STRING),
    LOWER(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(end_station_name, r'\s*\(.*\)', ''), r'[^a-zA-Z0-9 ]', ' '))),
    TIMESTAMP_DIFF(ended_at, started_at, SECOND)
  FROM `beaming-might-319312.dashboard_db.baywheels_trips_recent`
  WHERE end_station_id IS NOT NULL
),
agg_id AS (
  SELECT station_id, COUNT(*) AS trip_volume, AVG(duration_sec) / 60 AS avg_duration_min
  FROM recent
  GROUP BY 1
),
agg_name AS (
  SELECT nm, COUNT(*) AS trip_volume, AVG(duration_sec) / 60 AS avg_duration_min
  FROM recent
  WHERE nm IS NOT NULL AND nm != ''
  GROUP BY 1
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
  ) AS usage_turnover_rate
FROM clean c
LEFT JOIN agg_id i USING (station_id)
LEFT JOIN agg_name n ON n.nm = c.nm;
