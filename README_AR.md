# FRS Proxy Chaker v2

## تشغيل محلي
1. ثبّت Node.js 18 أو أحدث.
2. من مجلد المشروع شغّل `npm install`
3. شغّل `npm start`
4. افتح `http://localhost:3000`

## النشر
ارفع مجلد المشروع إلى مستودع GitHub ثم أنشئ Web Service على Render:
- Build command: `npm install`
- Start command: `npm start`

افتح رابط الاستضافة الناتج. لا تفتح `index.html` كملف محلي؛ يلزم تشغيل السيرفر.

## الفحص
يرسل السيرفر طلب HTTP/HTTPS فعليًا إلى الرابط المختار من خلال كل بروكسي، ويعرض رمز HTTP والوقت. الصيغ المدعومة: `host:port` أو `http://host:port` أو `https://host:port` أو `socks4://host:port` أو `socks5://host:port`. اختر نوع البروكسي من القائمة إذا لم تحدده في السطر. الدفعة حتى 100 بروكسي.
قد تفشل بعض البروكسيات بسبب حظر الموقع أو عدم دعم CONNECT أو انتهاء المهلة. لا تدخل كلمات مرور أو بيانات حساسة عبر بروكسيات عامة.
