const express = require("express");
const dns = require("node:dns").promises;
const net = require("node:net");
const path = require("node:path");
const { URL } = require("node:url");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.use(express.static(path.join(__dirname, "public")));
const PORT = process.env.PORT || 3000;
const MAX_BATCH = 100;

function parseProxy(input, selectedType) {
  let raw = String(input || "").trim();
  let protocol = selectedType && selectedType !== "auto" ? selectedType : "";
  if (/^(https?|socks4|socks5):\/\//i.test(raw)) protocol = raw.slice(0, raw.indexOf("://")).toLowerCase();
  if (!protocol) protocol = "http";
  if (!["http", "https", "socks4", "socks5"].includes(protocol)) return null;
  if (!raw.includes("://")) raw = protocol + "://" + raw;
  try {
    const u = new URL(raw);
    if (!u.hostname || !u.port || !Number.isInteger(Number(u.port)) || Number(u.port) < 1 || Number(u.port) > 65535) return null;
    return { url: u.href, host: u.hostname, port: Number(u.port), protocol };
  } catch { return null; }
}
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const a = ip.split(".").map(Number);
    return a[0] === 10 || a[0] === 127 || a[0] === 0 || (a[0] === 169 && a[1] === 254) ||
      (a[0] === 172 && a[1] >= 16 && a[1] <= 31) || (a[0] === 192 && a[1] === 168) ||
      (a[0] === 100 && a[1] >= 64 && a[1] <= 127) || a[0] >= 224;
  }
  if (net.isIPv6(ip)) return ip === "::" || ip === "::1" || /^(fc|fd|fe80)/i.test(ip);
  return false;
}
async function publicHost(host) {
  if (host === "localhost" || host.endsWith(".local")) return false;
  if (net.isIP(host)) return !privateIp(host);
  try { const r = await dns.lookup(host, { all: true }); return r.length > 0 && r.every(x => !privateIp(x.address)); }
  catch { return false; }
}
function makeAgent(proxyUrl, protocol) {
  if (protocol === "socks4" || protocol === "socks5") return new SocksProxyAgent(proxyUrl);
  return new HttpsProxyAgent(proxyUrl);
}
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "FRS Proxy Chaker", mode: "actual request through proxy" }));
app.post("/api/check", async (req, res) => {
  const { proxies, target = "https://www.google.com", timeout = 6, type = "auto" } = req.body || {};
  if (!Array.isArray(proxies) || !proxies.length) return res.status(400).json({ error: "أدخل بروكسي واحدًا على الأقل." });
  if (proxies.length > MAX_BATCH) return res.status(400).json({ error: `الحد الأقصى ${MAX_BATCH} بروكسي في الدفعة.` });
  let t;
  try { t = new URL(target); } catch { return res.status(400).json({ error: "رابط الموقع غير صحيح." }); }
  if (!["http:", "https:"].includes(t.protocol) || !(await publicHost(t.hostname))) return res.status(400).json({ error: "استعمل رابط HTTP/HTTPS لموقع عام يمكن الوصول إليه." });
  const timeoutMs = Math.max(1000, Math.min(15000, Number(timeout) * 1000 || 6000));
  const results = [];
  for (const input of proxies) {
    const p = parseProxy(input, type);
    if (!p) { results.push({ proxy: String(input), status: "invalid", latency_ms: null, detail: "صيغة البروكسي غير صحيحة" }); continue; }
    if (!(await publicHost(p.host))) { results.push({ proxy: String(input), status: "blocked", latency_ms: null, detail: "عنوان خاص أو اسم مضيف غير قابل للحل مرفوض" }); continue; }
    const start = Date.now();
    let agent;
    try {
      agent = makeAgent(p.url, p.protocol);
      const opts = { timeout: timeoutMs, maxRedirects: 2, validateStatus: () => true, proxy: false,
        headers: { "User-Agent": "FRS-Proxy-Chaker/3.0", Accept: "*/*" } };
      if (t.protocol === "https:") opts.httpsAgent = agent; else opts.httpAgent = agent;
      const response = await axios.get(t.href, opts);
      const latency_ms = Date.now() - start;
      const ok = response.status >= 200 && response.status < 400;
      results.push({ proxy: String(input), status: ok ? "working" : "failed", latency_ms,
        detail: ok ? `نجح الطلب عبر البروكسي (HTTP ${response.status})` : `رد الموقع بحالة HTTP ${response.status}`,
        http_status: response.status, protocol: p.protocol });
    } catch (e) {
      results.push({ proxy: String(input), status: "failed", latency_ms: Date.now() - start,
        detail: String(e.code || e.message || "Request failed").slice(0, 160), protocol: p.protocol });
    } finally { if (agent && typeof agent.destroy === "function") agent.destroy(); }
  }
  res.json({ target: t.href, mode: "actual HTTP request through proxy", results });
});
app.listen(PORT, "0.0.0.0", () => console.log(`FRS Proxy Chaker listening on ${PORT}`));
