'use strict';

// Set threadpool size for heavy async DNS/network operations before any require
process.env.UV_THREADPOOL_SIZE = '128';

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
app.use(express.json({ limit: '5mb' }));

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT) || 3000;

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

async function publicHost(host) {
  const normalized = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.local')) return false;
  if (net.isIP(normalized)) return !privateIp(normalized);
  
  // Non-blocking DNS resolve
  try {
    const ips = await Promise.race([
      dns.resolve4(normalized).catch(() => []),
      new Promise((r) => setTimeout(() => r([]), 1500))
    ]);
    if (ips && ips.length > 0) {
      return ips.every((ip) => !privateIp(ip));
    }
  } catch {
    return false;
  }
  return true; // fallback allow if DNS resolve fails
}

function makeAgent(proxyUrl, proxyProtocol, targetProtocol, timeoutMs) {
  const agentOpts = { timeout: timeoutMs, keepAlive: false };
  if (proxyProtocol === 'socks4' || proxyProtocol === 'socks5') {
    return new SocksProxyAgent(proxyUrl, agentOpts);
  }
  if (proxyProtocol === 'https' || targetProtocol === 'https:') {
    return new HttpsProxyAgent(proxyUrl, agentOpts);
  }
  return new HttpProxyAgent(proxyUrl, agentOpts);
}

function result(proxy, status, latency_ms, detail, extra = {}) {
  return { proxy: String(proxy), status, latency_ms, detail, ...extra };
}

async function checkOne(input, targetUrl, timeoutMs, type) {
  const proxyText = String(input);
  const proxy = parseProxy(proxyText, type);
  if (!proxy) return result(proxyText, 'invalid', null, 'صيغة غير صحيحة');

  const started = Date.now();
  try {
    if (!(await publicHost(proxy.host))) {
      return result(proxyText, 'blocked', null, 'بروكسي محلي/خاص');
    }

    let agent;
    try {
      agent = makeAgent(proxy.url, proxy.protocol, targetUrl.protocol, timeoutMs);
      
      const response = await axios.get(targetUrl.href, {
        timeout: timeoutMs,
        maxRedirects: 2,
        validateStatus: () => true,
        proxy: false,
        responseType: 'stream',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Cache-Control': 'no-cache'
        },
        ...(targetUrl.protocol === 'https:' ? { httpsAgent: agent } : { httpAgent: agent }),
      });
      
      if (response.data && typeof response.data.destroy === 'function') response.data.destroy();
      const latency = Date.now() - started;
      const ok = (response.status >= 200 && response.status < 400) || response.status === 403;
      const msg = ok 
        ? (response.status === 403 ? 'متصل (HTTP 403)' : `شغال (HTTP ${response.status})`)
        : `استجابة HTTP ${response.status}`;
      
      return result(
        proxyText,
        ok ? 'working' : 'failed',
        latency,
        msg,
        { http_status: response.status, protocol: proxy.protocol }
      );
    } finally {
      if (agent && typeof agent.destroy === 'function') agent.destroy();
    }
  } catch (error) {
    return result(
      proxyText,
      'failed',
      Date.now() - started,
      String(error.code || error.message || 'فشل الاتصال').slice(0, 80),
      { protocol: proxy.protocol }
    );
  }
}

app.post('/api/scrape', async (req, res) => {
  const urls = Array.isArray(req.body?.urls) ? req.body.urls.slice(0, 30) : [];
  if (!urls.length) return res.status(400).json({ error: 'أدخل رابطًا واحدًا على الأقل.' });
  const all = new Set();
  const errors = [];
  for (const raw of urls) {
    let u;
    try { u = new URL(String(raw).trim()); } catch { errors.push(`${raw}: رابط غير صحيح`); continue; }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) { errors.push(`${raw}: استعمل رابط HTTP/HTTPS عام`); continue; }
    if (!(await publicHost(u.hostname))) { errors.push(`${raw}: المضيف غير عام`); continue; }
    try {
      const response = await axios.get(u.href, {
        timeout: 6000, maxRedirects: 2, responseType: 'text', maxContentLength: 5 * 1024 * 1024,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0 Safari/537.36',
          'Accept': 'text/html,text/plain,*/*'
        },
        validateStatus: s => s >= 200 && s < 400
      });
      const body = String(response.data || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, '\n').replace(/&nbsp;|&#160;/gi, ' ');
      const matches = body.match(/(?:https?|socks4|socks5):\/\/[\w.\-\[\]:]+(?::\d{1,5})?|(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}/gi) || [];
      for (const item of matches) {
        const candidate = item.trim().replace(/[),.;]+$/, '');
        const parsed = parseProxy(candidate, 'auto');
        if (parsed) all.add(candidate.includes('://') ? candidate : `${parsed.host}:${parsed.port}`);
      }
    } catch (e) { errors.push(`${u.hostname}: ${String(e.code || e.message || 'تعذر الجلب').slice(0, 80)}`); }
  }
  return res.json({ proxies: [...all], count: all.size, errors });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'FRS Proxy Chaker Fast Engine' });
});

app.post('/api/check', async (req, res) => {
  const { proxies, target = 'https://www.google.com', timeout = 3, type = 'auto', threads = 15 } = req.body || {};
  if (!Array.isArray(proxies) || proxies.length === 0) {
    return res.status(400).json({ error: 'أدخل بروكسي واحدًا على الأقل.' });
  }

  let targetUrl;
  try {
    targetUrl = new URL(String(target));
  } catch {
    return res.status(400).json({ error: 'رابط الموقع غير صحيح.' });
  }

  const timeoutMs = Math.max(500, Math.min(10000, Number(timeout) * 1000 || 2500));
  const concurrency = Math.max(1, Math.min(40, Number(threads) || 15));

  const output = new Array(proxies.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= proxies.length) return;
      try {
        output[index] = await checkOne(proxies[index], targetUrl, timeoutMs, type);
      } catch (error) {
        output[index] = result(String(proxies[index]), 'failed', null, String(error.message || error).slice(0, 80));
      }
    }
  }
  const actualConcurrency = Math.min(concurrency, proxies.length);
  await Promise.all(Array.from({ length: actualConcurrency }, () => worker()));

  return res.json({ target: targetUrl.href, results: output });
});

app.listen(PORT, '0.0.0.0', () => console.log(`FRS Proxy Chaker listening on ${PORT}`));
