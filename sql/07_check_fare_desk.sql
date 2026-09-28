-- If this errors on v_rider_revenue, SQL 05 was not run (or failed).
SELECT "month_file" AS piece, COUNT(*) AS n
FROM `beaming-might-319312.dashboard_db.baywheels_trips_recent`
UNION ALL
SELECT "rider_view", COUNT(*) FROM `beaming-might-319312.dashboard_db.v_rider_revenue`
UNION ALL
SELECT "hour_view", COUNT(*) FROM `beaming-might-319312.dashboard_db.v_hour_mix`
UNION ALL
SELECT "peak_view", COUNT(*) FROM `beaming-might-319312.dashboard_db.v_peak_routes`;

SELECT rider, trips, est_revenue
FROM `beaming-might-319312.dashboard_db.v_rider_revenue`;
