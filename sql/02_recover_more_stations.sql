-- Recover more than 65 docks. Safe objects only.
-- Project: beaming-might-319312
--
-- Why 65: v_inventory_usage only used 2013–2016 Ford GoBike (~70 docks).
-- The other public table has ~300 docks. Fuzzy names pick up renamed racks.
-- Docks built after that era still need a 2026 Bay Wheels month (query E).

-- A) Ceiling check — run this first, send the one-row result
WITH inv AS (
  SELECT
    CAST(station_id AS STRING) AS station_id,
    LOWER(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(station_name, r'\s*\(.*\)', ''), r'[^a-zA-Z0-9 ]', ' '))) AS nm
  FROM `beaming-might-319312.dashboard_db.station_inventory`
),
old_pub AS (
  SELECT DISTINCT CAST(start_station_id AS STRING) AS station_id,
    LOWER(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(start_station_name, r'\s*\(.*\)', ''), r'[^a-zA-Z0-9 ]', ' '))) AS nm
  FROM `bigquery-public-data.san_francisco.bikeshare_trips`
),
new_pub AS (
  SELECT DISTINCT CAST(start_station_id AS STRING) AS station_id,
    LOWER(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(start_station_name, r'\s*\(.*\)', ''), r'[^a-zA-Z0-9 ]', ' '))) AS nm
  FROM `bigquery-public-data.san_francisco_bikeshare.bikeshare_trips`
),
fuzzy AS (
  SELECT i.station_id, MIN(EDIT_DISTANCE(i.nm, p.nm)) AS d
  FROM inv i
  CROSS JOIN (SELECT DISTINCT nm FROM new_pub UNION DISTINCT SELECT nm FROM old_pub) p
  GROUP BY 1
)
SELECT
  (SELECT COUNT(*) FROM inv) AS inventory_docks,
  (SELECT COUNT(*) FROM old_pub) AS old_public_docks,
  (SELECT COUNT(*) FROM new_pub) AS gobike_public_docks,
  (SELECT COUNT(*) FROM inv i JOIN old_pub p USING (station_id)) AS match_old_id,
  (SELECT COUNT(*) FROM inv i JOIN new_pub p USING (station_id)) AS match_gobike_id,
  (SELECT COUNT(*) FROM inv i JOIN (SELECT DISTINCT nm FROM new_pub UNION DISTINCT SELECT nm FROM old_pub) p ON i.nm = p.nm) AS match_exact_name,
  (SELECT COUNT(*) FROM fuzzy WHERE d <= 4) AS match_fuzzy_name_le4;

-- B) Rebuild usage from BOTH public tables, starts+ends, id then exact name then fuzzy <= 4
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
raw_trips AS (
  SELECT CAST(start_station_id AS STRING) AS station_id, start_station_name AS station_name, duration_sec
  FROM `bigquery-public-data.san_francisco_bikeshare.bikeshare_trips`
  UNION ALL
  SELECT CAST(end_station_id AS STRING), end_station_name, duration_sec
  FROM `bigquery-public-data.san_francisco_bikeshare.bikeshare_trips`
  UNION ALL
  SELECT CAST(start_station_id AS STRING), start_station_name, duration_sec
  FROM `bigquery-public-data.san_francisco.bikeshare_trips`
  UNION ALL
  SELECT CAST(end_station_id AS STRING), end_station_name, duration_sec
  FROM `bigquery-public-data.san_francisco.bikeshare_trips`
),
pub AS (
  SELECT
    station_id,
    LOWER(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(ANY_VALUE(station_name), r'\s*\(.*\)', ''), r'[^a-zA-Z0-9 ]', ' '))) AS nm,
    COUNT(*) AS trip_volume,
    AVG(duration_sec) / 60 AS avg_duration_min
  FROM raw_trips
  WHERE station_id IS NOT NULL
  GROUP BY 1
),
by_id AS (
  SELECT c.station_id, p.trip_volume, p.avg_duration_min
  FROM clean c
  JOIN pub p ON p.station_id = c.station_id
),
by_name AS (
  SELECT c.station_id, p.trip_volume, p.avg_duration_min
  FROM clean c
  JOIN (
    SELECT nm, SUM(trip_volume) AS trip_volume,
      SUM(avg_duration_min * trip_volume) / SUM(trip_volume) AS avg_duration_min
    FROM pub
    GROUP BY 1
  ) p ON p.nm = c.nm
),
by_fuzzy AS (
  SELECT
    c.station_id,
    p.trip_volume,
    p.avg_duration_min,
    EDIT_DISTANCE(c.nm, p.nm) AS d
  FROM clean c
  JOIN (
    SELECT nm, SUM(trip_volume) AS trip_volume,
      SUM(avg_duration_min * trip_volume) / SUM(trip_volume) AS avg_duration_min
    FROM pub
    WHERE nm IS NOT NULL AND nm != ''
    GROUP BY 1
  ) p
  ON EDIT_DISTANCE(c.nm, p.nm) BETWEEN 1 AND 4
  QUALIFY ROW_NUMBER() OVER (PARTITION BY c.station_id ORDER BY EDIT_DISTANCE(c.nm, p.nm), p.trip_volume DESC) = 1
)
SELECT
  c.station_id,
  c.station_name,
  c.capacity,
  c.is_overridden,
  CAST(IFNULL(COALESCE(i.trip_volume, n.trip_volume, f.trip_volume), 0) AS INT64) AS trip_volume,
  IFNULL(COALESCE(i.avg_duration_min, n.avg_duration_min, f.avg_duration_min), 0) AS avg_duration_min,
  SAFE_DIVIDE(
    IFNULL(COALESCE(i.trip_volume, n.trip_volume, f.trip_volume), 0),
    NULLIF(c.capacity, 0)
  ) AS usage_turnover_rate
FROM clean c
LEFT JOIN by_id i USING (station_id)
LEFT JOIN by_name n USING (station_id)
LEFT JOIN by_fuzzy f USING (station_id);

-- C) Recount — this is the number Node will copy
SELECT
  COUNT(*) AS stations,
  COUNTIF(trip_volume > 0) AS with_trips,
  SUM(trip_volume) AS trips
FROM `beaming-might-319312.dashboard_db.v_inventory_usage`;
