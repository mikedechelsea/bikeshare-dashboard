// Records a ~45-second LinkedIn video (1080x1350, MP4) of the live dashboard:
// title card -> 3D map playing -> key finding & score cards -> fleet/riders ->
// hourly chart -> membership targets -> end card, with captions built from the live data.
//
//   npm run video                                   # records the live dashboard with Microsoft Edge
//   npm run video -- --browser chrome               # or Google Chrome
//   npm run video -- --url http://localhost:8787    # or any other deployment
//   npm run video -- --out my-video.mp4 --headed    # choose the file / watch it record

import { chromium } from "playwright-core";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const W = 1080, H = 1350, FPS = 30;
const DEFAULT_URL = "https://bikeshare-dashboard.dashboard-report.workers.dev";

// ---------- captions from the published data (same rules as the dashboard) ----------
const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const share = v => (n(v) > 1 ? n(v) / 100 : n(v));
const pct = v => Math.round(share(v) * 100) + "%";
const money = v => (v >= 1e6 ? "$" + (v / 1e6).toFixed(1) + "M" : v >= 1e4 ? "$" + Math.round(v / 1e3) + "K" : "$" + Math.round(v).toLocaleString("en-US"));
const isEbike = t => /elec|e-?bike|ebike/i.test(t || "");
const isCasual = t => /casual|customer/i.test(t || "");
const hourLabel = h => (h % 12 || 12) + (h < 12 ? "am" : "pm");

function captions(p) {
  const c = {};
  const fleet = p.fleet || [], riders = p.riders || [], hours = p.hours || [];
  const sum = (a, f) => a.reduce((s, r) => s + n(f(r)), 0);
  const trips = n(p.summary && p.summary.total_trips_recorded);
  c.title = "Where is Bay Wheels leaving fare revenue on the table?";
  c.sub = [p.meta && p.meta.period_label, trips && trips.toLocaleString("en-US") + " trips", (p.data || []).length + " stations"].filter(Boolean).join(" · ");
  const fT = sum(fleet, f => f.trips), fR = sum(fleet, f => f.est_revenue);
  const eT = sum(fleet.filter(f => isEbike(f.bike_type)), f => f.trips), eR = sum(fleet.filter(f => isEbike(f.bike_type)), f => f.est_revenue);
  if (fT && fR) c.fleet = `E-bikes: ${pct(eT / fT)} of trips, ${pct(eR / fR)} of fare revenue`;
  const rT = sum(riders, r => r.trips), rR = sum(riders, r => r.est_revenue);
  const cas = riders.find(r => isCasual(r.rider));
  if (cas && rT && rR) c.riders = `Casual riders: ${pct(n(cas.trips) / rT)} of trips, ${pct(n(cas.est_revenue) / rR)} of revenue`;
  if (cas && n(cas.conversion_gap) > 0) c.promo = `Casual riders paid ${money(n(cas.conversion_gap))} above member rates. Here's where to sell memberships`;
  const byHour = new Array(24).fill(0);
  hours.forEach(h => { const i = n(h.hour); if (i >= 0 && i < 24) byHour[i] += n(h.trips); });
  if (byHour.some(Boolean)) c.hours = `Demand peaks at ${hourLabel(byHour.indexOf(Math.max(...byHour)))}`;
  const rt = p.geo && p.geo.round_trips;
  c.map = "A day of Bay Wheels, replayed hour by hour";
  if (rt && rt.trips && rt.casual_revenue) c.loop = `Round trips: ${pct(rt.round_trips / rt.trips)} of rides, ${pct(rt.round_trip_casual_revenue / rt.casual_revenue)} of casual revenue`;
  return c;
}

// ---------- overlay layer injected into the page ----------
const OVERLAY_CSS = `
  ::-webkit-scrollbar { display: none; }
  .map-stage { height: 1000px !important; }   /* give the map most of the portrait frame */
  html { scrollbar-width: none; }
  #vid-card { position: fixed; inset: 0; z-index: 9999; display: grid; place-items: center; text-align: center; padding: 80px;
    background: radial-gradient(ellipse at 50% 40%, rgba(40,40,38,.96), rgba(8,8,8,.98)); color: #fff; opacity: 0; transition: opacity .7s ease;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif; pointer-events: none; }
  #vid-card.on { opacity: 1; }
  #vid-card .k { font-size: 22px; letter-spacing: .14em; text-transform: uppercase; color: #d95926; font-weight: 700; }
  #vid-card .t { font-size: 64px; line-height: 1.12; font-weight: 800; margin: 22px 0; max-width: 900px; }
  #vid-card .s { font-size: 28px; color: #c3c2b7; }
  #vid-card .u { font-size: 30px; color: #fff; margin-top: 34px; font-weight: 600; }
  #vid-cap { position: fixed; left: 50%; bottom: 70px; z-index: 9998; transform: translate(-50%, 20px); opacity: 0; max-width: 940px; width: max-content;
    background: rgba(13,13,13,.9); color: #fff; border-radius: 16px; padding: 20px 30px; text-align: center; pointer-events: none;
    font: 700 34px/1.25 system-ui, -apple-system, "Segoe UI", sans-serif; box-shadow: 0 10px 40px rgba(0,0,0,.35);
    border-left: 6px solid #d95926; transition: opacity .5s ease, transform .5s ease; }
  #vid-cap.on { opacity: 1; transform: translate(-50%, 0); }
`;

async function card(page, html, on = true) {
  await page.evaluate(([html, on]) => {
    const el = document.getElementById("vid-card");
    if (html != null) el.innerHTML = html;
    el.classList.toggle("on", on);
  }, [html, on]);
}
async function caption(page, text) {
  await page.evaluate(async text => {
    const el = document.getElementById("vid-cap");
    if (el.classList.contains("on")) { el.classList.remove("on"); await new Promise(r => setTimeout(r, 450)); }
    if (!text) return;
    el.textContent = text;
    el.classList.add("on");
  }, text || "");
}
async function scrollTo(page, selector, dur = 1400) {
  await page.evaluate(([sel, dur]) => new Promise(resolve => {
    const el = document.querySelector(sel);
    if (!el) return resolve();
    const from = scrollY, to = Math.max(0, el.getBoundingClientRect().top + scrollY - 28), t0 = performance.now();
    const ease = k => (k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
    const step = now => { const k = Math.min(1, (now - t0) / dur); scrollTo(0, from + (to - from) * ease(k)); k < 1 ? requestAnimationFrame(step) : resolve(); };
    requestAnimationFrame(step);
  }), [selector, dur]);
}
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

// ---------- recording ----------
export async function record({ url = DEFAULT_URL, out = "dock-pulse-linkedin.mp4", browser = "msedge", headed = false, onPage } = {}) {
  const launch = { headless: !headed, args: ["--hide-scrollbars", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"] };
  if (fs.existsSync(browser)) launch.executablePath = browser; else launch.channel = browser;
  const b = await chromium.launch(launch);
  const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: "light" });
  const page = await ctx.newPage();
  if (onPage) await onPage(page);

  console.log("Opening " + url);
  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector("#app:not([hidden])", { timeout: 60000 });
  const data = await page.evaluate(() => fetch("/api/inventory").then(r => r.json()));
  const c = captions(data);
  const liveUrl = new URL(url).host;

  await page.addStyleTag({ content: OVERLAY_CSS });
  await page.evaluate(() => { for (const id of ["vid-card", "vid-cap"]) { const d = document.createElement("div"); d.id = id; document.body.appendChild(d); } });
  await card(page, `<div><div class="k">Dock Pulse</div><div class="t">${esc(c.title)}</div><div class="s">${esc(c.sub)}</div></div>`);
  console.log("Letting the map load...");
  await page.waitForTimeout(6000);

  // Capture frames straight from the renderer (sharper than Playwright's built-in video).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dock-pulse-"));
  const frames = [];
  const cdp = await ctx.newCDPSession(page);
  cdp.on("Page.screencastFrame", f => {
    const file = path.join(tmp, String(frames.length).padStart(6, "0") + ".jpg");
    fs.writeFileSync(file, Buffer.from(f.data, "base64"));
    frames.push({ file, t: f.metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  const wait = ms => page.waitForTimeout(ms);
  console.log("Recording...");

  // Storyboard (~45 s)
  await wait(3500);                                             // title card
  await card(page, null, false);
  await wait(700);
  await caption(page, c.map);                                   // map playing
  await wait(5000);
  if (await page.$("text=Top loop")) {
    await page.click("text=Top loop");
    if (c.loop) await caption(page, c.loop);
    await wait(5500);
  }
  await caption(page, "");
  await scrollTo(page, ".headline");                           // key finding + score cards count up
  await wait(4800);
  await scrollTo(page, "#fleet");                               // fleet & riders
  if (c.fleet) await caption(page, c.fleet);
  await wait(3200);
  if (c.riders) await caption(page, c.riders);
  await wait(3200);
  await caption(page, "");
  await scrollTo(page, "#hours");                               // hourly chart grows
  if (c.hours) await caption(page, c.hours);
  await wait(4600);
  await caption(page, "");
  await scrollTo(page, "#promo");                               // membership targets
  if (c.promo) await caption(page, c.promo);
  await wait(5000);
  await caption(page, "");
  await card(page, `<div><div class="k">Dock Pulse</div><div class="t">Explore the live dashboard</div>` +
    `<div class="u">${esc(liveUrl)}</div><div class="s" style="margin-top:30px">BigQuery · Node.js · Cloudflare Workers · MapLibre</div></div>`);
  await wait(4200);

  const stoppedAt = Date.now() / 1000;
  await cdp.send("Page.stopScreencast");
  await wait(300);
  await b.close();
  if (frames.length < 2) throw new Error("No frames were captured.");

  // Frames arrive at a variable rate: give each one its real on-screen duration, then resample to 30 fps.
  const list = frames.map((f, i) => {
    const next = frames[i + 1];
    // Chrome only sends a frame when something changes, so a still frame lasts until the next one
    // (the last one until recording stopped).
    const d = next ? Math.max(0.001, next.t - f.t) : Math.max(1 / FPS, stoppedAt - f.t);
    return `file '${f.file.replace(/\\/g, "/").replace(/'/g, "'\\''")}'\nduration ${d.toFixed(4)}`;
  }).join("\n") + `\nfile '${frames[frames.length - 1].file.replace(/\\/g, "/")}'\n`;
  const listFile = path.join(tmp, "frames.txt");
  fs.writeFileSync(listFile, list);
  const seconds = stoppedAt - frames[0].t;
  console.log(`Encoding ${frames.length} frames (${seconds.toFixed(1)} s) to ${out}...`);
  await new Promise((resolve, reject) => {
    const ff = spawn(ffmpegInstaller.path, ["-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-vf", `fps=${FPS},scale=${W}:${H}:flags=lanczos,format=yuv420p`,
      "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-movflags", "+faststart", out], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    ff.stderr.on("data", d => { err += d; });
    ff.on("close", code => (code === 0 ? resolve() : reject(new Error("ffmpeg failed:\n" + err.slice(-2000)))));
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("Done: " + path.resolve(out));
  return path.resolve(out);
}

// ---------- CLI ----------
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), opt = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--headed") opt.headed = true;
    else if (a.startsWith("--")) opt[a.slice(2)] = args[++i];
  }
  record(opt).catch(e => {
    console.error("\n" + e.message);
    if (/Executable|channel|browserType\.launch/i.test(e.message)) {
      console.error("Couldn't start the browser. Try: npm run video -- --browser chrome   (or pass the full path to a browser .exe)");
    }
    process.exit(1);
  });
}

