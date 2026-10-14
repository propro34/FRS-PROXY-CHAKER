const express = require("express");
const dns = require("dns").promises;
const net = require("net");
const { URL } = require("url");
const axios = require("axios");
const { ProxyAgent } = require("proxy-agent");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));
const PORT = process.env.PORT || 3000;
const MAX_BATCH = 100;

function parseProxy(input, selectedType) {
  let raw = String(input || "").trim();
  let protocol = selectedType && selectedType !== "auto" ? selectedType : "";
  if (/^(http|https|socks4|socks5):\/\//i.test(raw)) {
    const ix = raw.indexOf("://");
    protocol = raw.slice(0, ix).toLowerCase();
  } else if (!protocol) protocol = "http";
  if (!/^(http|https|socks4|socks5)$/.test(protocol)) return null;
  if (!raw.includes("://")) raw = protocol + "://" + raw;
  try {
    const u = new URL(raw);
    if (!u.hostname || !u.port || Number(u.port) < 1 || Number(u.port) > 65535) return null;
    if (!["http:", "https:", "socks4:", "socks5:"].includes(u.protocol)) return null;
    return { url: u.href, host: u.hostname, port: Number(u.port), protocol: u.protocol.slice(0,-1) };
  } catch { return null; }
}
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const a=ip.split(".").map(Number);
    return a[0]===10 || a[0]===127 || a[0]===0 || (a[0]===169&&a[1]===254) ||
      (a[0]===172&&a[1]>=16&&a[1]<=31) || (a[0]===192&&a[1]===168) ||
      (a[0]===100&&a[1]>=64&&a[1]<=127) || a[0]>=224;
  }
  if (net.isIPv6(ip)) return ip==="::" || ip==="::1" || /^fc|^fd|^fe80/i.test(ip);
  return false;
}
async function publicHost(host) {
  if (host==="localhost" || host.endsWith(".local")) return false;
  if (net.isIP(host)) return !privateIp(host);
  try { const r=await dns.lookup(host,{all:true}); return r.length>0 && r.every(x=>!privateIp(x.address)); }
  catch { return false; }
}
app.get("/api/health",(req,res)=>res.json({ok:true,service:"FRS Proxy Chaker",mode:"HTTP proxy request test"}));
app.post("/api/check",async(req,res)=>{
  const {proxies,target="https://www.google.com",timeout=6,type="auto"}=req.body||{};
  if(!Array.isArray(proxies)||!proxies.length) return res.status(400).json({error:"أدخل بروكسي واحدًا على الأقل."});
  if(proxies.length>MAX_BATCH) return res.status(400).json({error:`الحد الأقصى ${MAX_BATCH} بروكسي في الدفعة.`});
  let t; try { t=new URL(target); } catch { return res.status(400).json({error:"رابط الموقع غير صحيح."}); }
  if(!["http:","https:"].includes(t.protocol) || !(await publicHost(t.hostname))) return res.status(400).json({error:"استعمل رابط HTTP/HTTPS لموقع عام يمكن الوصول إليه."});
  const timeoutMs=Math.max(1000,Math.min(15000,Number(timeout)*1000||6000));
  const results=[];
  for(const input of proxies) {
    const p=parseProxy(input,type);
    if(!p){results.push({proxy:String(input),status:"invalid",latency_ms:null,detail:"صيغة البروكسي غير صحيحة"});continue;}
    if(!(await publicHost(p.host))){results.push({proxy:String(input),status:"blocked",latency_ms:null,detail:"عنوان خاص أو غير قابل للحل مرفوض"});continue;}
    const start=Date.now();
    let agent;
    try {
      agent=new ProxyAgent(p.url);
      const response=await axios.get(t.href,{
        httpAgent:agent, httpsAgent:agent, proxy:false,
        timeout:timeoutMs, maxRedirects:3, validateStatus:()=>true,
        headers:{"User-Agent":"FRS-Proxy-Chaker/1.0","Accept":"*/*"}
      });
      const latency_ms=Date.now()-start;
      const ok=response.status>=200 && response.status<500;
      results.push({proxy:String(input),status:ok?"working":"failed",latency_ms,detail:ok?`HTTP ${response.status} via proxy`:`HTTP ${response.status}`,http_status:response.status,protocol:p.protocol});
    } catch(e) {
      results.push({proxy:String(input),status:"failed",latency_ms:Date.now()-start,detail:(e.code||e.message||"Request failed").toString().slice(0,160),protocol:p.protocol});
    } finally { if(agent && agent.destroy) agent.destroy(); }
  }
  res.json({target:t.href,mode:"actual HTTP request through proxy",results});
});
app.listen(PORT,"0.0.0.0",()=>console.log(`FRS Proxy Chaker listening on ${PORT}`));
