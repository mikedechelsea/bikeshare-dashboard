export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Route 1: GET /api/inventory -> Read pre-computed data from KV
    if (url.pathname === '/api/inventory' && request.method === 'GET') {
      const kvData = await env.INVENTORY_KV.get('inventory_dashboard_data', { type: 'json' });
      return new Response(JSON.stringify(kvData || { data: [], meta: {} }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // Route 2: POST /api/action -> Handle interactive writes (overrides/alerts)
    if (url.pathname === '/api/action' && request.method === 'POST') {
      try {
        const body = await request.json();
        const actionPayload = {
          action_id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          station_id: String(body.station_id || ''),
          action_type: body.action_type,
          payload: JSON.stringify(body.details || {}),
          user_email: body.user_email || 'operator@dashboard'
        };

        // A. Optimistically update KV cache state
        const currentData = await env.INVENTORY_KV.get('inventory_dashboard_data', { type: 'json' });
        if (currentData && currentData.data && body.action_type === 'STATUS_OVERRIDE') {
          const station = currentData.data.find(s => String(s.station_id) === String(body.station_id));
          if (station) {
            station.capacity = body.details.new_capacity;
            station.is_overridden = true;
            station.usage_turnover_rate = Number((station.trip_volume / body.details.new_capacity).toFixed(2));
          }
          await env.INVENTORY_KV.put('inventory_dashboard_data', JSON.stringify(currentData));
        }

        // B. Stream user action asynchronously into BigQuery
        await streamToBigQuery(actionPayload, env);

        return new Response(JSON.stringify({ success: true, action_id: actionPayload.action_id }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Route 3: GET / -> Render HTML Dashboard UI
    return new Response(renderUI(), {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
  }
};

/**
 * Stream insert action log into BigQuery write table
 */
async function streamToBigQuery(actionLog, env) {
  // Construct BigQuery REST API Streaming endpoint
  const endpoint = `https://bigquery.googleapis.com/bigquery/v2/projects/${env.PROJECT_ID}/datasets/${env.DATASET_ID}/tables/${env.TABLE_ID}/insertAll`;
  
  const streamBody = {
    rows: [{
      json: {
        action_id: actionLog.action_id,
        timestamp: actionLog.timestamp,
        station_id: actionLog.station_id,
        action_type: actionLog.action_type,
        payload: actionLog.payload,
        user_email: actionLog.user_email
      }
    }]
  };

  // Dispatch REST request to BigQuery
  if (env.GCP_ACCESS_TOKEN) {
    await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GCP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(streamBody)
    });
  }
}

/**
 * Embedded HTML UI Renderer
 */
function renderUI() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Inventory & Usage Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 p-6 min-h-screen">
  <div class="max-w-7xl mx-auto space-y-6">
    
    <!-- Header -->
    <div class="flex justify-between items-center border-b border-slate-800 pb-4">
      <div>
        <h1 class="text-2xl font-bold tracking-tight">Station Inventory & Usage Control</h1>
        <p class="text-slate-400 text-sm">Project ID: <span class="text-amber-400">beaming-might-319312</span></p>
      </div>
      <button onclick="triggerBroadcastAlert()" class="bg-red-600 hover:bg-red-500 px-4 py-2 rounded-lg font-semibold text-sm transition">
        🚨 Broadcast Alert
      </button>
    </div>

    <!-- Metadata Cards -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4" id="kpi-container">
      <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl">
        <span class="text-xs text-slate-400 uppercase font-medium">Total Stations</span>
        <div id="stat-total-stations" class="text-2xl font-bold mt-1">--</div>
      </div>
      <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl">
        <span class="text-xs text-slate-400 uppercase font-medium">30-Day Trips Aggregate</span>
        <div id="stat-total-trips" class="text-2xl font-bold mt-1 text-emerald-400">--</div>
      </div>
      <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl">
        <span class="text-xs text-slate-400 uppercase font-medium">Active Capacity Overrides</span>
        <div id="stat-overrides" class="text-2xl font-bold mt-1 text-amber-400">--</div>
      </div>
    </div>

    <!-- Table -->
    <div class="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
      <div class="p-4 border-b border-slate-800 flex justify-between items-center">
        <h2 class="font-semibold text-base">Inventory Usage Status</h2>
        <button onclick="loadData()" class="text-xs text-slate-400 hover:text-white border border-slate-700 px-3 py-1 rounded-md">
          Refresh Data
        </button>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="bg-slate-800/50 text-slate-400 uppercase text-xs">
            <tr>
              <th class="p-4">Station ID</th>
              <th class="p-4">Station Name</th>
              <th class="p-4">Capacity</th>
              <th class="p-4">30D Trips</th>
              <th class="p-4">Turnover Rate</th>
              <th class="p-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody id="table-body" class="divide-y divide-slate-800/60">
            <tr><td colspan="6" class="p-4 text-center text-slate-500">Loading data from Cloudflare KV...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

  </div>

  <script>
    async function loadData() {
      const res = await fetch('/api/inventory');
      const payload = await res.json();
      
      if (!payload || !payload.data) return;

      document.getElementById('stat-total-stations').innerText = payload.meta.total_stations || 0;
      document.getElementById('stat-total-trips').innerText = (payload.summary.total_trips_recorded || 0).toLocaleString();
      document.getElementById('stat-overrides').innerText = payload.summary.overridden_stations_count || 0;

      const tbody = document.getElementById('table-body');
      tbody.innerHTML = payload.data.slice(0, 50).map(s => \`
        <tr class="hover:bg-slate-800/30">
          <td class="p-4 font-mono text-slate-400">\${s.station_id}</td>
          <td class="p-4 font-medium">\${s.station_name}</td>
          <td class="p-4">
            \${s.capacity}
            \${s.is_overridden ? '<span class="ml-2 text-[10px] bg-amber-500/20 text-amber-400 px-1.5 py-0.5 rounded">OVERRIDDEN</span>' : ''}
          </td>
          <td class="p-4">\${Number(s.trip_volume).toLocaleString()}</td>
          <td class="p-4">
            <span class="px-2 py-1 rounded text-xs font-semibold \${s.usage_turnover_rate >= 15 ? 'bg-red-500/20 text-red-400' : 'bg-emerald-500/20 text-emerald-400'}">
              \${s.usage_turnover_rate}x
            </span>
          </td>
          <td class="p-4 text-right">
            <button onclick="overrideCapacity('\${s.station_id}', \${s.capacity})" class="text-xs bg-slate-800 hover:bg-slate-700 border border-slate-700 px-3 py-1.5 rounded-lg transition">
              Override Cap
            </button>
          </td>
        </tr>
      \`).join('');
    }

    async function overrideCapacity(stationId, currentCap) {
      const val = prompt(\`Enter new capacity override for Station \${stationId}:\`, currentCap);
      if (!val || isNaN(val)) return;

      await fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action_type: 'STATUS_OVERRIDE',
          station_id: String(stationId),
          details: { new_capacity: Number(val) }
        })
      });

      alert('Override submitted to BigQuery & KV updated!');
      loadData();
    }

    async function triggerBroadcastAlert() {
      await fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action_type: 'ALERT_SENT',
          details: { message: 'Manual Broadcast alert triggered from dashboard UI' }
        })
      });
      alert('Alert logged to BigQuery!');
    }

    loadData();
  </script>
</body>
</html>`;
}
