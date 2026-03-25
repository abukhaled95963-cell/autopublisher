require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const Parser = require('rss-parser');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const cheerio = require('cheerio');

const app = express();
const parser = new Parser();
const db = new Database('autopublisher.db');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== إعداد قاعدة البيانات =====
db.exec(`
  CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    type TEXT DEFAULT 'rss',
    active INTEGER DEFAULT 1,
    last_check TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER,
    original_title TEXT,
    original_url TEXT UNIQUE,
    original_content TEXT,
    rewritten_twitter TEXT,
    rewritten_facebook TEXT,
    rewritten_instagram TEXT,
    rewritten_telegram TEXT,
    rewritten_blogger TEXT,
    status TEXT DEFAULT 'pending',
    published_at TEXT,
    error_msg TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS publish_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER,
    platform TEXT,
    status TEXT,
    message TEXT,
    published_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT UNIQUE,
    enabled INTEGER DEFAULT 1,
    time TEXT DEFAULT '09:00',
    posts_per_day INTEGER DEFAULT 3
  );
`);

// إعداد الجداول الافتراضية
const platforms = ['twitter', 'facebook', 'instagram', 'telegram', 'blogger'];
platforms.forEach(p => {
  db.prepare(`INSERT OR IGNORE INTO schedules (platform) VALUES (?)`).run(p);
});

// ===== دوال مساعدة =====
function getSetting(key, def = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : def;
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

// ===== استدعاء AI =====
async function callAI(prompt, maxTokens = 1000) {
  const claudeKey = getSetting('claude_key');
  const openaiKey = getSetting('openai_key');
  const aiProvider = getSetting('ai_provider', 'claude');

  if (aiProvider === 'openai' && openaiKey) {
    const r = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    }, { headers: { Authorization: `Bearer ${openaiKey}` } });
    return r.data.choices[0].message.content;
  }

  if (claudeKey) {
    const r = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: {
        'x-api-key': claudeKey,
        'anthropic-version': '2023-06-01'
      }
    });
    return r.data.content[0].text;
  }

  throw new Error('لا يوجد مفتاح AI مضبوط');
}

// ===== إعادة الصياغة =====
async function rewriteContent(title, content, url, source) {
  const tone = getSetting('writing_tone', 'informative');
  const lang = getSetting('content_lang', 'ar');
  const hashtags = getSetting('hashtags', '#أخبار #تقنية');

  const toneMap = {
    informative: 'إخباري موضوعي',
    analytical: 'تحليلي عميق',
    neutral: 'محايد',
    engaging: 'جذاب وشيق'
  };

  const langTxt = lang === 'ar' ? 'باللغة العربية' : lang === 'en' ? 'in English' : 'بالعربية والإنجليزية';

  const prompt = `أنت كاتب محتوى رقمي محترف. أعد كتابة هذا المحتوى بأسلوب ${toneMap[tone] || 'إخباري'} ${langTxt} بطريقة بشرية طبيعية غير مكشوفة كذكاء صناعي.

العنوان الأصلي: ${title}
المصدر: ${source}
الرابط: ${url}
المحتوى: ${content.substring(0, 1500)}

اكتب نسخة مختلفة لكل منصة بهذا الشكل الدقيق:

[TWITTER]
نص مختصر وقوي أقل من 250 حرف مع ${hashtags} والرابط
[/TWITTER]

[FACEBOOK]
فقرة جذابة 100-150 كلمة مع سؤال للتفاعل والرابط
[/FACEBOOK]

[INSTAGRAM]
نص قصير 3-4 أسطر مع هاشتاقات كثيرة والرابط
[/INSTAGRAM]

[TELEGRAM]
تحليل موسع 200-300 كلمة بنقاط واضحة والرابط
[/TELEGRAM]

[BLOGGER]
مقال كامل 400-600 كلمة بعنوان ومقدمة ومحتوى منظم وخاتمة
[/BLOGGER]

مهم: الأسلوب بشري طبيعي، متنوع في الجمل، غير متكرر.`;

  const result = await callAI(prompt, 2000);

  const extract = (tag) => {
    const m = result.match(new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[\\/${tag}\\]`, 'i'));
    return m ? m[1].trim() : '';
  };

  return {
    twitter: extract('TWITTER'),
    facebook: extract('FACEBOOK'),
    instagram: extract('INSTAGRAM'),
    telegram: extract('TELEGRAM'),
    blogger: extract('BLOGGER')
  };
}

// ===== جلب RSS =====
async function fetchRSSSource(source) {
  try {
    const feed = await parser.parseURL(source.url);
    const newItems = [];

    for (const item of feed.items.slice(0, 5)) {
      const existing = db.prepare('SELECT id FROM posts WHERE original_url = ?').get(item.link);
      if (!existing && item.link) {
        newItems.push({
          title: item.title || '',
          url: item.link,
          content: item.contentSnippet || item.content || item.summary || item.title || ''
        });
      }
    }

    return newItems;
  } catch (e) {
    console.error(`خطأ في جلب RSS ${source.url}:`, e.message);
    return [];
  }
}

// ===== جلب يوتيوب =====
async function fetchYouTube(source) {
  try {
    const url = source.url;
    const videoId = url.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/)?.[1];
    const channelId = url.match(/channel\/([a-zA-Z0-9_-]+)/)?.[1];
    const handle = url.match(/@([a-zA-Z0-9_-]+)/)?.[1];

    const apiKey = getSetting('youtube_api_key');

    if (videoId) {
      const existing = db.prepare('SELECT id FROM posts WHERE original_url LIKE ?').get(`%${videoId}%`);
      if (existing) return [];

      let title = `فيديو يوتيوب ${videoId}`;
      let desc = '';

      if (apiKey) {
        const r = await axios.get(`https://www.googleapis.com/youtube/v3/videos?id=${videoId}&key=${apiKey}&part=snippet`);
        if (r.data.items?.[0]) {
          title = r.data.items[0].snippet.title;
          desc = r.data.items[0].snippet.description?.substring(0, 500) || '';
        }
      } else {
        // جلب بدون API key عبر oEmbed
        try {
          const oe = await axios.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
          title = oe.data.title;
        } catch(e) {}
      }

      return [{ title, url: `https://www.youtube.com/watch?v=${videoId}`, content: desc || title }];
    }

    // قناة يوتيوب
    if ((channelId || handle) && apiKey) {
      let chId = channelId;
      if (handle) {
        const r = await axios.get(`https://www.googleapis.com/youtube/v3/channels?forHandle=${handle}&key=${apiKey}&part=id`);
        chId = r.data.items?.[0]?.id;
      }
      if (!chId) return [];

      const r = await axios.get(`https://www.googleapis.com/youtube/v3/search?channelId=${chId}&key=${apiKey}&part=snippet&order=date&maxResults=3&type=video`);
      const newItems = [];
      for (const item of r.data.items || []) {
        const vid = item.id.videoId;
        const existing = db.prepare('SELECT id FROM posts WHERE original_url LIKE ?').get(`%${vid}%`);
        if (!existing) {
          newItems.push({
            title: item.snippet.title,
            url: `https://www.youtube.com/watch?v=${vid}`,
            content: item.snippet.description?.substring(0, 500) || item.snippet.title
          });
        }
      }
      return newItems;
    }

    return [];
  } catch(e) {
    console.error(`خطأ في يوتيوب:`, e.message);
    return [];
  }
}

// ===== النشر على المنصات =====
async function publishToTelegram(content, postId) {
  const token = getSetting('telegram_token');
  const chat = getSetting('telegram_chat');
  if (!token || !chat) throw new Error('Telegram غير مضبوط');

  const r = await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chat,
    text: content,
    parse_mode: 'HTML'
  });

  if (!r.data.ok) throw new Error(r.data.description);
  return true;
}

async function publishToBuffer(content, platforms) {
  const token = getSetting('buffer_token');
  if (!token) throw new Error('Buffer Token غير مضبوط');

  const profilesRes = await axios.get(`https://api.bufferapp.com/1/profiles.json?access_token=${token}`);
  const profiles = profilesRes.data;

  const platformMap = { twitter: 'twitter', facebook: 'facebook', instagram: 'instagram' };
  const targetProfiles = profiles
    .filter(p => platforms.includes(platformMap[p.service]))
    .map(p => p.id);

  if (targetProfiles.length === 0) throw new Error('لا توجد حسابات Buffer مرتبطة');

  const params = new URLSearchParams();
  params.append('text', content);
  params.append('access_token', token);
  targetProfiles.forEach(id => params.append('profile_ids[]', id));

  await axios.post('https://api.bufferapp.com/1/updates/create.json', params);
  return true;
}

async function publishToBlogger(title, content, postId) {
  const blogId = getSetting('blogger_id');
  const accessToken = getSetting('blogger_token');
  if (!blogId || !accessToken) throw new Error('Blogger غير مضبوط');

  const r = await axios.post(
    `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/`,
    { kind: 'blogger#post', title, content: `<div dir="rtl">${content.replace(/\n/g, '<br>')}</div>` },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  return true;
}

async function publishViaWebhook(content, platforms, scheduledAt = null) {
  const webhook = getSetting('make_webhook');
  if (!webhook) throw new Error('Make.com Webhook غير مضبوط');

  await axios.post(webhook, {
    content,
    platforms,
    scheduled_at: scheduledAt,
    timestamp: new Date().toISOString()
  });
  return true;
}

// ===== محرك النشر الرئيسي =====
async function processAndPublish(post) {
  const schedules = db.prepare('SELECT * FROM schedules WHERE enabled = 1').all();
  const logs = [];

  for (const schedule of schedules) {
    const platform = schedule.platform;
    let content = '';

    if (platform === 'twitter') content = post.rewritten_twitter;
    else if (platform === 'facebook') content = post.rewritten_facebook;
    else if (platform === 'instagram') content = post.rewritten_instagram;
    else if (platform === 'telegram') content = post.rewritten_telegram;
    else if (platform === 'blogger') content = post.rewritten_blogger;

    if (!content) continue;

    try {
      if (platform === 'telegram') {
        await publishToTelegram(content, post.id);
      } else if (['twitter', 'facebook', 'instagram'].includes(platform)) {
        const bufToken = getSetting('buffer_token');
        const makeWebhook = getSetting('make_webhook');
        if (bufToken) {
          await publishToBuffer(content, [platform]);
        } else if (makeWebhook) {
          await publishViaWebhook(content, [platform]);
        } else {
          throw new Error(`لا يوجد Buffer Token أو Make.com Webhook`);
        }
      } else if (platform === 'blogger') {
        const title = post.original_title;
        await publishToBlogger(title, content, post.id);
      }

      db.prepare(`INSERT INTO publish_log (post_id, platform, status, message) VALUES (?, ?, 'success', 'تم النشر بنجاح')`).run(post.id, platform);
      logs.push({ platform, status: 'success' });
    } catch(e) {
      db.prepare(`INSERT INTO publish_log (post_id, platform, status, message) VALUES (?, ?, 'error', ?)`).run(post.id, platform, e.message);
      logs.push({ platform, status: 'error', message: e.message });
    }
  }

  db.prepare(`UPDATE posts SET status = 'published', published_at = datetime('now') WHERE id = ?`).run(post.id);
  return logs;
}

// ===== الدورة اليومية الكاملة =====
async function dailyCycle() {
  console.log('🔄 بدء الدورة اليومية:', new Date().toISOString());
  const sources = db.prepare('SELECT * FROM sources WHERE active = 1').all();

  for (const source of sources) {
    console.log(`📡 جلب المصدر: ${source.name}`);

    let items = [];
    if (source.type === 'youtube') {
      items = await fetchYouTube(source);
    } else {
      items = await fetchRSSSource(source);
    }

    db.prepare('UPDATE sources SET last_check = datetime("now") WHERE id = ?').run(source.id);

    for (const item of items) {
      try {
        console.log(`✍️ إعادة صياغة: ${item.title}`);
        const rewritten = await rewriteContent(item.title, item.content, item.url, source.name);

        const postId = db.prepare(`
          INSERT OR IGNORE INTO posts
          (source_id, original_title, original_url, original_content, rewritten_twitter, rewritten_facebook, rewritten_instagram, rewritten_telegram, rewritten_blogger, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready')
        `).run(
          source.id, item.title, item.url, item.content,
          rewritten.twitter, rewritten.facebook, rewritten.instagram,
          rewritten.telegram, rewritten.blogger
        ).lastInsertRowid;

        if (postId) {
          const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
          const autoPublish = getSetting('auto_publish', '1');
          if (autoPublish === '1') {
            await processAndPublish(post);
          }
        }

        // انتظر قليلاً بين كل منشور لتجنب الحظر
        await new Promise(r => setTimeout(r, 3000));
      } catch(e) {
        console.error(`❌ خطأ في معالجة المحتوى:`, e.message);
        db.prepare(`INSERT INTO publish_log (post_id, platform, status, message) VALUES (0, 'system', 'error', ?)`).run(e.message);
      }
    }
  }

  console.log('✅ انتهت الدورة اليومية');
}

// ===== جدولة الدورة اليومية =====
const checkTime = getSetting('check_time') || '08:00';
const [checkHour, checkMin] = checkTime.split(':');
cron.schedule(`${checkMin || 0} ${checkHour || 8} * * *`, dailyCycle, { timezone: 'Asia/Riyadh' });
console.log(`⏰ الدورة اليومية مجدولة على الساعة ${checkTime}`);

// ===== API Routes =====

// الإعدادات
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(r => {
    if (!r.key.includes('key') && !r.key.includes('token')) {
      settings[r.key] = r.value;
    } else {
      settings[r.key] = r.value ? '***مخفي***' : '';
    }
  });
  res.json(settings);
});

app.post('/api/settings', (req, res) => {
  const { key, value } = req.body;
  setSetting(key, value);
  res.json({ success: true });
});

app.post('/api/settings/bulk', (req, res) => {
  const settings = req.body;
  Object.entries(settings).forEach(([k, v]) => setSetting(k, v));
  res.json({ success: true });
});

// المصادر
app.get('/api/sources', (req, res) => {
  res.json(db.prepare('SELECT * FROM sources ORDER BY created_at DESC').all());
});

app.post('/api/sources', (req, res) => {
  const { name, url, type } = req.body;
  try {
    const id = db.prepare('INSERT INTO sources (name, url, type) VALUES (?, ?, ?)').run(name, url, type || 'rss').lastInsertRowid;
    res.json({ success: true, id });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/sources/:id', (req, res) => {
  db.prepare('DELETE FROM sources WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.patch('/api/sources/:id/toggle', (req, res) => {
  const src = db.prepare('SELECT active FROM sources WHERE id = ?').get(req.params.id);
  db.prepare('UPDATE sources SET active = ? WHERE id = ?').run(src.active ? 0 : 1, req.params.id);
  res.json({ success: true });
});

// المنشورات
app.get('/api/posts', (req, res) => {
  const posts = db.prepare('SELECT p.*, s.name as source_name FROM posts p LEFT JOIN sources s ON p.source_id = s.id ORDER BY p.created_at DESC LIMIT 50').all();
  res.json(posts);
});

app.post('/api/posts/:id/publish', async (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'منشور غير موجود' });
  try {
    const logs = await processAndPublish(post);
    res.json({ success: true, logs });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/posts/:id', (req, res) => {
  db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// سجل النشاط
app.get('/api/logs', (req, res) => {
  const logs = db.prepare(`
    SELECT l.*, p.original_title
    FROM publish_log l
    LEFT JOIN posts p ON l.post_id = p.id
    ORDER BY l.published_at DESC LIMIT 100
  `).all();
  res.json(logs);
});

// الجداول
app.get('/api/schedules', (req, res) => {
  res.json(db.prepare('SELECT * FROM schedules').all());
});

app.post('/api/schedules/:platform', (req, res) => {
  const { enabled, time, posts_per_day } = req.body;
  db.prepare('UPDATE schedules SET enabled = ?, time = ?, posts_per_day = ? WHERE platform = ?')
    .run(enabled ? 1 : 0, time, posts_per_day, req.params.platform);
  res.json({ success: true });
});

// تشغيل يدوي
app.post('/api/run-now', async (req, res) => {
  res.json({ message: 'بدأت الدورة اليومية في الخلفية' });
  dailyCycle().catch(console.error);
});

// إحصائيات
app.get('/api/stats', (req, res) => {
  const totalPosts = db.prepare('SELECT COUNT(*) as c FROM posts').get().c;
  const publishedToday = db.prepare(`SELECT COUNT(*) as c FROM publish_log WHERE date(published_at) = date('now') AND status = 'success'`).get().c;
  const totalSources = db.prepare('SELECT COUNT(*) as c FROM sources WHERE active = 1').get().c;
  const errors = db.prepare(`SELECT COUNT(*) as c FROM publish_log WHERE status = 'error' AND date(published_at) = date('now')`).get().c;
  res.json({ totalPosts, publishedToday, totalSources, errors });
});

// اختبار الاتصال
app.post('/api/test/telegram', async (req, res) => {
  const { token, chat } = req.body;
  try {
    const r = await axios.get(`https://api.telegram.org/bot${token}/getMe`);
    if (r.data.ok) {
      setSetting('telegram_token', token);
      setSetting('telegram_chat', chat);
      res.json({ success: true, username: r.data.result.username });
    } else res.status(400).json({ error: r.data.description });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/test/ai', async (req, res) => {
  const { key, provider } = req.body;
  try {
    setSetting(provider === 'openai' ? 'openai_key' : 'claude_key', key);
    setSetting('ai_provider', provider);
    const result = await callAI('قل مرحباً فقط', 10);
    res.json({ success: true, message: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// الصفحة الرئيسية
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 السيرفر يعمل على: http://localhost:${PORT}`);
  console.log(`📊 لوحة التحكم: http://localhost:${PORT}`);
});
