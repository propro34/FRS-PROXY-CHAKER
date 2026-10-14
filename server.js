'use strict';

const express = require('express');
const dns = require('node:dns').promises;
const net = require('node:net');
const path = require('node:path');
const { URL } = require('node:url');
const axios = require('axios');
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => {
  if (req.path.startsWith('/api/')) {
    console.log(`[api] ${req.method} ${req.path}`);
  }
  next();
});
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT) || 3000;
const MAX_BATCH = 100;
const MAX_CONCURRENCY = 10;

function parseProxy(input, selectedType) {
  let raw = String(input || '').trim();
  if (!raw) return null;
  let protocol = selectedType && selectedType !== 'auto' ? String(selectedType).toLowerCase() : '';
  const schemeMatch = raw.match(/^(https?|socks4|socks5):\/\//i);
  if (schemeMatch) protocol = schemeMatch[1].toLowerCase();
  if (!protocol) protocol = 'http';
  if (!['http', 'https', 'socks4', 'socks5'].includes(protocol)) return null;
  if (!schemeMatch) raw = `${protocol}://${raw}`;
  try {
    const u = new URL(raw);
    if (!u.hostname || !u.port || !Number.isInteger(Number(u.port)) || Number(u.port) < 1 || Number(u.port) > 65535) return null;
    return { url: u.href, host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port), protocol };
  } catch {
    return null;
  }
}

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const a = ip.split('.').map(Number);
    return a[0] === 0 || a[0] === 10 || a[0] === 127 ||
      (a[0] === 169 && a[1] === 254) ||
      (a[0] === 172 && a[1] >= 16 && a[1] <= 31) ||
      (a[0] === 192 && a[1] === 168) ||
      (a[0] === 100 && a[1] >= 64 && a[1] <= 127) || a[0] >= 224;
  }
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    return normalized === '::' || normalized === '::1' ||
      /^(fc|fd|fe80)/i.test(normalized) || normalized.startsWith('::ffff:127.') ||
      normalized.startsWith('::ffff:10.') || normalized.startsWith('::ffff:192.168.');
  }
  return false;
}

async function lookupWithTimeout(host, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    dns.lookup(host, { all: true, verbatim: true }).then((addresses) => {
      clearTimeout(timer);
      resolve(addresses);
    }).catch(() => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

async function publicHost(host) {
  const normalized = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.local')) return false;
  if (net.isIP(normalized)) return !privateIp(normalized);
  const addresses = await lookupWithTimeout(normalized);
  return Array.isArray(addresses) && addresses.length > 0 && addresses.every((item) => !privateIp(item.address));
}

function makeAgent(proxyUrl, proxyProtocol, targetProtocol) {
  if (proxyProtocol === 'socks4' || proxyProtocol === 'socks5') {
    return new SocksProxyAgent(proxyUrl, { timeout: 6000 });
  }
  if (proxyProtocol === 'https' || targetProtocol === 'https:') {
    return new HttpsProxyAgent(proxyUrl);
  }
  return new HttpProxyAgent(proxyUrl);
}

function result(proxy, status, latency_ms, detail, extra = {}) {
  return { proxy: String(proxy), status, latency_ms, detail, ...extra };
}

async function checkOne(input, targetUrl, timeoutMs, type) {
  const proxyText = String(input);
  const proxy = parseProxy(proxyText, type);
  if (!proxy) return result(proxyText, 'invalid', null, 'صيغة البروكسي غير صحيحة');

  const started = Date.now();
  try {
    if (!(await publicHost(proxy.host))) {
      return result(proxyText, 'blocked', null, 'عنوان البروكسي خاص أو اسم المضيف غير قابل للحل');
    }

    let agent;
    try {
      agent = makeAgent(proxy.url, proxy.protocol, targetUrl.protocol);
      const response = await axios.get(targetUrl.href, {
        timeout: timeoutMs,
        maxRedirects: 0,
        validateStatus: () => true,
        proxy: false,
        responseType: 'stream',
        headers: { 'User-Agent': 'FRS-Proxy-Chaker/4.0', Accept: '*/*' },
        ...(targetUrl.protocol === 'https:' ? { httpsAgent: agent } : { httpAgent: agent }),
      });
      if (response.data && typeof response.data.destroy === 'function') response.data.destroy();
      const latency = Date.now() - started;
      const ok = response.status >= 200 && response.status < 400;
      return result(
        proxyText,
        ok ? 'working' : 'failed',
        latency,
        ok ? `نجح الطلب عبر البروكسي (HTTP ${response.status})` : `رد الموقع بحالة HTTP ${response.status}`,
        { http_status: response.status, protocol: proxy.protocol },
      );
    } finally {
      if (agent && typeof agent.destroy === 'function') agent.destroy();
    }
  } catch (error) {
    return result(
      proxyText,
      'failed',
      Date.now() - started,
      String(error.code || error.message || 'Request failed').slice(0, 160),
      { protocol: proxy.protocol },
    );
  }
}

async function checkBatch(proxies, targetUrl, timeoutMs, type) {
  const output = new Array(proxies.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= proxies.length) return;
      try {
        output[index] = await checkOne(proxies[index], targetUrl, timeoutMs, type);
      } catch (error) {
        output[index] = result(String(proxies[index]), 'failed', null, String(error.message || error).slice(0, 160));
      }
    }
  }
  const workers = Math.min(MAX_CONCURRENCY, proxies.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return output;
}


app.post('/api/scrape', async (req, res) => {
  const urls = Array.isArray(req.body?.urls) ? req.body.urls.slice(0, 20) : [];
  if (!urls.length) return res.status(400).json({ error: 'أدخل رابطًا واحدًا على الأقل.' });
  const all = new Set();
  const errors = [];
  for (const raw of urls) {
    let u;
    try { u = new URL(String(raw).trim()); } catch { errors.push(`${raw}: رابط غير صحيح`); continue; }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) { errors.push(`${raw}: استعمل رابط HTTP/HTTPS عام`); continue; }
    if (!(await publicHost(u.hostname))) { errors.push(`${raw}: المضيف غير عام أو تعذر التحقق منه`); continue; }
    try {
      const response = await axios.get(u.href, {
        timeout: 8000, maxRedirects: 3, responseType: 'text', maxContentLength: 2 * 1024 * 1024,
        headers: { 'User-Agent': 'Mozilla/5.0 FRS-Proxy-Chaker/5.0', Accept: 'text/html,text/plain,*/*' },
        validateStatus: s => s >= 200 && s < 400
      });
      const body = String(response.data || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, '\n').replace(/&nbsp;|&#160;/gi, ' ');
      const matches = body.match(/(?:https?|socks4|socks5):\/\/[\w.\-\[\]:]+(?::\d{1,5})?|(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}/gi) || [];
      for (const item of matches) {
        const candidate = item.trim().replace(/[),.;]+$/, '');
        const parsed = parseProxy(candidate, 'auto');
        if (parsed) all.add(candidate.includes('://') ? candidate : `${parsed.host}:${parsed.port}`);
      }
    } catch (e) { errors.push(`${u.hostname}: ${String(e.code || e.message || 'تعذر الجلب').slice(0, 100)}`); }
  }
  return res.json({ proxies: [...all], count: all.size, errors });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'FRS Proxy Chaker', mode: 'real HTTP request via proxy', concurrency: MAX_CONCURRENCY });
});

app.post('/api/check', async (req, res) => {
  const { proxies, target = 'https://www.google.com', timeout = 6, type = 'auto' } = req.body || {};
  if (!Array.isArray(proxies) || proxies.length === 0) {
    return res.status(400).json({ error: 'أدخل بروكسي واحدًا على الأقل.' });
  }
  if (proxies.length > MAX_BATCH) {
    return res.status(400).json({ error: `الحد الأقصى ${MAX_BATCH} بروكسي في الدفعة.` });
  }

  let targetUrl;
  try {
    targetUrl = new URL(String(target));
  } catch {
    return res.status(400).json({ error: 'رابط الموقع غير صحيح.' });
  }
  if (!['http:', 'https:'].includes(targetUrl.protocol) || targetUrl.username || targetUrl.password) {
    return res.status(400).json({ error: 'استعمل رابط HTTP/HTTPS صحيحًا لموقع عام.' });
  }
  if (!(await publicHost(targetUrl.hostname))) {
    return res.status(400).json({ error: 'الموقع المستهدف غير عام أو تعذّر التأكد من عنوانه.' });
  }

  const timeoutMs = Math.max(1000, Math.min(15000, Number(timeout) * 1000 || 6000));
  const started = Date.now();
  console.log(`[check] start count=${proxies.length} target=${targetUrl.hostname} concurrency=${Math.min(MAX_CONCURRENCY, proxies.length)} timeout=${timeoutMs}ms`);
  try {
    const results = await checkBatch(proxies, targetUrl, timeoutMs, type);
    const working = results.filter((item) => item.status === 'working').length;
    const failed = results.length - working;
    console.log(`[check] done count=${results.length} working=${working} other=${failed} elapsed=${Date.now() - started}ms`);
    return res.json({ target: targetUrl.href, mode: 'real HTTP request through proxy', checked: results.length, results });
  } catch (error) {
    console.error(`[check] failed: ${error.stack || error.message || error}`);
    return res.status(500).json({ error: 'حدث خطأ أثناء فحص البروكسيات.' });
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`FRS Proxy Chaker listening on ${PORT}`));
