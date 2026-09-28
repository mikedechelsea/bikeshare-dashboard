import dashboardHtml from './dashboard.html';

const KV_KEY = 'inventory_dashboard_data';
const ACTION_TYPES = new Set(['STATUS_OVERRIDE', 'ALERT_SENT']);
const MAX_CAPACITY = 200;

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra }
  });

// Operator actions are off unless ENABLE_ACTIONS="true" AND an ADMIN_TOKEN secret is set.
const actionsEnabled = env => env.ENABLE_ACTIONS === 'true' && Boolean(env.ADMIN_TOKEN);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // GET /api/inventory -> pre-computed dashboard payload from KV
    if (url.pathname === '/api/inventory' && request.method === 'GET') {
      const kvData = await env.INVENTORY_KV.get(KV_KEY, { type: 'json' });
      return json(kvData || { data: [], meta: {} }, 200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=60'
      });
    }

    // POST /api/action -> operator writes (capacity overrides, alerts). Disabled on public deployments.
    if (url.pathname === '/api/action' && request.method === 'POST') {
      if (!actionsEnabled(env)) return json({ error: 'Actions are disabled on this deployment.' }, 403);
      if (request.headers.get('Authorization') !== `Bearer ${env.ADMIN_TOKEN}`) {
        return json({ error: 'Unauthorized' }, 401);
      }
      try {
        const body = await request.json();
        if (!ACTION_TYPES.has(body.action_type)) return json({ error: 'Unknown action_type' }, 400);

        const actionPayload = {
          action_id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          station_id: String(body.station_id || ''),
          action_type: body.action_type,
          payload: JSON.stringify(body.details || {}),
          user_email: 'operator@dashboard'
        };

        if (body.action_type === 'STATUS_OVERRIDE') {
          const cap = Number(body.details && body.details.new_capacity);
          if (!Number.isInteger(cap) || cap < 1 || cap > MAX_CAPACITY) {
            return json({ error: `new_capacity must be a whole number from 1 to ${MAX_CAPACITY}` }, 400);
          }
          const currentData = await env.INVENTORY_KV.get(KV_KEY, { type: 'json' });
          const station = currentData && currentData.data &&
            currentData.data.find(s => String(s.station_id) === actionPayload.station_id);
          if (!station) return json({ error: 'Unknown station_id' }, 404);

          station.capacity = cap;
          station.is_overridden = true;
          station.usage_turnover_rate = Number((station.trip_volume / cap).toFixed(2));
          if (station.est_revenue) station.revenue_per_dock = Number((station.est_revenue / cap).toFixed(2));
          currentData.summary = currentData.summary || {};
          currentData.summary.overridden_stations_count = currentData.data.filter(s => s.is_overridden).length;
          await env.INVENTORY_KV.put(KV_KEY, JSON.stringify(currentData));
        }

        await streamToBigQuery(actionPayload, env);
        return json({ success: true, action_id: actionPayload.action_id });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // GET / -> dashboard UI
    return new Response(dashboardHtml.replace('__ACTIONS_ENABLED__', String(actionsEnabled(env))), {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
  }
};

/**
 * Stream an action log row into the BigQuery audit table (skipped when no access token is configured).
 */
async function streamToBigQuery(actionLog, env) {
  if (!env.GCP_ACCESS_TOKEN) return;
  const endpoint = `https://bigquery.googleapis.com/bigquery/v2/projects/${env.PROJECT_ID}/datasets/${env.DATASET_ID}/tables/${env.TABLE_ID}/insertAll`;
  await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GCP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ rows: [{ json: actionLog }] })
  });
}
