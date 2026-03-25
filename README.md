# 🤖 نظام النشر الآلي Pro

نظام سحابي يعمل 24/7 لجلب المحتوى وإعادة صياغته ونشره تلقائياً.

## 🚀 طريقة التشغيل المحلي

```bash
# 1. تثبيت المكتبات
npm install

# 2. تشغيل السيرفر
npm start

# 3. افتح المتصفح على
http://localhost:3000
```

## ☁️ رفع على السحابة (مجاناً)

### Railway.app (الأسهل):
1. اذهب لـ railway.app وأنشئ حساباً
2. اضغط "New Project" ← "Deploy from GitHub"
3. ارفع الملفات على GitHub أولاً
4. Railway يعطيك رابطاً ثابتاً يعمل 24/7

### Render.com:
1. render.com ← New Web Service
2. ارفع الكود ← اختر Node.js
3. Start command: `npm start`

## 📱 الوصول من الجوال
بعد الرفع على السحابة، افتح الرابط من أي متصفح على جوالك.

## 🔧 الإعداد الأولي
1. افتح لوحة التحكم
2. اذهب لـ "ربط الحسابات" وأضف:
   - Telegram Bot Token
   - Buffer Token (لتويتر/فيسبوك/إنستغرام)
   - مفتاح Claude أو OpenAI
3. اذهب لـ "إدارة المصادر" وأضف روابط RSS أو يوتيوب
4. اضبط "الجدولة" حسب رغبتك
5. اضغط "تشغيل الدورة الآن" للتجربة

## 🌐 أمثلة روابط RSS
- BBC عربي: https://feeds.bbcarabic.com/bbcarabic/rss.xml
- الجزيرة: https://www.aljazeera.net/aljazeerarss/a5c147e6…
- أي موقع يدعم RSS: https://example.com/feed
