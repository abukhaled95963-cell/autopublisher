require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const Parser = require('rss-parser');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const parser = new Parser();
const db = new Database('autopublisher.db');

app.use(cors());
app.use((req, res, next) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); next(); });
app.use(express.json());

// Static files
[path.join(__dirname,'public'), __dirname, path.join(process.cwd(),'public'), process.cwd()]
  .forEach(p => { try{ if(fs.existsSync(p)) app.use(express.static(p)); }catch(e){} });

// ===== DB Setup =====
db.exec(`
  CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    type TEXT DEFAULT 'rss',
    active INTEGER DEFAULT 1,
    last_check TEXT,
    item_count INTEGER DEFAULT 0,
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

['twitter','facebook','instagram','telegram','blogger'].forEach(p => {
  db.prepare(`INSERT OR IGNORE INTO schedules (platform) VALUES (?)`).run(p);
});

function getSetting(key, def='') {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : def;
}
function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(key, value);
}

// ===== AI =====
async function callAI(prompt, maxTokens=1500) {
  const provider = getSetting('ai_provider','claude');
  if(provider==='openai') {
    const key = getSetting('openai_key');
    if(!key) throw new Error('أدخل مفتاح OpenAI');
    const r = await axios.post('https://api.openai.com/v1/chat/completions',
      {model:'gpt-4o-mini',max_tokens:maxTokens,messages:[{role:'user',content:prompt}]},
      {headers:{Authorization:`Bearer ${key}`}});
    return r.data.choices[0].message.content;
  }
  const key = getSetting('claude_key');
  if(!key) throw new Error('أدخل مفتاح Claude');
  const r = await axios.post('https://api.anthropic.com/v1/messages',
    {model:'claude-sonnet-4-20250514',max_tokens:maxTokens,messages:[{role:'user',content:prompt}]},
    {headers:{'x-api-key':key,'anthropic-version':'2023-06-01'}});
  return r.data.content[0].text;
}

// ===== Rewrite =====
async function rewriteContent(title, content, url, source) {
  const tone = getSetting('writing_tone','informative');
  const lang = getSetting('content_lang','ar');
  const hashtags = getSetting('hashtags','#أخبار #تقنية');
  const langTxt = lang==='ar'?'باللغة العربية':lang==='en'?'in English':'بالعربية والإنجليزية';
  const tones = {informative:'إخباري موضوعي',analytical:'تحليلي عميق',neutral:'محايد',engaging:'جذاب وشيق'};

  const prompt = `أنت كاتب محتوى محترف. أعد كتابة هذا المحتوى بأسلوب ${tones[tone]||'إخباري'} ${langTxt} بطريقة بشرية طبيعية تماماً.

العنوان: ${title}
المصدر: ${source}
الرابط: ${url}
المحتوى: ${content.substring(0,1500)}

اكتب نسخة مختلفة لكل منصة:

[TWITTER]
نص مختصر قوي أقل من 250 حرف مع ${hashtags} والرابط
[/TWITTER]

[FACEBOOK]
منشور جذاب 100-150 كلمة مع سؤال للتفاعل والرابط
[/FACEBOOK]

[INSTAGRAM]
نص قصير 3-4 أسطر مع هاشتاقات كثيرة
[/INSTAGRAM]

[TELEGRAM]
تحليل موسع 200-300 كلمة بنقاط واضحة والرابط
[/TELEGRAM]

[BLOGGER]
مقال كامل 500-700 كلمة بعنوان ومقدمة ومحتوى منظم وخاتمة
[/BLOGGER]`;

  const result = await callAI(prompt, 2500);
  const extract = tag => {
    const m = result.match(new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[\\/${tag}\\]`,'i'));
    return m ? m[1].trim() : '';
  };
  return {
    twitter: extract('TWITTER'), facebook: extract('FACEBOOK'),
    instagram: extract('INSTAGRAM'), telegram: extract('TELEGRAM'),
    blogger: extract('BLOGGER')
  };
}

// ===== Fetch RSS =====
async function fetchRSS(source) {
  try {
    const feed = await parser.parseURL(source.url);
    const items = [];
    for(const item of (feed.items||[]).slice(0,5)) {
      if(!item.link) continue;
      const exists = db.prepare('SELECT id FROM posts WHERE original_url=?').get(item.link);
      if(!exists) items.push({
        title: item.title||'',
        url: item.link,
        content: item.contentSnippet||item.summary||item.title||''
      });
    }
    return items;
  } catch(e) {
    console.error(`RSS Error ${source.url}:`, e.message);
    return [];
  }
}

// ===== Fetch Telegram Channel (via RSS proxy) =====
async function fetchTelegramChannel(source) {
  try {
    // استخراج اسم القناة
    const ch = source.url.replace(/^https?:\/\/t\.me\//,'').replace(/^@/,'').split('/')[0];
    
    // طريقة 1: RSS عبر rsshub
    const rssUrls = [
      `https://rsshub.app/telegram/channel/${ch}`,
      `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(`https://rsshub.app/telegram/channel/${ch}`)}&count=5`
    ];

    // جرب rss2json أولاً
    try {
      const r = await axios.get(rssUrls[1], {timeout:10000});
      if(r.data.status==='ok' && r.data.items?.length>0) {
        const items = [];
        for(const item of r.data.items.slice(0,5)) {
          const url = item.link||item.guid||`https://t.me/${ch}`;
          const exists = db.prepare('SELECT id FROM posts WHERE original_url=?').get(url);
          if(!exists) {
            const content = (item.content||item.description||item.title||'')
              .replace(/<[^>]*>/g,'').trim();
            if(content.length > 20) items.push({title: content.substring(0,100), url, content});
          }
        }
        if(items.length>0) return items;
      }
    } catch(e) {}

    // جرب rsshub مباشرة
    try {
      const feed = await parser.parseURL(rssUrls[0]);
      const items = [];
      for(const item of (feed.items||[]).slice(0,5)) {
        const url = item.link||item.guid||`https://t.me/${ch}`;
        const exists = db.prepare('SELECT id FROM posts WHERE original_url=?').get(url);
        if(!exists) {
          const content = (item.contentSnippet||item.content||item.title||'')
            .replace(/<[^>]*>/g,'').trim();
          if(content.length>20) items.push({title:content.substring(0,100), url, content});
        }
      }
      return items;
    } catch(e) {}

    return [];
  } catch(e) {
    console.error('Telegram channel error:', e.message);
    return [];
  }
}

// ===== Fetch YouTube =====
async function fetchYouTube(source) {
  try {
    const url = source.url;
    const videoId = url.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/)?.[1];
    const handle = url.match(/@([a-zA-Z0-9_-]+)/)?.[1];
    const channelId = url.match(/channel\/([a-zA-Z0-9_-]+)/)?.[1];
    const ytKey = getSetting('youtube_api_key');

    if(videoId) {
      const exists = db.prepare('SELECT id FROM posts WHERE original_url LIKE ?').get(`%${videoId}%`);
      if(exists) return [];
      let title = `فيديو يوتيوب`, desc = '';
      try {
        const oe = await axios.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,{timeout:8000});
        title = oe.data.title;
      } catch(e) {}
      if(ytKey) {
        try {
          const r = await axios.get(`https://www.googleapis.com/youtube/v3/videos?id=${videoId}&key=${ytKey}&part=snippet`);
          if(r.data.items?.[0]) {
            title = r.data.items[0].snippet.title;
            desc = r.data.items[0].snippet.description?.substring(0,800)||'';
          }
        } catch(e) {}
      }
      return [{title, url:`https://www.youtube.com/watch?v=${videoId}`, content:desc||title}];
    }

    // قناة يوتيوب عبر RSS (بدون API key)
    if(handle||channelId) {
      // YouTube RSS feed
      let rssUrl = '';
      if(channelId) rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
      else if(handle && ytKey) {
        try {
          const r = await axios.get(`https://www.googleapis.com/youtube/v3/channels?forHandle=${handle}&key=${ytKey}&part=id`);
          const chId = r.data.items?.[0]?.id;
          if(chId) rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${chId}`;
        } catch(e) {}
      }
      if(!rssUrl) return [];
      
      const feed = await parser.parseURL(rssUrl);
      const items = [];
      for(const item of (feed.items||[]).slice(0,3)) {
        const vId = item.link?.match(/v=([a-zA-Z0-9_-]{11})/)?.[1];
        if(!vId) continue;
        const vidUrl = `https://www.youtube.com/watch?v=${vId}`;
        const exists = db.prepare('SELECT id FROM posts WHERE original_url=?').get(vidUrl);
        if(!exists) items.push({title:item.title||'', url:vidUrl, content:item.contentSnippet||item.title||''});
      }
      return items;
    }
    return [];
  } catch(e) {
    console.error('YouTube error:', e.message);
    return [];
  }
}

// ===== Publish =====
async function publishToTelegram(content) {
  const token = getSetting('telegram_token');
  const chat = getSetting('telegram_chat');
  if(!token||!chat) throw new Error('Telegram غير مضبوط');
  const r = await axios.post(`https://api.telegram.org/bot${token}/sendMessage`,
    {chat_id:chat, text:content, parse_mode:'HTML'});
  if(!r.data.ok) throw new Error(r.data.description);
}

async function publishToFacebook(content) {
  const pageToken = getSetting('facebook_page_token');
  const pageId = getSetting('facebook_page_id');
  if(!pageToken||!pageId) throw new Error('Facebook غير مضبوط');
  await axios.post(`https://graph.facebook.com/${pageId}/feed`,
    {message:content, access_token:pageToken});
}

async function publishToTwitter(content) {
  const webhook = getSetting('make_webhook');
  if(!webhook) throw new Error('Make.com Webhook غير مضبوط');
  await axios.post(webhook, {content, platforms:['twitter'], timestamp:new Date().toISOString()});
}

async function publishToInstagram(content) {
  const webhook = getSetting('make_webhook');
  if(!webhook) throw new Error('Make.com Webhook غير مضبوط');
  await axios.post(webhook, {content, platforms:['instagram'], timestamp:new Date().toISOString()});
}

async function publishToBlogger(title, content) {
  const blogId = getSetting('blogger_id');
  const token = getSetting('blogger_token');
  if(!blogId||!token) throw new Error('Blogger غير مضبوط');
  await axios.post(`https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/`,
    {kind:'blogger#post', title, content:`<div dir="rtl">${content.replace(/\n/g,'<br>')}</div>`},
    {headers:{Authorization:`Bearer ${token}`}});
}

// ===== Process & Publish =====
async function processAndPublish(post) {
  const schedules = db.prepare('SELECT * FROM schedules WHERE enabled=1').all();
  const logs = [];
  for(const s of schedules) {
    let content = post[`rewritten_${s.platform}`];
    if(!content) continue;
    try {
      if(s.platform==='telegram') await publishToTelegram(content);
      else if(s.platform==='facebook') await publishToFacebook(content);
      else if(s.platform==='twitter') await publishToTwitter(content);
      else if(s.platform==='instagram') await publishToInstagram(content);
      else if(s.platform==='blogger') await publishToBlogger(post.original_title, content);
      db.prepare(`INSERT INTO publish_log (post_id,platform,status,message) VALUES (?,?,'success','تم النشر')`).run(post.id, s.platform);
      logs.push({platform:s.platform, status:'success'});
    } catch(e) {
      db.prepare(`INSERT INTO publish_log (post_id,platform,status,message) VALUES (?,?,'error',?)`).run(post.id, s.platform, e.message);
      logs.push({platform:s.platform, status:'error', message:e.message});
    }
  }
  db.prepare(`UPDATE posts SET status='published', published_at=datetime('now') WHERE id=?`).run(post.id);
  return logs;
}

// ===== Daily Cycle =====
async function dailyCycle() {
  console.log('🔄 الدورة اليومية:', new Date().toISOString());
  const sources = db.prepare('SELECT * FROM sources WHERE active=1').all();
  for(const source of sources) {
    let items = [];
    if(source.type==='youtube') items = await fetchYouTube(source);
    else if(source.type==='telegram_channel') items = await fetchTelegramChannel(source);
    else items = await fetchRSS(source);

    db.prepare('UPDATE sources SET last_check=datetime("now"), item_count=? WHERE id=?').run(items.length, source.id);

    for(const item of items) {
      try {
        const rewritten = await rewriteContent(item.title, item.content, item.url, source.name);
        const result = db.prepare(`
          INSERT OR IGNORE INTO posts
          (source_id,original_title,original_url,original_content,
           rewritten_twitter,rewritten_facebook,rewritten_instagram,
           rewritten_telegram,rewritten_blogger,status)
          VALUES (?,?,?,?,?,?,?,?,?,'ready')
        `).run(source.id, item.title, item.url, item.content,
           rewritten.twitter, rewritten.facebook, rewritten.instagram,
           rewritten.telegram, rewritten.blogger);

        if(result.lastInsertRowid && getSetting('auto_publish','1')==='1') {
          const post = db.prepare('SELECT * FROM posts WHERE id=?').get(result.lastInsertRowid);
          if(post) await processAndPublish(post);
        }
        await new Promise(r=>setTimeout(r,3000));
      } catch(e) {
        console.error('Processing error:', e.message);
      }
    }
  }
  console.log('✅ انتهت الدورة');
}

// ===== Cron =====
const checkTime = getSetting('check_time','08:00');
const [h,m] = checkTime.split(':');
cron.schedule(`${m||0} ${h||8} * * *`, dailyCycle, {timezone:'Asia/Riyadh'});

// ===== API Routes =====
app.get('/api/settings', (req,res) => {
  const rows = db.prepare('SELECT key,value FROM settings').all();
  const s = {};
  rows.forEach(r => { s[r.key] = r.key.match(/key|token|secret/i) && r.value ? '***' : r.value; });
  res.json(s);
});
app.post('/api/settings', (req,res) => { setSetting(req.body.key, req.body.value); res.json({success:true}); });
app.post('/api/settings/bulk', (req,res) => { Object.entries(req.body).forEach(([k,v])=>setSetting(k,v)); res.json({success:true}); });

app.get('/api/sources', (req,res) => res.json(db.prepare('SELECT * FROM sources ORDER BY created_at DESC').all()));
app.post('/api/sources', (req,res) => {
  const {name,url,type} = req.body;
  try { res.json({success:true, id:db.prepare('INSERT INTO sources (name,url,type) VALUES (?,?,?)').run(name,url,type||'rss').lastInsertRowid}); }
  catch(e) { res.status(400).json({error:e.message}); }
});
app.delete('/api/sources/:id', (req,res) => { db.prepare('DELETE FROM sources WHERE id=?').run(req.params.id); res.json({success:true}); });
app.patch('/api/sources/:id/toggle', (req,res) => {
  const s = db.prepare('SELECT active FROM sources WHERE id=?').get(req.params.id);
  db.prepare('UPDATE sources SET active=? WHERE id=?').run(s.active?0:1, req.params.id);
  res.json({success:true});
});

app.get('/api/posts', (req,res) => res.json(
  db.prepare('SELECT p.*,s.name as source_name FROM posts p LEFT JOIN sources s ON p.source_id=s.id ORDER BY p.created_at DESC LIMIT 50').all()
));
app.post('/api/posts/:id/publish', async(req,res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id);
  if(!post) return res.status(404).json({error:'not found'});
  try { res.json({success:true, logs: await processAndPublish(post)}); }
  catch(e) { res.status(500).json({error:e.message}); }
});
app.delete('/api/posts/:id', (req,res) => { db.prepare('DELETE FROM posts WHERE id=?').run(req.params.id); res.json({success:true}); });

app.get('/api/logs', (req,res) => res.json(
  db.prepare('SELECT l.*,p.original_title FROM publish_log l LEFT JOIN posts p ON l.post_id=p.id ORDER BY l.published_at DESC LIMIT 100').all()
));

app.get('/api/schedules', (req,res) => res.json(db.prepare('SELECT * FROM schedules').all()));
app.post('/api/schedules/:platform', (req,res) => {
  const {enabled,time,posts_per_day} = req.body;
  db.prepare('UPDATE schedules SET enabled=?,time=?,posts_per_day=? WHERE platform=?').run(enabled?1:0,time,posts_per_day,req.params.platform);
  res.json({success:true});
});

app.get('/api/stats', (req,res) => res.json({
  totalPosts: db.prepare('SELECT COUNT(*) as c FROM posts').get().c,
  publishedToday: db.prepare(`SELECT COUNT(*) as c FROM publish_log WHERE date(published_at)=date('now') AND status='success'`).get().c,
  totalSources: db.prepare('SELECT COUNT(*) as c FROM sources WHERE active=1').get().c,
  errors: db.prepare(`SELECT COUNT(*) as c FROM publish_log WHERE status='error' AND date(published_at)=date('now')`).get().c
}));

app.post('/api/run-now', (req,res) => { res.json({message:'بدأت الدورة'}); dailyCycle().catch(console.error); });

// ===== Test Endpoints =====
app.post('/api/test/telegram', async(req,res) => {
  const {token,chat} = req.body;
  try {
    const r = await axios.get(`https://api.telegram.org/bot${token}/getMe`);
    if(r.data.ok) { setSetting('telegram_token',token); if(chat)setSetting('telegram_chat',chat); res.json({success:true,username:r.data.result.username}); }
    else res.status(400).json({error:r.data.description});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/test/facebook', async(req,res) => {
  const {page_token, page_id} = req.body;
  try {
    const r = await axios.get(`https://graph.facebook.com/${page_id}?access_token=${page_token}&fields=name,id`);
    setSetting('facebook_page_token', page_token);
    setSetting('facebook_page_id', page_id);
    res.json({success:true, name:r.data.name});
  } catch(e) { res.status(500).json({error: e.response?.data?.error?.message||e.message}); }
});

app.post('/api/test/ai', async(req,res) => {
  const {key,provider} = req.body;
  try {
    setSetting(provider==='openai'?'openai_key':'claude_key', key);
    setSetting('ai_provider', provider);
    const result = await callAI('قل مرحباً فقط', 10);
    res.json({success:true, message:result});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/test/telegram-channel', async(req,res) => {
  const {channel} = req.body;
  try {
    const ch = channel.replace('@','').replace('https://t.me/','');
    const rssUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(`https://rsshub.app/telegram/channel/${ch}`)}&count=3`;
    const r = await axios.get(rssUrl, {timeout:10000});
    if(r.data.status==='ok' && r.data.items?.length>0) {
      res.json({success:true, count:r.data.items.length, sample:r.data.items[0].title?.substring(0,100)});
    } else {
      res.json({success:false, error:'لم يتم العثور على منشورات — تأكد أن القناة عامة'});
    }
  } catch(e) { res.status(500).json({error:e.message}); }
});

// YouTube analysis
app.post('/api/analyze/youtube', async(req,res) => {
  const {url} = req.body;
  const videoId = url?.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/)?.[1];
  if(!videoId) return res.status(400).json({error:'رابط يوتيوب غير صحيح'});
  try {
    let title = `فيديو يوتيوب`, desc = '', channel = '';
    try {
      const oe = await axios.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,{timeout:8000});
      title = oe.data.title; channel = oe.data.author_name;
    } catch(e) {}
    const ytKey = getSetting('youtube_api_key');
    if(ytKey) {
      try {
        const r = await axios.get(`https://www.googleapis.com/youtube/v3/videos?id=${videoId}&key=${ytKey}&part=snippet`);
        if(r.data.items?.[0]) { title=r.data.items[0].snippet.title; desc=r.data.items[0].snippet.description?.substring(0,1000)||''; }
      } catch(e) {}
    }
    const vidUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const rewritten = await rewriteContent(title, desc||title, vidUrl, channel||'يوتيوب');
    res.json({success:true, title, channel, videoId, thumb:`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`, rewritten});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Facebook OAuth helper
app.get('/api/facebook/auth-url', (req,res) => {
  const appId = getSetting('facebook_app_id');
  if(!appId) return res.json({error:'أدخل Facebook App ID أولاً'});
  const redirectUri = encodeURIComponent(`${req.protocol}://${req.get('host')}/api/facebook/callback`);
  const scope = 'pages_manage_posts,pages_read_engagement,pages_show_list';
  res.json({url:`https://www.facebook.com/dialog/oauth?client_id=${appId}&redirect_uri=${redirectUri}&scope=${scope}&response_type=code`});
});

app.get('/', (req,res) => {
  const tryPaths = [
    path.join(__dirname,'public','index.html'),
    path.join(__dirname,'index.html'),
    path.join(process.cwd(),'public','index.html'),
    path.join(process.cwd(),'index.html')
  ];
  for(const p of tryPaths) { try{ if(fs.existsSync(p)) return res.sendFile(p); }catch(e){} }
  res.send('<h2>✅ Server Running!</h2><p>public/index.html not found</p>');
});

const PORT = process.env.PORT||3000;
app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));

// ===== YouTube Analysis =====
app.post('/api/youtube/analyze', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'أدخل رابط الفيديو' });

  const videoId = url.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/)?.[1];
  if (!videoId) return res.status(400).json({ error: 'رابط يوتيوب غير صحيح' });

  try {
    let title = `فيديو يوتيوب ${videoId}`;
    let description = '';
    let channelName = '';
    const ytKey = getSetting('youtube_api_key');

    // جلب معلومات الفيديو
    if (ytKey) {
      const r = await axios.get(`https://www.googleapis.com/youtube/v3/videos?id=${videoId}&key=${ytKey}&part=snippet,contentDetails`);
      if (r.data.items?.[0]) {
        title = r.data.items[0].snippet.title;
        description = r.data.items[0].snippet.description?.substring(0, 1000) || '';
        channelName = r.data.items[0].snippet.channelTitle;
      }
    } else {
      try {
        const oe = await axios.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
        title = oe.data.title;
        channelName = oe.data.author_name;
      } catch(e) {}
    }

    // تحليل بالذكاء الاصطناعي
    const lang = getSetting('content_lang', 'ar');
    const langTxt = lang === 'ar' ? 'باللغة العربية' : 'in English';
    const prompt = `حلّل هذا الفيديو وأعد صياغته ${langTxt}:
عنوان: "${title}"
القناة: ${channelName}
الوصف: ${description}
الرابط: https://www.youtube.com/watch?v=${videoId}

اكتب:
[SUMMARY] ملخص شامل 200-300 كلمة [/SUMMARY]
[TWITTER] منشور تويتر مختصر مع الرابط [/TWITTER]
[FACEBOOK] منشور فيسبوك جذاب مع الرابط [/FACEBOOK]
[INSTAGRAM] نص إنستغرام مع هاشتاقات [/INSTAGRAM]
[TELEGRAM] تحليل موسع للتيليغرام مع الرابط [/TELEGRAM]`;

    const aiResult = await callAI(prompt, 2000);

    const extract = (tag) => {
      const m = aiResult.match(new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[\\/${tag}\\]`, 'i'));
      return m ? m[1].trim() : '';
    };

    res.json({
      success: true,
      videoId,
      title,
      channelName,
      thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      summary: extract('SUMMARY'),
      twitter: extract('TWITTER'),
      facebook: extract('FACEBOOK'),
      instagram: extract('INSTAGRAM'),
      telegram: extract('TELEGRAM')
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== Telegram Channel as Source =====
app.post('/api/telegram/channel/fetch', async (req, res) => {
  const { channel } = req.body;
  if (!channel) return res.status(400).json({ error: 'أدخل اسم القناة' });

  const ch = channel.replace('@', '').trim();
  const results = [];
  const errors = [];

  // محاولة 1: RSS via rss2json
  try {
    const rssUrl = `https://rsshub.app/telegram/channel/${ch}`;
    const r = await axios.get(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}&count=10`, { timeout: 8000 });
    if (r.data.status === 'ok' && r.data.items?.length > 0) {
      r.data.items.forEach(item => {
        results.push({
          text: (item.content || item.title || '').replace(/<[^>]*>/g, '').substring(0, 500),
          date: item.pubDate,
          source: 'rsshub'
        });
      });
    }
  } catch(e) { errors.push('rsshub: ' + e.message); }

  // محاولة 2: t.me/s scraping via proxy
  if (results.length === 0) {
    try {
      const r = await axios.get(`https://t.me/s/${ch}`, {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bot)' }
      });
      const $ = cheerio.load(r.data);
      $('.tgme_widget_message_text').each((i, el) => {
        if (i < 10) {
          results.push({
            text: $(el).text().trim().substring(0, 500),
            date: new Date().toISOString(),
            source: 'tme'
          });
        }
      });
    } catch(e) { errors.push('tme: ' + e.message); }
  }

  if (results.length > 0) {
    res.json({ success: true, channel: ch, posts: results });
  } else {
    res.json({ success: false, channel: ch, posts: [], errors, message: 'القناة خاصة أو لا تدعم القراءة الآلية' });
  }
});

// ===== Facebook Page Post =====
app.post('/api/publish/facebook', async (req, res) => {
  const { message, pageId } = req.body;
  const pageToken = getSetting('facebook_page_token');
  const pid = pageId || getSetting('facebook_page_id');

  if (!pageToken || !pid) return res.status(400).json({ error: 'أدخل Facebook Page Token و Page ID في الإعدادات' });

  try {
    const r = await axios.post(`https://graph.facebook.com/v19.0/${pid}/feed`, {
      message,
      access_token: pageToken
    });
    res.json({ success: true, postId: r.data.id });
  } catch(e) {
    res.status(500).json({ error: e.data?.error?.message || e.message });
  }
});

// ===== Test Facebook =====
app.post('/api/test/facebook', async (req, res) => {
  const { pageToken, pageId } = req.body;
  try {
    const r = await axios.get(`https://graph.facebook.com/v19.0/me?access_token=${pageToken}`);
    if (r.data.id) {
      setSetting('facebook_page_token', pageToken);
      setSetting('facebook_page_id', pageId);
      res.json({ success: true, name: r.data.name });
    } else {
      res.status(400).json({ error: 'توكن غير صحيح' });
    }
  } catch(e) {
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// ===== Auto Update via GitHub API =====
app.post('/api/auto-update', async (req, res) => {
  const { request, ai_provider } = req.body;
  if (!request) return res.status(400).json({ error: 'أدخل طلب التعديل' });

  // تحديد AI المستخدم مؤقتاً
  const originalProvider = getSetting('ai_provider');
  if (ai_provider) setSetting('ai_provider', ai_provider);

  const githubToken = getSetting('github_token');
  const githubRepo = getSetting('github_repo'); // format: username/repo
  if (!githubToken || !githubRepo) {
    return res.status(400).json({ error: 'أدخل GitHub Token والمستودع في الإعدادات' });
  }

  try {
    // 1. جلب محتوى الملف الحالي من GitHub
    const fileRes = await axios.get(
      `https://api.github.com/repos/${githubRepo}/contents/public/index.html`,
      { headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github.v3+json' } }
    );
    const currentContent = Buffer.from(fileRes.data.content, 'base64').toString('utf-8');
    const fileSha = fileRes.data.sha;

    // 2. طلب التعديل من AI
    const prompt = `أنت مطور ويب محترف. لديك ملف HTML التالي لتطبيق نشر آلي:

${currentContent.substring(0, 8000)}

المطلوب: ${request}

مهم جداً:
- أعد الملف كاملاً مع التعديل المطلوب فقط
- لا تغير أي شيء آخر
- أعد HTML كاملاً فقط بدون أي شرح أو نص إضافي
- ابدأ مباشرة بـ <!DOCTYPE html>`;

    const newContent = await callAI(prompt, 4000);

    // تنظيف الرد
    const cleanContent = newContent
      .replace(/^```html\n?/i, '')
      .replace(/^```\n?/i, '')
      .replace(/\n?```$/i, '')
      .trim();

    // 3. رفع الملف المعدّل على GitHub
    const encodedContent = Buffer.from(cleanContent).toString('base64');
    await axios.put(
      `https://api.github.com/repos/${githubRepo}/contents/public/index.html`,
      {
        message: `تحديث تلقائي: ${request.substring(0, 50)}`,
        content: encodedContent,
        sha: fileSha
      },
      { headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github.v3+json' } }
    );

    if (ai_provider) setSetting('ai_provider', originalProvider);
    // زيادة رقم الإصدار
    const currentVer = getSetting('app_version', '1.0.0');
    const newVer = incrementVersion(currentVer);
    setSetting('app_version', newVer);
    setSetting('last_update', new Date().toISOString());
    setSetting('update_notes', request);
    setSetting('update_seen', '0'); // إشعار بالتحديث
    res.json({ success: true, message: `تم التعديل ورفعه على GitHub — الإصدار الجديد: v${newVer}`, version: newVer });
  } catch(e) {
    if (ai_provider) setSetting('ai_provider', originalProvider);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// Test GitHub connection
app.post('/api/test/github', async (req, res) => {
  const { token, repo } = req.body;
  try {
    const r = await axios.get(`https://api.github.com/repos/${repo}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    setSetting('github_token', token);
    setSetting('github_repo', repo);
    res.json({ success: true, name: r.data.full_name });
  } catch(e) {
    res.status(400).json({ error: e.response?.data?.message || e.message });
  }
});


// ===== Rollback to Previous Version =====
app.get('/api/github/commits', async (req, res) => {
  const githubToken = getSetting('github_token');
  const githubRepo = getSetting('github_repo');
  if (!githubToken || !githubRepo) return res.status(400).json({ error: 'GitHub غير مضبوط' });

  try {
    const r = await axios.get(
      `https://api.github.com/repos/${githubRepo}/commits?path=public/index.html&per_page=10`,
      { headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github.v3+json' } }
    );
    const commits = r.data.map(c => ({
      sha: c.sha,
      message: c.commit.message,
      date: c.commit.author.date,
      author: c.commit.author.name
    }));
    res.json({ success: true, commits });
  } catch(e) {
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

app.post('/api/github/rollback', async (req, res) => {
  const { sha } = req.body;
  if (!sha) return res.status(400).json({ error: 'أدخل رقم الإصدار' });

  const githubToken = getSetting('github_token');
  const githubRepo = getSetting('github_repo');
  if (!githubToken || !githubRepo) return res.status(400).json({ error: 'GitHub غير مضبوط' });

  try {
    // 1. جلب محتوى الملف من الإصدار القديم
    const oldFileRes = await axios.get(
      `https://api.github.com/repos/${githubRepo}/contents/public/index.html?ref=${sha}`,
      { headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github.v3+json' } }
    );
    const oldContent = oldFileRes.data.content; // base64

    // 2. جلب SHA الحالي للملف
    const currentFileRes = await axios.get(
      `https://api.github.com/repos/${githubRepo}/contents/public/index.html`,
      { headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github.v3+json' } }
    );
    const currentSha = currentFileRes.data.sha;

    // 3. رفع الإصدار القديم كإصدار جديد
    await axios.put(
      `https://api.github.com/repos/${githubRepo}/contents/public/index.html`,
      {
        message: `↩️ رجوع للإصدار: ${sha.substring(0, 7)}`,
        content: oldContent,
        sha: currentSha
      },
      { headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github.v3+json' } }
    );

    res.json({ success: true, message: `✅ تم الرجوع للإصدار ${sha.substring(0, 7)} — Railway سيحدّث خلال دقيقة` });
  } catch(e) {
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ===== Version Management =====
app.get('/api/version', (req, res) => {
  const version = getSetting('app_version', '1.0.0');
  const lastUpdate = getSetting('last_update', '');
  const updateNotes = getSetting('update_notes', '');
  const updateSeen = getSetting('update_seen', '1');
  res.json({ version, lastUpdate, updateNotes, updateSeen });
});

app.post('/api/version/seen', (req, res) => {
  setSetting('update_seen', '1');
  res.json({ success: true });
});

function incrementVersion(version) {
  const parts = version.split('.').map(Number);
  parts[2] = (parts[2] || 0) + 1;
  if (parts[2] >= 10) { parts[2] = 0; parts[1]++; }
  if (parts[1] >= 10) { parts[1] = 0; parts[0]++; }
  return parts.join('.');
}
