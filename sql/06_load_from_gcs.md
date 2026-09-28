# Load August 2026 trips (file is over BigQuery’s 100MB upload cap)

Do this in **Cloud Shell** (the terminal in the Google Cloud website). It is not PowerShell, so Avast will not block it. Google downloads the zip from Lyft’s bucket — your home internet does not have to push 150MB.

## Cloud Shell (best)

1. Open [Google Cloud Console](https://console.cloud.google.com/?project=beaming-might-319312).
2. Confirm the project at the top is **My First Project** / `beaming-might-319312`.
3. Click the **Cloud Shell** icon (top right, looks like `>_`).
4. Click **Continue** if it asks to authorize.
5. Paste this whole block, press Enter, wait (2–5 minutes):

```bash
set -e
PROJECT=beaming-might-319312
BUCKET=${PROJECT}-bikeshare
cd ~
curl -L -o bay.zip "https://s3.amazonaws.com/baywheels-data/202608-baywheels-tripdata.csv.zip"
unzip -o bay.zip
CSV=$(ls -1 *tripdata*.csv | head -1)
echo "Using $CSV"
gsutil mb -p "$PROJECT" -l US "gs://${BUCKET}" 2>/dev/null || true
gsutil cp "$CSV" "gs://${BUCKET}/202608-baywheels.csv"
bq load \
  --project_id="$PROJECT" \
  --autodetect \
  --source_format=CSV \
  --skip_leading_rows=1 \
  --replace \
  ${PROJECT}:dashboard_db.baywheels_trips_recent \
  "gs://${BUCKET}/202608-baywheels.csv"
echo "DONE"
bq query --project_id="$PROJECT" --use_legacy_sql=false \
  'SELECT COUNT(*) AS rows_loaded, COUNT(DISTINCT start_station_id) AS docks FROM `beaming-might-319312.dashboard_db.baywheels_trips_recent`'
```

6. You want `DONE` and a row count in the tens or hundreds of thousands.
7. Then run `04_rideable_and_revenue.sql` and `05_rider_and_peaks.sql` in the BigQuery editor as before.

If Cloud Shell says the bucket name is taken, change `BUCKET=${PROJECT}-bikeshare` to `BUCKET=${PROJECT}-bikeshare2` and paste again.

## Already have the unzipped CSV on the PC

Cloud Storage browser has no 100MB cap.

1. Console → **Cloud Storage** → **Buckets** → **Create** (name `beaming-might-319312-bikeshare`, location US).
2. Open the bucket → **Upload files** → pick the `.csv` (not the zip).
3. BigQuery → `dashboard_db` → **Create table**.
4. Source: **Google Cloud Storage**.
5. URI: `gs://beaming-might-319312-bikeshare/YOURFILE.csv`
6. Table name: `baywheels_trips_recent`.
7. Schema: **Auto detect**. Format: CSV. Skip 1 header row. Create.

Do **not** use Google Drive as the source. Drive→BigQuery is capped even lower.
