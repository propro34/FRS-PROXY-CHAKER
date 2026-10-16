# FRS Proxy Chaker v4

## التشغيل على Render
- Build Command: `npm install`
- Start Command: `npm start`
- Root Directory: اتركه فارغًا إذا رفعت محتويات هذا المجلد إلى جذر المستودع.

## الملفات التي يجب رفعها إلى GitHub
- `server.js`
- `package.json`
- `index.html`
- `public/index.html` (نسخة احتياطية للواجهة)

## ما تغير
- فحص حقيقي بطلب HTTP عبر البروكسي، وليس مجرد اختبار منفذ TCP.
- معالجة حتى 10 بروكسيات بالتوازي في السيرفر.
- الواجهة ترسل دفعات من 10 حتى تظهر النتائج تدريجيًا.
- سجلات `[api]` و`[check]` في Render Logs لإظهار وصول طلب الفحص ونتيجته.
- وكلاء منفصلون للـHTTP/HTTPS وSOCKS.

## ملاحظات
- هذه النسخة لم تُختبر على خدمة Render حيّة أو على بروكسيات عامة حية من بيئة الإنشاء. يجب التحقق بعد النشر من Render Logs وتجربة بروكسي واحد أولًا.
- `WORKING` يعني أن طلبًا فعليًا عبر البروكسي استقبل رد HTTP من الموقع المستهدف بين 200 و399.
- `FAILED` يمكن أن يعني بروكسيًا متوقفًا، أو مهلة، أو أن الموقع المستهدف رفض الاتصال.
- البروكسيات العامة غير موثوقة؛ لا تدخل بيانات حساسة عبرها.


## v5 features
- Proxy Scraper page accepts up to 20 public page URLs and extracts visible IP:PORT / proxy URI patterns.
- Send scraped proxies to checker.
- Download working proxies or scraped lists as TXT. Browser downloads to the phone's Downloads folder; a web page cannot silently write to arbitrary folders.
- Scraper only works on pages reachable from the Render server and whose contents are readable; anti-bot pages and JavaScript-only lists may not work.
