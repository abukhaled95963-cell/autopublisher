require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const Parser = require('rss-parser');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const os = require('os');
const FormData = require('form-data');

const app = express();
const parser = new Parser();
// NOTE: On Railway free tier, SQLite is reset on redeploy
// To persist data: add a Railway Volume mounted at /app/data
const DB_PATH = process.env.DB_PATH || '/app/data/autopublisher.db';
// Ensure data directory exists
const dbDir = require('path').dirname(DB_PATH);
if(!require('fs').existsSync(dbDir)) {
  try { require('fs').mkdirSync(dbDir, {recursive:true}); } catch(e) {}
}
const db = new Database(require('fs').existsSync(dbDir) ? DB_PATH : 'autopublisher.db');

app.use(cors());
app.use(express.json());

// Static files
const publicPath = path.join(__dirname, 'public');
if(fs.existsSync(publicPath)) app.use(express.static(publicPath));

// ===== Database =====
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
`);

function getSetting(key, def) { 
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key); 
  return r ? r.value : (def||''); 
}
function setSetting(key, val) { 
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, val); 
}

// ===== AI =====
async function callAI(prompt, maxTokens) {
  maxTokens = maxTokens || 800;
  const primaryProvider = getSetting('ai_provider', 'groq');
  const allProviders = ['groq', 'gemini', 'claude', 'openai'];
  const providers = [primaryProvider, ...allProviders.filter(p => p !== primaryProvider)];
  let lastError = null;
  for(const provider of providers) {
    try {
      let key = '';
      if(provider === 'groq') key = getSetting('groq_key');
      else if(provider === 'gemini') key = getSetting('gemini_key');
      else if(provider === 'claude') key = getSetting('claude_key');
      else if(provider === 'openai') key = getSetting('openai_key');
      if(!key) { console.log('No key for', provider, '- skipping'); continue; }
      console.log('Trying AI provider:', provider);
      if(provider === 'groq') {
        const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
          {model:'llama3-8b-8192', max_tokens:maxTokens, messages:[{role:'user',content:prompt}]},
          {headers:{Authorization:'Bearer '+key}, timeout:30000}
        );
        return r.data.choices[0].message.content;
      } else if(provider === 'gemini') {
        try {
          const r = await axios.post(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
            {contents:[{parts:[{text:prompt}]}], generationConfig:{maxOutputTokens:maxTokens}},
            {headers:{'x-goog-api-key': key, 'Content-Type':'application/json'}, timeout:30000}
          );
          return r.data.candidates[0].content.parts[0].text;
        } catch(e) {
          console.error('Gemini error status:', e.response?.status);
          console.error('Gemini error data:', JSON.stringify(e.response?.data));
          throw e;
        }
      } else if(provider === 'claude') {
        const r = await axios.post('https://api.anthropic.com/v1/messages',
          {model:'claude-haiku-4-5-20251001', max_tokens:maxTokens, messages:[{role:'user',content:prompt}]},
          {headers:{'x-api-key':key,'anthropic-version':'2023-06-01'}, timeout:30000}
        );
        return r.data.content[0].text;
      } else if(provider === 'openai') {
        const r = await axios.post('https://api.openai.com/v1/chat/completions',
          {model:'gpt-4o-mini', max_tokens:maxTokens, messages:[{role:'user',content:prompt}]},
          {headers:{Authorization:'Bearer '+key}, timeout:30000}
        );
        return r.data.choices[0].message.content;
      }
    } catch(e) {
      lastError = e;
      const status = e.response?.status;
      console.log('Provider', provider, 'failed:', status || e.message, '- trying next...');
      if(status === 429) await new Promise(r=>setTimeout(r,2000));
      continue;
    }
  }
  throw new Error('All AI providers failed. Last: ' + (lastError?.message || 'unknown'));
}

// ===== Text filters =====
function filterSourceLinks(text) {
  if(!text) return '';
  return text
    .replace(/https?:\/\/t\.me\/[^\s)]+/gi, '')
    .replace(/\bt\.me\/[^\s)]+/gi, '')
    .replace(/@[A-Za-z0-9_]{3,}/g, '')
    .replace(/(?:المصدر|source)\s*[:：].*$/gim, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function isArabicText(text) {
  if(!text) return false;
  const arabic = (text.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
  const total = text.replace(/[\s\d\W]/g, '').length;
  return total > 0 && (arabic / total) > 0.3;
}

// ===== Telegram Channel Reader (multiple methods) =====
async function readTelegramChannel(channel) {
  const ch = channel.replace('@','').trim();
  const results = [];
  
  // Method 1: rss2json + rsshub
  try {
    const rssUrl = 'https://rsshub.app/telegram/channel/' + ch;
    const r = await axios.get('https://api.rss2json.com/v1/api.json?rss_url='+encodeURIComponent(rssUrl)+'&count=10', {timeout:8000});
    if(r.data.status==='ok' && r.data.items && r.data.items.length > 0) {
      r.data.items.forEach(item => {
        const text = (item.content||item.title||'').replace(/<[^>]*>/g,'').trim();
        if(text) results.push({text, date:item.pubDate, source:'rsshub'});
      });
      if(results.length > 0) return {success:true, posts:results, method:'rsshub'};
    }
  } catch(e) {}

  // Method 2: t.me/s scraping with media
  try {
    const r = await axios.get('https://t.me/s/'+ch, {
      timeout:10000,
      headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    });
    const $ = cheerio.load(r.data);
    $('.tgme_widget_message').each(function(i, msgEl) {
      if(i >= 10) return;
      const text = $(msgEl).find('.tgme_widget_message_text').text().trim();
      const media = [];

      // Extract photos
      $(msgEl).find('.tgme_widget_message_photo_wrap').each(function(j, el) {
        const style = $(el).attr('style')||'';
        const match = style.match(/url\(['"]?([^'"()]+)['"]?\)/);
        if(match) media.push({type:'photo', url:match[1]});
      });

      // Extract video thumbnail
      $(msgEl).find('.tgme_widget_message_video_wrap video, .tgme_widget_message_video').each(function(j, el) {
        const src = $(el).attr('src')||$(el).find('source').attr('src')||'';
        if(src) media.push({type:'video', url:src});
      });

      // Extract video thumb from style
      $(msgEl).find('[class*="video"]').each(function(j, el) {
        const style = $(el).attr('style')||'';
        const match = style.match(/url\(['"]?([^'"()]+)['"]?\)/);
        if(match && !media.find(m=>m.url===match[1])) {
          media.push({type:'video_thumb', url:match[1]});
        }
      });

      if(text || media.length > 0) {
        results.push({
          text: text.substring(0,500)||'',
          date: new Date().toISOString(),
          source: 'tme',
          media: media
        });
      }
    });
    if(results.length > 0) return {success:true, posts:results, method:'tme_scrape'};
  } catch(e) {}

  // Method 3: Alternative RSS feed
  try {
    const r = await axios.get('https://api.rss2json.com/v1/api.json?rss_url='+encodeURIComponent('https://t.me/s/'+ch), {timeout:8000});
    if(r.data.status==='ok' && r.data.items && r.data.items.length > 0) {
      r.data.items.forEach(item => {
        const text = (item.content||item.title||'').replace(/<[^>]*>/g,'').trim();
        if(text) results.push({text, date:item.pubDate, source:'tme_rss'});
      });
      if(results.length > 0) return {success:true, posts:results, method:'tme_rss'};
    }
  } catch(e) {}

  return {
    success:false, posts:[], 
    message:'تعذر قراءة القناة @'+ch+'. تأكد أن القناة عامة (Public) وغير محظورة في منطقتك.'
  };
}

// ===== Rewrite Content =====
async function rewriteContent(title, content, url, source) {
  const lang = getSetting('content_lang','ar');
  const tone = getSetting('writing_tone','informative');
  const hashtags = getSetting('hashtags','#أخبار #تقنية');
  const langTxt = lang==='ar'?'باللغة العربية':lang==='en'?'in English':'بالعربية والإنجليزية';
  const toneMap = {informative:'إخباري',analytical:'تحليلي',engaging:'جذاب',neutral:'محايد'};

  const prompt = `أنت كاتب محتوى محترف. أعد صياغة هذا المحتوى بأسلوب ${toneMap[tone]||'إخباري'} ${langTxt} بطريقة بشرية طبيعية.

العنوان: ${title}
الرابط: ${url}
المحتوى: ${(content||'').substring(0,1000)}

مهم: لا تذكر اسم المصدر أو القناة الأصلية في النص.

اكتب لكل منصة:
[TWITTER]نص مختصر أقل من 250 حرف + ${hashtags}[/TWITTER]
[FACEBOOK]فقرة جذابة 100 كلمة + سؤال للتفاعل[/FACEBOOK]
[INSTAGRAM]نص قصير + هاشتاقات[/INSTAGRAM]
[TELEGRAM]تحليل موسع 200 كلمة + نقاط واضحة[/TELEGRAM]
[BLOGGER]مقال كامل 400 كلمة بعنوان ومقدمة وخاتمة[/BLOGGER]`;

  const result = await callAI(prompt, 2000);
  const extract = tag => {
    const m = result.match(new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[\\/${tag}\\]`,'i'));
    return m ? m[1].trim() : '';
  };
  return {
    twitter:extract('TWITTER'), facebook:extract('FACEBOOK'),
    instagram:extract('INSTAGRAM'), telegram:extract('TELEGRAM'), blogger:extract('BLOGGER')
  };
}

// ===== Fetch RSS =====
async function fetchRSS(source) {
  try {
    const rssUrl = 'https://api.rss2json.com/v1/api.json?rss_url='+encodeURIComponent(source.url)+'&count=5';
    const r = await axios.get(rssUrl, {timeout:10000});
    if(r.data.status==='ok' && r.data.items) {
      return r.data.items.filter(item => item.link).map(item => ({
        title:item.title||'',
        url:item.link,
        content:(item.contentSnippet||item.description||item.title||'').substring(0,500)
      }));
    }
  } catch(e) {}
  // Try direct RSS parse
  try {
    const feed = await parser.parseURL(source.url);
    return feed.items.slice(0,5).map(item => ({
      title:item.title||'',
      url:item.link||'',
      content:(item.contentSnippet||item.content||item.title||'').substring(0,500)
    }));
  } catch(e) {}
  return [];
}

// ===== YouTube =====
async function fetchYouTube(source) {
  const videoId = source.url.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/)?.[1];
  if(!videoId) return [];
  const existing = db.prepare('SELECT id FROM posts WHERE original_url LIKE ?').get('%'+videoId+'%');
  if(existing) return [];
  let title = 'YouTube Video ' + videoId, ch = 'YouTube';
  try {
    const oe = await axios.get('https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v='+videoId+'&format=json');
    title = oe.data.title; ch = oe.data.author_name;
  } catch(e) {}
  return [{title, url:'https://www.youtube.com/watch?v='+videoId, content:title}];
}

// ===== Publish =====
async function publishPost(post) {
  const logs = [];
  const tgToken = getSetting('telegram_token');
  const tgChat = getSetting('telegram_chat');
  const webhook = getSetting('make_webhook');
  const fbToken = getSetting('facebook_page_token');
  const fbPageId = getSetting('facebook_page_id');

  // Telegram
  if(tgToken && tgChat && post.rewritten_telegram) {
    try {
      const r = await axios.post(`https://api.telegram.org/bot${tgToken}/sendMessage`,{
        chat_id:tgChat, text:post.rewritten_telegram, parse_mode:'HTML'
      });
      logs.push({platform:'telegram', status:r.data.ok?'success':'error'});
    } catch(e) { logs.push({platform:'telegram', status:'error', message:e.message}); }
  }

  // Facebook direct
  if(fbToken && fbPageId && post.rewritten_facebook) {
    try {
      await axios.post(`https://graph.facebook.com/v19.0/${fbPageId}/feed`,{
        message:post.rewritten_facebook, access_token:fbToken
      });
      logs.push({platform:'facebook', status:'success'});
    } catch(e) { logs.push({platform:'facebook', status:'error', message:e.message}); }
  }

  // Make.com for Twitter/Instagram
  if(webhook) {
    try {
      await axios.post(webhook, {
        content:post.rewritten_twitter||post.rewritten_facebook||'',
        platforms:['twitter','instagram'],
        timestamp:new Date().toISOString()
      });
      logs.push({platform:'twitter/instagram', status:'success'});
    } catch(e) { logs.push({platform:'twitter/instagram', status:'error', message:e.message}); }
  }

  logs.forEach(l => {
    db.prepare('INSERT INTO publish_log(post_id,platform,status,message) VALUES(?,?,?,?)').run(
      post.id, l.platform, l.status, l.message||''
    );
  });
  db.prepare("UPDATE posts SET status='published', published_at=datetime('now') WHERE id=?").run(post.id);
  return logs;
}

// ===== Daily Cycle =====
async function dailyCycle() {
  console.log('Daily cycle started:', new Date().toISOString());
  const sources = db.prepare('SELECT * FROM sources WHERE active=1').all();
  for(const src of sources) {
    let items = [];
    try {
      if(src.type==='youtube') items = await fetchYouTube(src);
      else if(src.type==='telegram') {
        const r = await readTelegramChannel(src.url);
        if(r.success) items = r.posts.slice(0,3).map(p=>({title:p.text.substring(0,80),url:src.url,content:p.text}));
      } else items = await fetchRSS(src);
    } catch(e) { console.error('Source error:', src.name, e.message); }

    db.prepare("UPDATE sources SET last_check=datetime('now') WHERE id=?").run(src.id);

    for(const item of items) {
      if(!item.url) continue;
      const exists = db.prepare('SELECT id FROM posts WHERE original_url=?').get(item.url);
      if(exists) continue;
      try {
        const rw = await rewriteContent(item.title, item.content, item.url, src.name);
        const pid = db.prepare(`INSERT OR IGNORE INTO posts 
          (source_id,original_title,original_url,original_content,rewritten_twitter,rewritten_facebook,rewritten_instagram,rewritten_telegram,rewritten_blogger,status)
          VALUES(?,?,?,?,?,?,?,?,?,'ready')`)
          .run(src.id,item.title,item.url,item.content,rw.twitter,rw.facebook,rw.instagram,rw.telegram,rw.blogger)
          .lastInsertRowid;
        if(pid && getSetting('auto_publish','1')==='1') {
          const post = db.prepare('SELECT * FROM posts WHERE id=?').get(pid);
          await publishPost(post);
        }
        await new Promise(r=>setTimeout(r,2000));
      } catch(e) { console.error('Item error:', e.message); }
    }
  }
  console.log('Daily cycle done');
}

// Schedule
const checkTime = getSetting('check_time','08:00');
cron.schedule(`${checkTime.split(':')[1]||0} ${checkTime.split(':')[0]||8} * * *`, dailyCycle, {timezone:'Asia/Riyadh'});

// ===== API Routes =====
app.get('/api/stats', (req,res) => {
  res.json({
    totalSources: db.prepare('SELECT COUNT(*) c FROM sources WHERE active=1').get().c,
    totalPosts: db.prepare('SELECT COUNT(*) c FROM posts').get().c,
    publishedToday: db.prepare("SELECT COUNT(*) c FROM publish_log WHERE date(published_at)=date('now') AND status='success'").get().c,
    errors: db.prepare("SELECT COUNT(*) c FROM publish_log WHERE date(published_at)=date('now') AND status='error'").get().c
  });
});

app.get('/api/sources', (req,res) => res.json(db.prepare('SELECT * FROM sources ORDER BY created_at DESC').all()));
app.post('/api/sources', (req,res) => {
  const {name,url,type} = req.body;
  try { res.json({success:true, id:db.prepare('INSERT INTO sources(name,url,type) VALUES(?,?,?)').run(name,url,type||'rss').lastInsertRowid}); }
  catch(e) { res.status(400).json({error:e.message}); }
});
app.delete('/api/sources/:id', (req,res) => { db.prepare('DELETE FROM sources WHERE id=?').run(req.params.id); res.json({success:true}); });
app.patch('/api/sources/:id/toggle', (req,res) => {
  const s = db.prepare('SELECT active FROM sources WHERE id=?').get(req.params.id);
  db.prepare('UPDATE sources SET active=? WHERE id=?').run(s.active?0:1, req.params.id);
  res.json({success:true});
});

app.get('/api/posts', (req,res) => res.json(db.prepare('SELECT p.*,s.name source_name FROM posts p LEFT JOIN sources s ON p.source_id=s.id ORDER BY p.created_at DESC LIMIT 50').all()));
app.post('/api/posts/:id/publish', async(req,res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id);
  if(!post) return res.status(404).json({error:'Not found'});
  try { res.json({success:true, logs:await publishPost(post)}); }
  catch(e) { res.status(500).json({error:e.message}); }
});
app.delete('/api/posts/:id', (req,res) => { db.prepare('DELETE FROM posts WHERE id=?').run(req.params.id); res.json({success:true}); });

app.get('/api/logs', (req,res) => res.json(db.prepare('SELECT l.*,p.original_title FROM publish_log l LEFT JOIN posts p ON l.post_id=p.id ORDER BY l.published_at DESC LIMIT 100').all()));

app.get('/api/settings', (req,res) => {
  const rows = db.prepare('SELECT key,value FROM settings').all();
  const s = {};
  rows.forEach(r => { s[r.key] = r.key.match(/key|token|secret|password/) ? (r.value?'***':'') : r.value; });
  res.json(s);
});
app.post('/api/settings/bulk', (req,res) => {
  Object.entries(req.body).forEach(([k,v]) => setSetting(k,v));
  res.json({success:true});
});

// ===== Telegram Channel API =====
app.post('/api/telegram/channel/fetch', async(req,res) => {
  const {channel} = req.body;
  if(!channel) return res.status(400).json({error:'Channel required'});
  const result = await readTelegramChannel(channel);
  res.json(result);
});

// Test last message from channel (verify reading works)
app.post('/api/telegram/channel/test-post', async(req,res) => {
  const {channel} = req.body;
  const tgToken = getSetting('telegram_token');
  const tgChat = getSetting('telegram_chat');
  if(!tgToken || !tgChat) return res.status(400).json({error:'Bot token and chat not configured'});
  
  const chResult = await readTelegramChannel(channel);
  if(!chResult.success || !chResult.posts.length) {
    return res.json({success:false, message:chResult.message||'No posts found'});
  }
  
  const lastPost = chResult.posts[0];
  const testMsg = `📢 آخر رسالة من @${channel.replace('@','')}:\n\n${lastPost.text.substring(0,300)}`;
  
  try {
    await axios.post(`https://api.telegram.org/bot${tgToken}/sendMessage`,{
      chat_id:tgChat, text:testMsg, parse_mode:'HTML'
    });
    res.json({success:true, message:'تم إرسال آخر رسالة من القناة لقناتك بنجاح', post:lastPost});
  } catch(e) {
    res.status(500).json({error:e.message});
  }
});

// YouTube analyze
app.post('/api/youtube/analyze', async(req,res) => {
  const {url} = req.body;
  if(!url) return res.status(400).json({error:'URL required'});
  const videoId = url.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/)?.[1];
  if(!videoId) return res.status(400).json({error:'Invalid YouTube URL'});
  let title='YouTube Video', ch='YouTube';
  try {
    const oe = await axios.get('https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v='+videoId+'&format=json');
    title=oe.data.title; ch=oe.data.author_name;
  } catch(e){}
  const lang = getSetting('content_lang','ar');
  const langTxt = lang==='ar'?'باللغة العربية':'in English';
  const prompt = `حلّل هذا الفيديو وأنتج محتوى ${langTxt}:
العنوان: "${title}" | القناة: ${ch} | الرابط: https://youtu.be/${videoId}
[SUMMARY]ملخص 200 كلمة[/SUMMARY]
[TWITTER]تغريدة مختصرة + رابط[/TWITTER]
[FACEBOOK]منشور فيسبوك + رابط[/FACEBOOK]
[INSTAGRAM]نص إنستغرام + هاشتاقات[/INSTAGRAM]
[TELEGRAM]تحليل موسع + رابط[/TELEGRAM]`;
  try {
    const result = await callAI(prompt, 2000);
    const extract = tag => { const m=result.match(new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[\\/${tag}\\]`,'i')); return m?m[1].trim():''; };
    res.json({success:true,videoId,title,channelName:ch,thumbnail:`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,url:`https://youtu.be/${videoId}`,summary:extract('SUMMARY'),twitter:extract('TWITTER'),facebook:extract('FACEBOOK'),instagram:extract('INSTAGRAM'),telegram:extract('TELEGRAM')});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Test connections
app.post('/api/test/telegram', async(req,res) => {
  const {token,chat} = req.body;
  try {
    const r = await axios.get(`https://api.telegram.org/bot${token}/getMe`);
    if(r.data.ok){ setSetting('telegram_token',token); if(chat)setSetting('telegram_chat',chat); res.json({success:true,username:r.data.result.username}); }
    else res.status(400).json({error:r.data.description});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/test/facebook', async(req,res) => {
  const {pageToken,pageId} = req.body;
  try {
    const r = await axios.get(`https://graph.facebook.com/v19.0/me?access_token=${pageToken}`);
    if(r.data.id){ setSetting('facebook_page_token',pageToken); if(pageId)setSetting('facebook_page_id',pageId); res.json({success:true,name:r.data.name}); }
    else res.status(400).json({error:'Invalid token'});
  } catch(e){ res.status(500).json({error:e.response?.data?.error?.message||e.message}); }
});

app.post('/api/test/ai', async(req,res) => {
  const {key,provider} = req.body;
  try {
    if(provider==='openai') setSetting('openai_key',key);
    else if(provider==='groq') setSetting('groq_key',key);
    else if(provider==='gemini') setSetting('gemini_key',key);
    else setSetting('claude_key',key);
    setSetting('ai_provider', provider);
    const result = await callAI('Say OK', 5);
    res.json({success:true, message:result});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/test-ai', async(req,res) => {
  const {key, provider} = req.body;
  if(!key || !provider) return res.status(400).json({error:'key and provider required'});
  const allowed = ['claude','chatgpt','openai','groq'];
  if(!allowed.includes(provider)) return res.status(400).json({error:'unknown provider'});
  try {
    setSetting('ai_provider', provider);
    setSetting('ai_api_key', key);
    const result = await callAI('Say OK', 10);
    res.json({success:true, provider, message:(result||'').toString().slice(0,200)});
  } catch(e){
    res.status(500).json({error: e.response?.data?.error?.message || e.message});
  }
});

// GitHub routes
app.post('/api/test/github', async(req,res) => {
  const {token,repo} = req.body;
  try {
    const r = await axios.get(`https://api.github.com/repos/${repo}`,{headers:{Authorization:'Bearer '+token}});
    setSetting('github_token',token); setSetting('github_repo',repo);
    res.json({success:true,name:r.data.full_name});
  } catch(e){ res.status(400).json({error:e.response?.data?.message||e.message}); }
});

app.post('/api/auto-update', async(req,res) => {
  const {request, ai_provider} = req.body;
  if(!request) return res.status(400).json({error:'Request required'});
  const ghToken = getSetting('github_token');
  const ghRepo = getSetting('github_repo');
  if(!ghToken||!ghRepo) return res.status(400).json({error:'GitHub not configured'});
  const origProvider = getSetting('ai_provider');
  if(ai_provider) setSetting('ai_provider', ai_provider);
  try {
    const fileRes = await axios.get(`https://api.github.com/repos/${ghRepo}/contents/public/index.html`,
      {headers:{Authorization:`Bearer ${ghToken}`,Accept:'application/vnd.github.v3+json'}});
    const currentContent = Buffer.from(fileRes.data.content,'base64').toString('utf-8');
    const fileSha = fileRes.data.sha;
    const newContent = await callAI(
      `You are a web developer. Modify this HTML file based on the request.\nCurrent file:\n${currentContent.substring(0,8000)}\n\nRequest: ${request}\n\nReturn ONLY the complete modified HTML file, no explanations, no markdown.`,
      4000
    );
    const clean = newContent.replace(/^```[\w]*\n?/,'').replace(/\n?```$/,'').trim();
    const encoded = Buffer.from(clean).toString('base64');
    await axios.put(`https://api.github.com/repos/${ghRepo}/contents/public/index.html`,
      {message:`AI Update: ${request.substring(0,50)}`, content:encoded, sha:fileSha},
      {headers:{Authorization:`Bearer ${ghToken}`,Accept:'application/vnd.github.v3+json'}}
    );
    const ver = getSetting('app_version','1.0.0').split('.').map(Number);
    ver[2]++; if(ver[2]>=10){ver[2]=0;ver[1]++;} if(ver[1]>=10){ver[1]=0;ver[0]++;}
    const newVer = ver.join('.');
    setSetting('app_version',newVer);
    setSetting('last_update',new Date().toISOString());
    setSetting('update_notes',request);
    if(ai_provider) setSetting('ai_provider',origProvider);
    res.json({success:true, message:'Updated on GitHub. Railway redeploys in ~1 min', version:newVer});
  } catch(e) {
    if(ai_provider) setSetting('ai_provider',origProvider);
    res.status(500).json({error:e.response?.data?.message||e.message});
  }
});

app.get('/api/github/commits', async(req,res) => {
  const t=getSetting('github_token'), r=getSetting('github_repo');
  if(!t||!r) return res.status(400).json({error:'GitHub not configured'});
  try {
    const d = await axios.get(`https://api.github.com/repos/${r}/commits?path=public/index.html&per_page=10`,
      {headers:{Authorization:'Bearer '+t,Accept:'application/vnd.github.v3+json'}});
    res.json({success:true, commits:d.data.map(c=>({sha:c.sha,message:c.commit.message,date:c.commit.author.date,author:c.commit.author.name}))});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/github/rollback', async(req,res) => {
  const {sha}=req.body;
  if(!sha) return res.status(400).json({error:'SHA required'});
  const t=getSetting('github_token'), r=getSetting('github_repo');
  if(!t||!r) return res.status(400).json({error:'GitHub not configured'});
  try {
    const old = await axios.get(`https://api.github.com/repos/${r}/contents/public/index.html?ref=${sha}`,
      {headers:{Authorization:'Bearer '+t,Accept:'application/vnd.github.v3+json'}});
    const cur = await axios.get(`https://api.github.com/repos/${r}/contents/public/index.html`,
      {headers:{Authorization:'Bearer '+t,Accept:'application/vnd.github.v3+json'}});
    await axios.put(`https://api.github.com/repos/${r}/contents/public/index.html`,
      {message:`Rollback to ${sha.substring(0,7)}`, content:old.data.content.replace(/\n/g,''), sha:cur.data.sha},
      {headers:{Authorization:'Bearer '+t,Accept:'application/vnd.github.v3+json'}}
    );
    res.json({success:true, message:`Rolled back to ${sha.substring(0,7)} - Railway redeploys in ~1 min`});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/version', (req,res) => res.json({
  version:getSetting('app_version','1.0.0'),
  lastUpdate:getSetting('last_update',''),
  updateNotes:getSetting('update_notes',''),
  updateSeen:getSetting('update_seen','1')
}));
app.post('/api/version/seen', (req,res) => { setSetting('update_seen','1'); res.json({success:true}); });

app.get('/api/ping', (req,res) => {
  res.json({ status:'alive', time:new Date().toISOString(), uptime:process.uptime() });
});

app.post('/api/run-now', (req,res) => { res.json({message:'Started'}); dailyCycle().catch(console.error); });

app.get('/', (req,res) => {
  const paths=[path.join(__dirname,'public','index.html'),path.join(__dirname,'index.html')];
  for(const p of paths){ if(fs.existsSync(p)) return res.sendFile(p); }
  res.send('<h2>Server running</h2>');
});


// ===== Facebook Sources =====
async function processFBSource(source) {
  try {
    const webhook = getSetting('make_webhook');
    if(!webhook) { console.log('Make.com webhook not configured'); return; }

    // Fetch content based on source type
    let posts = [];
    if(source.type === 'telegram') {
      const ch = source.url.replace('https://t.me/s/','');
      const r = await readTelegramChannel(ch);
      if(r.success) posts = r.posts.slice(0,3);
    } else {
      const items = await fetchRSS(source);
      posts = items.slice(0,3).map(i=>({text: i.title+'. '+i.content, url:i.url}));
    }

    if(!posts.length) return;

    for(const post of posts) {
      const text = post.text || post.content || '';
      if(!text || text.length < 20) continue;

      // Check if already published to FB
      const key = 'fb_'+source.id+'_'+(post.url||text.substring(0,40));
      const existing = db.prepare('SELECT id FROM posts WHERE original_url=?').get(key);
      if(existing) continue;

      // Rewrite for Facebook style - no source mention
      const prompt = `أنت كاتب محتوى محترف لصفحات فيسبوك. أعد صياغة هذا المحتوى بأسلوب جذاب يناسب فيسبوك باللغة العربية.

المحتوى: ${text.substring(0,800)}

المطلوب:
- منشور جذاب 100-150 كلمة
- أسلوب بشري طبيعي وغير رسمي
- يشجع على التفاعل والتعليق
- لا تذكر اسم المصدر أو القناة الأصلية
- لا تضع روابط أو URLs
- اختم بسؤال للتفاعل

أعد المنشور فقط بدون أي مقدمة.`;

      let fbText = text;
      try { fbText = await callAI(prompt, 600); } catch(e) {}

      // Save to DB
      const pid = db.prepare(`INSERT OR IGNORE INTO posts 
        (source_id,original_title,original_url,original_content,rewritten_facebook,status)
        VALUES(?,?,?,?,?,'ready')`)
        .run(source.id, text.substring(0,80), key, text, fbText).lastInsertRowid;

      if(!pid) continue;

      // Filter AI refusals
      const fbRefusal = ['لا أستطيع','لا يمكنني','عذراً','آسف','I cannot','أنصحك'].some(p=>fbText.includes(p));
      if(fbRefusal) fbText = text.substring(0,500);

      // Send to Make.com webhook
      try {
        await axios.post(webhook, {
          content: fbText,
          platform: 'facebook',
          source: source.name,
          timestamp: new Date().toISOString()
        });
        db.prepare("UPDATE posts SET status='published', published_at=datetime('now') WHERE id=?").run(pid);
        db.prepare("INSERT INTO publish_log(post_id,platform,status,message) VALUES(?,'facebook','success','via Make.com')").run(pid);
        console.log('Published to Facebook via Make.com from:', source.name);
      } catch(e) {
        db.prepare("INSERT INTO publish_log(post_id,platform,status,message) VALUES(?,'facebook','error',?)").run(pid, e.message);
      }

      await new Promise(r=>setTimeout(r,2000));
    }
  } catch(e) { console.error('FB source error:', source.name, e.message); }
}

// FB schedules
var fbIntervals = {};

function setupFBSchedules() {
  Object.values(fbIntervals).forEach(j=>{ try{j.stop();}catch(e){} });
  fbIntervals = {};

  const fbSources = db.prepare("SELECT * FROM sources WHERE active=1 AND id IN (SELECT CAST(value AS INTEGER) FROM settings WHERE key LIKE 'fb_source_%')").all();

  fbSources.forEach(src => {
    const intervalMin = parseInt(getSetting('fb_interval_'+src.id, '30'));
    let cronExpr = intervalMin < 60 ? `*/${intervalMin} * * * *` : `0 */${Math.floor(intervalMin/60)} * * *`;
    processFBSource(src);
    try {
      fbIntervals[src.id] = cron.schedule(cronExpr, ()=>processFBSource(src), {timezone:'Asia/Riyadh'});
    } catch(e) {
      setInterval(()=>processFBSource(src), intervalMin*60*1000);
    }
    console.log('FB schedule:', src.name, 'every', intervalMin, 'min');
  });
}

// ===== Telegram Admin Bot =====
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || getSetting('admin_bot_token','');
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || getSetting('admin_chat_id','');
var adminBot = null;
var botOffset = 0;

async function sendAdminMsg(chatId, text, keyboard) {
  const token = getSetting('admin_bot_token') || process.env.ADMIN_BOT_TOKEN;
  if(!token) return;
  const body = {chat_id: chatId, text: text, parse_mode: 'HTML'};
  if(keyboard) body.reply_markup = {inline_keyboard: keyboard};
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, body);
  } catch(e) { console.error('Admin bot send error:', e.message); }
}

async function editAdminMsg(chatId, msgId, text, keyboard) {
  const token = getSetting('admin_bot_token') || process.env.ADMIN_BOT_TOKEN;
  if(!token) return;
  const body = {chat_id: chatId, message_id: msgId, text: text, parse_mode: 'HTML'};
  if(keyboard) body.reply_markup = {inline_keyboard: keyboard};
  try {
    await axios.post(`https://api.telegram.org/bot${token}/editMessageText`, body);
  } catch(e) {}
}

function getMainKeyboard() {
  return [
    [{text:'📊 الإحصائيات', callback_data:'stats'}, {text:'📡 المصادر', callback_data:'sources'}],
    [{text:'▶️ تشغيل الآن', callback_data:'run'}, {text:'⏰ الجداول', callback_data:'schedules'}],
    [{text:'🧪 اختبار النشر من كل المصادر', callback_data:'test_publish_all'}],
    [{text:'🤖 إعدادات AI', callback_data:'ai_settings'}, {text:'📢 قنواتي', callback_data:'my_channels'}],
    [{text:'📘 فيسبوك', callback_data:'fb_menu'}, {text:'📋 آخر المنشورات', callback_data:'posts'}],
    [{text:'⚙️ الإعدادات', callback_data:'general_settings'}, {text:'🔗 إعدادات الربط', callback_data:'connection_settings'}],
    [{text:'🔄 إعادة تشغيل الجداول', callback_data:'restart_schedules'}]
  ];
}

async function handleAdminCommand(chatId, text, msgId, callbackId) {
  const adminId = getSetting('admin_chat_id') || process.env.ADMIN_CHAT_ID;
  if(String(chatId) !== String(adminId)) {
    await sendAdminMsg(chatId, '❌ غير مصرح لك');
    return;
  }
  if(callbackId) {
    const token = getSetting('admin_bot_token') || process.env.ADMIN_BOT_TOKEN;
    try { await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {callback_query_id: callbackId}); } catch(e) {}
  }

  // ===== MAIN MENU =====
  if(text === '/start' || text === 'main') {
    const s = db.prepare("SELECT COUNT(*) c FROM sources WHERE active=1").get();
    const p = db.prepare("SELECT COUNT(*) c FROM publish_log WHERE date(published_at)=date('now') AND status='success'").get();
    const e = db.prepare("SELECT COUNT(*) c FROM publish_log WHERE date(published_at)=date('now') AND status='error'").get();
    const provider = getSetting('ai_provider','groq');
    await sendAdminMsg(chatId,
      `🤖 <b>النشر الآلي Pro</b>\n\n📡 المصادر: ${s.c} | ✅ اليوم: ${p.c} | ❌ أخطاء: ${e.c}\n🧠 AI: ${provider}`,
      [[{text:'📡 المصادر',cb:'sources'},{text:'📢 قنواتي',cb:'my_channels'}],
       [{text:'▶️ تشغيل',cb:'run'},{text:'⏰ الجداول',cb:'schedules'}],
       [{text:'🤖 إعدادات AI',cb:'ai_settings'},{text:'✍️ أسلوب الكتابة',cb:'writing_style'}],
       [{text:'📘 فيسبوك',cb:'fb_menu'},{text:'📋 المنشورات',cb:'posts'}],
       [{text:'⚙️ الإعدادات العامة',cb:'general_settings'},{text:'📊 الإحصائيات',cb:'stats'}]
      ].map(row => row.map(b => ({text:b.text, callback_data:b.cb}))));

  // ===== STATS =====
  } else if(text === 'stats') {
    const s = db.prepare("SELECT COUNT(*) c FROM sources WHERE active=1").get();
    const p = db.prepare("SELECT COUNT(*) c FROM posts").get();
    const pub = db.prepare("SELECT COUNT(*) c FROM publish_log WHERE date(published_at)=date('now') AND status='success'").get();
    const err = db.prepare("SELECT COUNT(*) c FROM publish_log WHERE date(published_at)=date('now') AND status='error'").get();
    const tg = db.prepare("SELECT COUNT(*) c FROM sources WHERE type='telegram' AND active=1").get();
    const fb = db.prepare("SELECT COUNT(*) c FROM sources WHERE name LIKE 'FB:%' AND active=1").get();
    await sendAdminMsg(chatId,
      `📊 <b>الإحصائيات الكاملة</b>\n\n📡 مصادر TG: ${tg.c}\n📘 مصادر FB: ${fb.c}\n📝 إجمالي منشورات: ${p.c}\n✅ نُشر اليوم: ${pub.c}\n❌ أخطاء اليوم: ${err.c}`,
      [[{text:'🔙 رجوع', callback_data:'main'}]]);

  // ===== SOURCES MENU =====
  } else if(text === 'sources') {
    await sendAdminMsg(chatId, '📡 <b>إدارة المصادر</b>',
      [[{text:'📋 عرض المصادر', callback_data:'list_sources'},{text:'➕ إضافة TG', callback_data:'add_tg_src'}],
       [{text:'➕ إضافة RSS', callback_data:'add_rss_src'},{text:'➕ إضافة YouTube', callback_data:'add_yt_src'}],
       [{text:'🔙 رجوع', callback_data:'main'}]]);

  } else if(text === 'list_sources') {
    const srcs = db.prepare('SELECT * FROM sources WHERE active=1 ORDER BY type').all();
    if(!srcs.length) { await sendAdminMsg(chatId, '📡 لا توجد مصادر', [[{text:'🔙 رجوع', callback_data:'sources'}]]); return; }
    const keyboard = srcs.map(s => [{text: (s.type==='telegram'?'✈️ ':s.type==='youtube'?'▶️ ':'🌐 ')+s.name.substring(0,25), callback_data:'src_'+s.id}]);
    keyboard.push([{text:'🔙 رجوع', callback_data:'sources'}]);
    await sendAdminMsg(chatId, '📡 <b>المصادر النشطة - اختر للتعديل:</b>', keyboard);

  } else if(text.startsWith('src_')) {
    const id = text.replace('src_','');
    const src = db.prepare('SELECT * FROM sources WHERE id=?').get(id);
    if(!src) return;
    const ch = src.url.replace('https://t.me/s/','');
    const rules = JSON.parse(getSetting('tg_rules_'+ch,'{"mode":"rewrite"}'));
    const modeLabel = {'rewrite':'🤖 إعادة صياغة','as-is':'📋 نقل حرفي','forward':'⚡ تحويل مباشر'}[rules.mode]||'🤖';
    const interval = getSetting('tg_interval_'+ch,'5');
    const publishTo = getSetting('tg_publish_to_'+ch,'افتراضي');
    await sendAdminMsg(chatId,
      `📡 <b>${src.name}</b>\n\nالنوع: ${src.type}\nوضع النشر: ${modeLabel}\nالتكرار: كل ${interval} دقيقة\nينشر على: ${publishTo||'القناة الافتراضية'}\nالرابط: ${src.url}`,
      [[{text:'🤖 إعادة صياغة', callback_data:'mode_rewrite_'+ch},{text:'📋 نقل حرفي', callback_data:'mode_asis_'+ch}],
       [{text:'⚡ تحويل مباشر', callback_data:'mode_forward_'+ch}],
       [{text:'⏱ تغيير التكرار', callback_data:'interval_'+ch},{text:'📢 تغيير القناة', callback_data:'pubto_'+ch}],
       [{text:'🧪 اختبار القراءة', callback_data:'test_src_'+ch},{text:'📤 نشر آخر رسالة', callback_data:'publish_last_'+ch}],
       [{text:'🗑️ حذف المصدر', callback_data:'del_src_'+id},{text:'🔙 رجوع', callback_data:'list_sources'}]]);

  } else if(text.startsWith('mode_')) {
    const parts = text.split('_');
    const mode = parts[1]==='asis' ? 'as-is' : parts[1];
    const ch = parts.slice(2).join('_');
    const rules = JSON.parse(getSetting('tg_rules_'+ch,'{}'));
    rules.mode = mode;
    setSetting('tg_rules_'+ch, JSON.stringify(rules));
    const modeLabel = {'rewrite':'🤖 إعادة صياغة','as-is':'📋 نقل حرفي','forward':'⚡ تحويل مباشر'}[mode];
    await sendAdminMsg(chatId, '✅ تم تغيير وضع النشر لـ @'+ch+' إلى '+modeLabel,
      [[{text:'🔙 المصدر', callback_data:'src_'+ch},{text:'🔙 المصادر', callback_data:'list_sources'}]]);

  } else if(text.startsWith('interval_')) {
    const ch = text.replace('interval_','');
    await sendAdminMsg(chatId, '⏱ اختر تكرار الفحص لـ @'+ch+':',
      [[{text:'2 دقيقة', callback_data:'setiv_2_'+ch},{text:'5 دقائق', callback_data:'setiv_5_'+ch}],
       [{text:'10 دقائق', callback_data:'setiv_10_'+ch},{text:'15 دقيقة', callback_data:'setiv_15_'+ch}],
       [{text:'30 دقيقة', callback_data:'setiv_30_'+ch},{text:'ساعة', callback_data:'setiv_60_'+ch}],
       [{text:'🔙 رجوع', callback_data:'src_'+ch}]]);

  } else if(text.startsWith('setiv_')) {
    const parts = text.split('_');
    const iv = parts[1];
    const ch = parts.slice(2).join('_');
    setSetting('tg_interval_'+ch, iv);
    setupTGSchedules();
    await sendAdminMsg(chatId, '✅ تم تغيير التكرار لـ @'+ch+' إلى كل '+iv+' دقيقة وتم تحديث الجداول',
      [[{text:'🔙 المصدر', callback_data:'src_'+ch}]]);

  } else if(text.startsWith('pubto_')) {
    const ch = text.replace('pubto_','');
    let channels = [];
    try { channels = JSON.parse(getSetting('my_tg_channels','[]')); } catch(e) {}
    if(!channels.length) { await sendAdminMsg(chatId, '❌ لا توجد قنوات مضافة', [[{text:'📢 إدارة قنواتي', callback_data:'my_channels'}]]); return; }
    const keyboard = channels.map(c => [{text:c.name+' ('+c.chat+')', callback_data:'setpub_'+c.chat+'_'+ch}]);
    keyboard.push([{text:'🔙 رجوع', callback_data:'src_'+ch}]);
    await sendAdminMsg(chatId, '📢 اختر القناة التي ينشر عليها @'+ch+':', keyboard);

  } else if(text.startsWith('setpub_')) {
    const parts = text.replace('setpub_','').split('_');
    const pubChat = parts[0];
    const ch = parts.slice(1).join('_');
    setSetting('tg_publish_to_'+ch, pubChat);
    await sendAdminMsg(chatId, '✅ تم تعيين '+pubChat+' كقناة نشر لـ @'+ch,
      [[{text:'🔙 المصدر', callback_data:'src_'+ch}]]);

  } else if(text.startsWith('del_src_')) {
    const id = text.replace('del_src_','');
    const src = db.prepare('SELECT name FROM sources WHERE id=?').get(id);
    if(src) {
      db.prepare('DELETE FROM sources WHERE id=?').run(id);
      setupTGSchedules();
      await sendAdminMsg(chatId, '🗑️ تم حذف المصدر: '+src.name, [[{text:'🔙 المصادر', callback_data:'list_sources'}]]);
    }

  } else if(text.startsWith('test_src_')) {
    const ch = text.replace('test_src_','');
    await sendAdminMsg(chatId, '🔄 جاري قراءة @'+ch+'...');
    const r = await readTelegramChannel(ch);
    if(r.success && r.posts.length) {
      const post = r.posts[0];
      await sendAdminMsg(chatId,
        `✅ نجح الاتصال بـ @${ch}\nعدد المنشورات: ${r.posts.length}\n\n📨 آخر رسالة:\n${post.text.substring(0,300)}`,
        [[{text:'🔙 المصدر', callback_data:'src_'+ch}]]);
    } else {
      await sendAdminMsg(chatId, '❌ تعذر قراءة @'+ch+'\n'+(r.message||''), [[{text:'🔙 المصادر', callback_data:'list_sources'}]]);
    }

  } else if(text.startsWith('publish_last_')) {
    const ch = text.replace('publish_last_','');
    await sendAdminMsg(chatId, '📤 جاري جلب ونشر آخر رسالة من @'+ch+'...');
    await processTGChannel(ch);
    await sendAdminMsg(chatId, '✅ تم معالجة آخر رسالة من @'+ch, [[{text:'🔙 المصدر', callback_data:'src_'+ch}]]);

  // ===== ADD SOURCES =====
  } else if(text === 'add_tg_src') {
    setSetting('admin_awaiting','add_tg_src');
    await sendAdminMsg(chatId, '✈️ أرسل اسم قناة تيليغرام (بدون @):\nمثال: BBCArabic',
      [[{text:'❌ إلغاء', callback_data:'cancel_awaiting'}]]);

  } else if(text === 'add_rss_src') {
    setSetting('admin_awaiting','add_rss_src');
    await sendAdminMsg(chatId, '🌐 أرسل رابط RSS:\nمثال: https://feeds.bbcarabic.com/bbcarabic-51',
      [[{text:'❌ إلغاء', callback_data:'cancel_awaiting'}]]);

  } else if(text === 'add_yt_src') {
    setSetting('admin_awaiting','add_yt_src');
    await sendAdminMsg(chatId, '▶️ أرسل رابط قناة YouTube أو فيديو:',
      [[{text:'❌ إلغاء', callback_data:'cancel_awaiting'}]]);

  // ===== MY CHANNELS =====
  } else if(text === 'my_channels') {
    let channels = [];
    try { channels = JSON.parse(getSetting('my_tg_channels','[]')); } catch(e) {}
    let msg = '📢 <b>قنواتك للنشر</b>\n\n';
    if(!channels.length) msg += 'لا توجد قنوات مضافة\n';
    else channels.forEach((c,i) => { msg += `${i+1}. ${c.name} — ${c.chat}\n`; });
    const keyboard = channels.map((c,i) => [{text:'🧪 '+c.name, callback_data:'test_mych_'+i},{text:'🗑️ حذف', callback_data:'del_mych_'+i}]);
    keyboard.push([{text:'➕ إضافة قناة', callback_data:'add_my_channel'},{text:'🔙 رجوع', callback_data:'main'}]);
    await sendAdminMsg(chatId, msg, keyboard);

  } else if(text === 'add_my_channel') {
    setSetting('admin_awaiting','add_my_channel_name');
    await sendAdminMsg(chatId, '📢 أرسل اسم القناة (سيظهر في نهاية المنشورات):',
      [[{text:'❌ إلغاء', callback_data:'cancel_awaiting'}]]);

  } else if(text === 'cancel_awaiting') {
    setSetting('admin_awaiting','');
    await sendAdminMsg(chatId, '❌ تم الإلغاء', [[{text:'🔙 الرئيسية', callback_data:'main'}]]);

  } else if(text.startsWith('test_mych_')) {
    const idx = parseInt(text.replace('test_mych_',''));
    let channels = [];
    try { channels = JSON.parse(getSetting('my_tg_channels','[]')); } catch(e) {}
    const ch = channels[idx];
    if(!ch) { await sendAdminMsg(chatId, '❌ القناة غير موجودة'); return; }
    const tgToken = getSetting('telegram_token');
    if(!tgToken) { await sendAdminMsg(chatId, '❌ Bot Token غير مضاف في إعدادات الربط'); return; }
    try {
      await axios.post(`https://api.telegram.org/bot${tgToken}/sendMessage`,{
        chat_id: ch.chat,
        text: '✅ اختبار من نظام النشر الآلي - البوت يعمل بنجاح!'
      });
      await sendAdminMsg(chatId, '✅ تم إرسال رسالة تجريبية لـ '+ch.name+' بنجاح!',
        [[{text:'🔙 قنواتي', callback_data:'my_channels'}]]);
    } catch(e) {
      const errMsg = e.response?.data?.description || e.message;
      await sendAdminMsg(chatId, '❌ فشل الإرسال لـ '+ch.name+':\n'+errMsg+'\n\n⚠️ تأكد أن بوت النشر (@publishing_bot) مضاف كمشرف في القناة وليس بوت التحكم',
        [[{text:'🔙 قنواتي', callback_data:'my_channels'}]]);
    }

  } else if(text.startsWith('del_mych_')) {
    const idx = parseInt(text.replace('del_mych_',''));
    let channels = [];
    try { channels = JSON.parse(getSetting('my_tg_channels','[]')); } catch(e) {}
    const removed = channels.splice(idx,1);
    setSetting('my_tg_channels', JSON.stringify(channels));
    await sendAdminMsg(chatId, '🗑️ تم حذف '+(removed[0]?removed[0].name:'القناة'), [[{text:'🔙 قنواتي', callback_data:'my_channels'}]]);

  // ===== AI SETTINGS =====
  } else if(text === 'ai_settings') {
    const provider = getSetting('ai_provider','groq');
    const keys = {groq:!!getSetting('groq_key'),gemini:!!getSetting('gemini_key'),claude:!!getSetting('claude_key'),openai:!!getSetting('openai_key')};
    const msg = `🤖 <b>إعدادات AI</b>\n\nالمزود النشط: <b>${provider}</b>\n\nالمفاتيح:\n${keys.groq?'✅':'❌'} Groq (مجاني)\n${keys.gemini?'✅':'❌'} Gemini\n${keys.claude?'✅':'❌'} Claude\n${keys.openai?'✅':'❌'} OpenAI`;
    await sendAdminMsg(chatId, msg,
      [[{text:'⚡ Groq'+(provider==='groq'?' ✓':''), callback_data:'set_ai_groq'},{text:'💎 Gemini'+(provider==='gemini'?' ✓':''), callback_data:'set_ai_gemini'}],
       [{text:'🤖 Claude'+(provider==='claude'?' ✓':''), callback_data:'set_ai_claude'},{text:'🚀 OpenAI'+(provider==='openai'?' ✓':''), callback_data:'set_ai_openai'}],
       [{text:'🧪 اختبار AI الحالي', callback_data:'test_ai'}],
       [{text:'🔙 رجوع', callback_data:'main'}]]);

  } else if(text.startsWith('set_ai_')) {
    const prov = text.replace('set_ai_','');
    setSetting('ai_provider', prov);
    await sendAdminMsg(chatId, '✅ تم تغيير المزود إلى <b>'+prov+'</b>', [[{text:'🔙 إعدادات AI', callback_data:'ai_settings'}]]);

  } else if(text === 'test_ai') {
    await sendAdminMsg(chatId, '🔄 جاري اختبار AI...');
    try {
      const result = await callAI('قل: البوت يعمل بنجاح', 20);
      await sendAdminMsg(chatId, '✅ AI يعمل!\nالرد: '+result, [[{text:'🔙 رجوع', callback_data:'ai_settings'}]]);
    } catch(e) {
      await sendAdminMsg(chatId, '❌ خطأ في AI: '+e.message, [[{text:'🔙 رجوع', callback_data:'ai_settings'}]]);
    }

  // ===== WRITING STYLE =====
  } else if(text === 'writing_style') {
    const tone = getSetting('writing_tone','informative');
    const lang = getSetting('content_lang','ar');
    const hashtags = getSetting('hashtags','');
    await sendAdminMsg(chatId,
      `✍️ <b>أسلوب الكتابة</b>\n\nالأسلوب الحالي: <b>${tone}</b>\nاللغة: <b>${lang}</b>\nهاشتاقات: ${hashtags||'لا توجد'}`,
      [[{text:'📰 إخباري'+(tone==='informative'?' ✓':''), callback_data:'set_tone_informative'},{text:'🔍 تحليلي'+(tone==='analytical'?' ✓':''), callback_data:'set_tone_analytical'}],
       [{text:'✨ جذاب'+(tone==='engaging'?' ✓':''), callback_data:'set_tone_engaging'},{text:'⚖️ محايد'+(tone==='neutral'?' ✓':''), callback_data:'set_tone_neutral'}],
       [{text:'🌐 عربي'+(lang==='ar'?' ✓':''), callback_data:'set_lang_ar'},{text:'🇬🇧 English'+(lang==='en'?' ✓':''), callback_data:'set_lang_en'}],
       [{text:'✏️ تعديل الهاشتاقات', callback_data:'edit_hashtags'}],
       [{text:'🔙 رجوع', callback_data:'main'}]]);

  } else if(text.startsWith('set_tone_')) {
    const tone = text.replace('set_tone_','');
    setSetting('writing_tone', tone);
    await sendAdminMsg(chatId, '✅ تم تغيير الأسلوب إلى <b>'+tone+'</b>', [[{text:'🔙 رجوع', callback_data:'writing_style'}]]);

  } else if(text.startsWith('set_lang_')) {
    const lang = text.replace('set_lang_','');
    setSetting('content_lang', lang);
    await sendAdminMsg(chatId, '✅ تم تغيير اللغة', [[{text:'🔙 رجوع', callback_data:'writing_style'}]]);

  } else if(text === 'edit_hashtags') {
    setSetting('admin_awaiting','edit_hashtags');
    await sendAdminMsg(chatId, '✏️ أرسل الهاشتاقات:\nمثال: #أخبار #تقنية #عاجل',
      [[{text:'❌ إلغاء', callback_data:'cancel_awaiting'}]]);

  // ===== SCHEDULES =====
  } else if(text === 'schedules') {
    const srcs = db.prepare("SELECT * FROM sources WHERE type='telegram' AND active=1").all();
    let msg = '⏰ <b>الجداول النشطة:</b>\n\n';
    if(!srcs.length) msg += 'لا توجد جداول';
    else srcs.forEach(s => {
      const ch = s.url.replace('https://t.me/s/','');
      const iv = getSetting('tg_interval_'+ch,'5');
      const active = !!tgIntervals[ch];
      msg += `${active?'✅':'❌'} @${ch} — كل ${iv} دقيقة\n`;
    });
    await sendAdminMsg(chatId, msg,
      [[{text:'🔄 إعادة تفعيل الجداول', callback_data:'restart_schedules'},{text:'🔙 رجوع', callback_data:'main'}]]);

  } else if(text === 'restart_schedules') {
    setupTGSchedules();
    await sendAdminMsg(chatId, '✅ تم إعادة تفعيل الجداول!\nعدد القنوات النشطة: '+Object.keys(tgIntervals).length,
      [[{text:'🔙 رجوع', callback_data:'schedules'}]]);

  // ===== RUN =====
  } else if(text === 'run') {
    await sendAdminMsg(chatId, '▶️ جاري تشغيل الدورة اليدوية...',
      [[{text:'🧪 اختبار النشر من كل المصادر', callback_data:'test_publish_all'}]]);
    dailyCycle().then(async()=>{
      await sendAdminMsg(chatId, '✅ انتهت الدورة بنجاح!', [[{text:'📊 الإحصائيات', callback_data:'stats'},{text:'🏠 الرئيسية', callback_data:'main'}]]);
    }).catch(async(e)=>{
      await sendAdminMsg(chatId, '❌ خطأ في الدورة: '+e.message);
    });

  } else if(text === 'test_publish_all') {
    const srcs = db.prepare("SELECT * FROM sources WHERE type='telegram' AND active=1").all();
    if(!srcs.length) { await sendAdminMsg(chatId, '❌ لا توجد مصادر تيليغرام', [[{text:'🔙 رجوع', callback_data:'main'}]]); return; }
    const keyboard = srcs.map(s => {
      const ch = s.url.replace('https://t.me/s/','');
      return [{text:'📤 @'+ch, callback_data:'force_pub_'+ch}];
    });
    keyboard.push([{text:'📤 نشر من الكل', callback_data:'force_pub_all'}]);
    keyboard.push([{text:'🔙 رجوع', callback_data:'main'}]);
    await sendAdminMsg(chatId, '📤 اختر القناة لنشر آخر رسالة منها على قناتك:', keyboard);

  } else if(text.startsWith('force_pub_') && text !== 'force_pub_all') {
    const ch = text.replace('force_pub_','');
    await sendAdminMsg(chatId, '🔄 جاري جلب آخر رسالة من @'+ch+' ونشرها...');
    try {
      const result = await readTelegramChannel(ch);
      if(!result.success || !result.posts.length) {
        await sendAdminMsg(chatId, '❌ تعذر قراءة @'+ch+'\n'+(result.message||''), [[{text:'🔙 رجوع', callback_data:'test_publish_all'}]]);
        return;
      }
      const post = result.posts[0];
      const tgToken = getSetting('telegram_token');
      const publishTo = getSetting('tg_publish_to_'+ch,'') || getSetting('telegram_chat','');
      if(!tgToken || !publishTo) {
        await sendAdminMsg(chatId, '❌ Bot Token أو القناة غير مضافة', [[{text:'🔗 إعدادات الربط', callback_data:'connection_settings'}]]);
        return;
      }
      const rules = JSON.parse(getSetting('tg_rules_'+ch,'{"mode":"rewrite"}'));
      const mode = rules.mode || 'rewrite';
      let finalText = post.text;
      if(mode === 'rewrite' || mode === 'as-is') {
        if(mode === 'rewrite') {
          try {
            const isNonArabic = !/[\u0600-\u06FF]/.test((post.text||'').substring(0,50));
            const prompt = isNonArabic
              ? 'Translate and rewrite as professional Arabic news. No source mention. No URLs:\n'+post.text+'\nReturn Arabic only.'
              : 'أعد صياغة هذا الخبر بالعربية الاحترافية. لا تذكر المصدر أو روابط:\n'+post.text+'\nأعد الخبر فقط.';
            finalText = await callAI(prompt, 500);
            const refusals = ['لا أستطيع','لا يمكنني','عذراً'];
            if(refusals.some(r=>finalText.includes(r))) finalText = post.text;
          } catch(e) { finalText = post.text; }
        }
        finalText = finalText.replace(/https?:\/\/\S+/g,'').replace(/t\.me\/\S+/g,'').trim();
        let myChannelLink = '';
        try {
          const myChans = JSON.parse(getSetting('my_tg_channels','[]'));
          const mc = myChans.find(c=>c.chat===publishTo||c.chat==='@'+publishTo.replace('@',''));
          if(mc) myChannelLink = '\n\n📢 @'+mc.chat.replace('@','');
        } catch(e) {}
        finalText = finalText + myChannelLink;
        await axios.post(`https://api.telegram.org/bot${tgToken}/sendMessage`,{chat_id:publishTo, text:finalText, parse_mode:'HTML'});
      } else {
        const result2 = await readTelegramChannel(ch);
        if(result2.posts && result2.posts[0] && result2.posts[0].msgId) {
          await axios.post(`https://api.telegram.org/bot${tgToken}/forwardMessage`,{chat_id:publishTo, from_chat_id:'@'+ch, message_id:result2.posts[0].msgId});
        }
      }
      await sendAdminMsg(chatId, '✅ تم نشر آخر رسالة من @'+ch+' على '+publishTo,
        [[{text:'📤 اختبار قناة أخرى', callback_data:'test_publish_all'},{text:'🏠 الرئيسية', callback_data:'main'}]]);
    } catch(e) {
      await sendAdminMsg(chatId, '❌ خطأ: '+e.message, [[{text:'🔙 رجوع', callback_data:'test_publish_all'}]]);
    }

  } else if(text === 'force_pub_all') {
    const srcs = db.prepare("SELECT * FROM sources WHERE type='telegram' AND active=1").all();
    await sendAdminMsg(chatId, '🔄 جاري النشر من '+srcs.length+' قناة...');
    let results = '';
    for(const src of srcs) {
      const ch = src.url.replace('https://t.me/s/','');
      try {
        await processTGChannel(ch);
        results += '✅ @'+ch+'\n';
      } catch(e) { results += '❌ @'+ch+'\n'; }
      await new Promise(r=>setTimeout(r,1500));
    }
    await sendAdminMsg(chatId, '📊 النتيجة:\n\n'+results,
      [[{text:'📋 المنشورات', callback_data:'posts'},{text:'🏠 الرئيسية', callback_data:'main'}]]);

  // ===== POSTS =====
  } else if(text === 'posts') {
    const ps = db.prepare("SELECT p.*,s.name sname FROM posts p LEFT JOIN sources s ON p.source_id=s.id ORDER BY p.created_at DESC LIMIT 8").all();
    if(!ps.length) { await sendAdminMsg(chatId, '📋 لا توجد منشورات', [[{text:'🔙 رجوع', callback_data:'main'}]]); return; }
    let msg = '📋 <b>آخر المنشورات:</b>\n\n';
    ps.forEach(p => { msg += `${p.status==='published'?'✅':'⏳'} ${(p.original_title||'بدون عنوان').substring(0,40)}\n<i>${p.sname||''} — ${p.status}</i>\n\n`; });
    await sendAdminMsg(chatId, msg, [[{text:'🔙 رجوع', callback_data:'main'}]]);

  // ===== FACEBOOK =====
  } else if(text === 'fb_menu') {
    const webhook = getSetting('make_webhook');
    const fbSrcs = db.prepare("SELECT COUNT(*) c FROM sources WHERE name LIKE 'FB:%' AND active=1").get();
    await sendAdminMsg(chatId,
      `📘 <b>فيسبوك</b>\n\nWebhook: ${webhook?'✅ مربوط':'❌ غير مربوط'}\nعدد المصادر: ${fbSrcs.c}`,
      [[{text:'🧪 اختبار الربط', callback_data:'test_fb'},{text:'📋 مصادر FB', callback_data:'list_fb_sources'}],
       [{text:'▶️ نشر فوري FB', callback_data:'run_fb'}],
       [{text:'🔙 رجوع', callback_data:'main'}]]);

  } else if(text === 'list_fb_sources') {
    const srcs = db.prepare("SELECT * FROM sources WHERE name LIKE 'FB:%' AND active=1").all();
    if(!srcs.length) { await sendAdminMsg(chatId, '📘 لا توجد مصادر فيسبوك', [[{text:'🔙 رجوع', callback_data:'fb_menu'}]]); return; }
    const keyboard = srcs.map(s => [{text:s.name, callback_data:'del_fb_'+s.id}]);
    keyboard.push([{text:'🔙 رجوع', callback_data:'fb_menu'}]);
    await sendAdminMsg(chatId, '📘 مصادر فيسبوك (اضغط لحذف):', keyboard);

  } else if(text.startsWith('del_fb_')) {
    const id = text.replace('del_fb_','');
    const src = db.prepare('SELECT name FROM sources WHERE id=?').get(id);
    if(src) { db.prepare('DELETE FROM sources WHERE id=?').run(id); await sendAdminMsg(chatId, '🗑️ تم حذف '+src.name, [[{text:'🔙 رجوع', callback_data:'list_fb_sources'}]]); }

  } else if(text === 'test_fb') {
    const webhook = getSetting('make_webhook');
    if(!webhook) { await sendAdminMsg(chatId, '❌ لم يتم ربط Make.com', [[{text:'🔙 رجوع', callback_data:'fb_menu'}]]); return; }
    try {
      await axios.post(webhook, {content:'اختبار من بوت التحكم - '+new Date().toLocaleString('ar'), platform:'facebook', timestamp:new Date().toISOString()});
      await sendAdminMsg(chatId, '✅ تم إرسال منشور تجريبي لفيسبوك!', [[{text:'🔙 رجوع', callback_data:'fb_menu'}]]);
    } catch(e) { await sendAdminMsg(chatId, '❌ خطأ: '+e.message, [[{text:'🔙 رجوع', callback_data:'fb_menu'}]]); }

  // ===== GENERAL SETTINGS =====
  } else if(text === 'general_settings') {
    const auto = getSetting('auto_publish','1');
    const ct = getSetting('check_time','08:00');
    await sendAdminMsg(chatId,
      `⚙️ <b>الإعدادات العامة</b>\n\nنشر تلقائي: ${auto==='1'?'✅ مفعل':'❌ معطل'}\nوقت الجلب اليومي: ${ct}`,
      [[{text:auto==='1'?'⏸ إيقاف النشر':'▶️ تفعيل النشر', callback_data:auto==='1'?'set_auto_0':'set_auto_1'}],
       [{text:'🕐 تغيير وقت الجلب', callback_data:'edit_check_time'}],
       [{text:'🔗 إعدادات الربط', callback_data:'connection_settings'}],
       [{text:'🔙 رجوع', callback_data:'main'}]]);

  } else if(text === 'set_auto_1') {
    setSetting('auto_publish','1');
    await sendAdminMsg(chatId, '✅ تم تفعيل النشر التلقائي', [[{text:'🔙 رجوع', callback_data:'general_settings'}]]);

  } else if(text === 'set_auto_0') {
    setSetting('auto_publish','0');
    await sendAdminMsg(chatId, '⏸ تم إيقاف النشر التلقائي', [[{text:'🔙 رجوع', callback_data:'general_settings'}]]);

  // ===== CONNECTION SETTINGS =====
  } else if(text === 'connection_settings') {
    const tgToken = getSetting('telegram_token');
    const tgChat = getSetting('telegram_chat');
    const webhook = getSetting('make_webhook');
    const aiProvider = getSetting('ai_provider','groq');
    const hasGroq = !!getSetting('groq_key');
    const hasGemini = !!getSetting('gemini_key');
    const hasClaude = !!getSetting('claude_key');
    await sendAdminMsg(chatId,
      `🔗 <b>إعدادات الربط</b>\n\n✈️ Bot Token: ${tgToken?'✅ مضاف':'❌ غير مضاف'}\n📢 القناة الافتراضية: ${tgChat||'غير محددة'}\n📘 Make.com: ${webhook?'✅ مربوط':'❌ غير مربوط'}\n🤖 AI: ${aiProvider} ${hasGroq||hasGemini||hasClaude?'✅':'❌'}`,
      [[{text:'🔑 تعديل Bot Token', callback_data:'edit_tg_token'},{text:'📢 تعديل القناة', callback_data:'edit_tg_chat'}],
       [{text:'🔗 تعديل Make.com', callback_data:'edit_webhook'},{text:'🤖 إعدادات AI', callback_data:'ai_settings'}],
       [{text:'🔙 رجوع', callback_data:'general_settings'}]]);

  } else if(text === 'edit_tg_token') {
    setSetting('admin_awaiting','edit_tg_token');
    await sendAdminMsg(chatId, '🔑 أرسل Bot Token الجديد (من @BotFather):', [[{text:'❌ إلغاء', callback_data:'cancel_awaiting'}]]);

  } else if(text === 'edit_tg_chat') {
    setSetting('admin_awaiting','edit_tg_chat');
    await sendAdminMsg(chatId, '📢 أرسل معرف القناة الافتراضية للنشر (@channel أو -100...):', [[{text:'❌ إلغاء', callback_data:'cancel_awaiting'}]]);

  } else if(text === 'edit_webhook') {
    setSetting('admin_awaiting','edit_webhook');
    await sendAdminMsg(chatId, '🔗 أرسل رابط Make.com Webhook:', [[{text:'❌ إلغاء', callback_data:'cancel_awaiting'}]]);

  // ===== NEW SOURCE MODE/TONE =====
  } else if(text === 'new_src_mode_rewrite' || text === 'new_src_mode_asis' || text === 'new_src_mode_forward') {
    const ch = getSetting('admin_new_src_ch','');
    if(!ch) { await sendAdminMsg(chatId, '❌ حدث خطأ', [[{text:'🏠 الرئيسية', callback_data:'main'}]]); return; }
    const mode = text === 'new_src_mode_rewrite' ? 'rewrite' : text === 'new_src_mode_asis' ? 'as-is' : 'forward';
    setSetting('tg_rules_'+ch, JSON.stringify({mode: mode}));
    if(mode === 'rewrite') {
      await sendAdminMsg(chatId, '✍️ اختر أسلوب الصياغة لـ @'+ch+':',
        [[{text:'📰 إخباري رسمي', callback_data:'new_src_tone_informative'}],
         [{text:'🔍 تحليلي معمق', callback_data:'new_src_tone_analytical'}],
         [{text:'✨ جذاب وشيق', callback_data:'new_src_tone_engaging'}],
         [{text:'⚖️ محايد موضوعي', callback_data:'new_src_tone_neutral'}]]);
    } else {
      setupTGSchedules();
      let myChannels = [];
      try { myChannels = JSON.parse(getSetting('my_tg_channels','[]')); } catch(e) {}
      if(myChannels.length > 0) {
        const keyboard = myChannels.map(c => [{text: c.name+' ('+c.chat+')', callback_data:'new_src_pub_'+c.chat}]);
        keyboard.push([{text:'📢 القناة الافتراضية', callback_data:'new_src_pub_default'}]);
        await sendAdminMsg(chatId, '📢 اختر القناة التي ينشر عليها @'+ch+':', keyboard);
      } else {
        await sendAdminMsg(chatId, '✅ تم إعداد @'+ch+'!\n\n⚠️ لم تضف قنوات للنشر بعد. اذهب لـ 📢 قنواتي لإضافة قنواتك',
          [[{text:'📢 قنواتي', callback_data:'my_channels'},{text:'🔙 المصادر', callback_data:'list_sources'}]]);
      }
    }

  } else if(text.startsWith('new_src_tone_')) {
    const ch = getSetting('admin_new_src_ch','');
    if(!ch) { await sendAdminMsg(chatId, '❌ حدث خطأ', [[{text:'🏠 الرئيسية', callback_data:'main'}]]); return; }
    const tone = text.replace('new_src_tone_','');
    const rules = JSON.parse(getSetting('tg_rules_'+ch,'{"mode":"rewrite"}'));
    rules.tone = tone;
    setSetting('tg_rules_'+ch, JSON.stringify(rules));
    setSetting('tg_tone_'+ch, tone);
    setupTGSchedules();
    let myChannels2 = [];
    try { myChannels2 = JSON.parse(getSetting('my_tg_channels','[]')); } catch(e) {}
    if(myChannels2.length > 0) {
      const keyboard = myChannels2.map(c => [{text: c.name+' ('+c.chat+')', callback_data:'new_src_pub_'+c.chat}]);
      keyboard.push([{text:'📢 القناة الافتراضية', callback_data:'new_src_pub_default'}]);
      await sendAdminMsg(chatId, '📢 اختر القناة التي ينشر عليها @'+ch+':', keyboard);
    } else {
      await sendAdminMsg(chatId, '✅ تم إعداد @'+ch+'!\n\n⚠️ لم تضف قنوات للنشر بعد. اذهب لـ 📢 قنواتي لإضافة قنواتك',
        [[{text:'📢 قنواتي', callback_data:'my_channels'},{text:'🔙 المصادر', callback_data:'list_sources'}]]);
    }

  } else if(text.startsWith('new_src_pub_')) {
    const ch = getSetting('admin_new_src_ch','');
    const pubChat = text.replace('new_src_pub_','');
    if(pubChat !== 'default' && ch) {
      setSetting('tg_publish_to_'+ch, pubChat);
    }
    const rules = JSON.parse(getSetting('tg_rules_'+ch,'{"mode":"rewrite"}'));
    const modeLabel = {'rewrite':'🤖 إعادة صياغة','as-is':'📋 نقل حرفي','forward':'⚡ تحويل مباشر'}[rules.mode]||'🤖';
    const tone = getSetting('tg_tone_'+ch,'');
    const toneLabel = tone ? {'informative':'📰 إخباري','analytical':'🔍 تحليلي','engaging':'✨ جذاب','neutral':'⚖️ محايد'}[tone]||'' : '';
    await sendAdminMsg(chatId,
      '✅ تم إعداد @'+ch+' بالكامل!\n\nوضع النشر: '+modeLabel+(toneLabel?'\nأسلوب: '+toneLabel:'')+'\nينشر على: '+(pubChat==='default'?'القناة الافتراضية':pubChat),
      [[{text:'⏱ تعديل التكرار', callback_data:'interval_'+ch},{text:'🧪 اختبار', callback_data:'test_src_'+ch}],
       [{text:'🔙 المصادر', callback_data:'list_sources'},{text:'🏠 الرئيسية', callback_data:'main'}]]);

  // ===== AWAITING INPUT =====
  } else {
    if(callbackId) return;
    const awaiting = getSetting('admin_awaiting','');
    if(!awaiting) return;
    setSetting('admin_awaiting','');

    if(awaiting === 'add_tg_src') {
      const ch = text.replace('@','').trim();
      try {
        const r = await readTelegramChannel(ch);
        if(r.success) {
          db.prepare('INSERT OR IGNORE INTO sources(name,url,type) VALUES(?,?,?)').run('TG: @'+ch,'https://t.me/s/'+ch,'telegram');
          setSetting('tg_interval_'+ch,'5');
          setSetting('admin_new_src_ch', ch);
          await sendAdminMsg(chatId,
            '✅ تمت إضافة @'+ch+'\nعدد المنشورات: '+r.posts.length+'\n\n📋 اختر أسلوب النشر:',
            [[{text:'🤖 إعادة صياغة بالذكاء الاصطناعي', callback_data:'new_src_mode_rewrite'}],
             [{text:'📋 نقل حرفي (حذف المصدر)', callback_data:'new_src_mode_asis'}],
             [{text:'⚡ تحويل مباشر مع الوسائط', callback_data:'new_src_mode_forward'}]]);
        } else {
          await sendAdminMsg(chatId, '❌ تعذر الوصول لـ @'+ch+'\n'+(r.message||''), [[{text:'🔙 رجوع', callback_data:'sources'}]]);
        }
      } catch(e) { await sendAdminMsg(chatId, '❌ خطأ: '+e.message); }

    } else if(awaiting === 'add_rss_src') {
      try {
        const feed = await parser.parseURL(text);
        const name = feed.title || text;
        db.prepare('INSERT OR IGNORE INTO sources(name,url,type) VALUES(?,?,?)').run(name,text,'rss');
        await sendAdminMsg(chatId, '✅ تمت إضافة RSS: '+name, [[{text:'🔙 المصادر', callback_data:'sources'}]]);
      } catch(e) { await sendAdminMsg(chatId, '❌ خطأ في RSS: '+e.message); }

    } else if(awaiting === 'add_yt_src') {
      const videoId = text.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/)?.[1];
      const url = videoId ? 'https://youtu.be/'+videoId : text;
      db.prepare('INSERT OR IGNORE INTO sources(name,url,type) VALUES(?,?,?)').run('YouTube: '+url.substring(0,30),url,'youtube');
      await sendAdminMsg(chatId, '✅ تمت إضافة مصدر YouTube', [[{text:'🔙 المصادر', callback_data:'sources'}]]);

    } else if(awaiting === 'add_my_channel_name') {
      setSetting('admin_awaiting','add_my_channel_chat_'+text);
      await sendAdminMsg(chatId, '📢 الآن أرسل معرف القناة (مثال: @mychannel أو -100123456789):', [[{text:'❌ إلغاء', callback_data:'cancel_awaiting'}]]);

    } else if(awaiting.startsWith('add_my_channel_chat_')) {
      const name = awaiting.replace('add_my_channel_chat_','');
      const chat = text.trim();
      let channels = [];
      try { channels = JSON.parse(getSetting('my_tg_channels','[]')); } catch(e) {}
      channels.push({name:name, chat:chat});
      setSetting('my_tg_channels', JSON.stringify(channels));
      await sendAdminMsg(chatId, '✅ تمت إضافة القناة: '+name+' ('+chat+')', [[{text:'🔙 قنواتي', callback_data:'my_channels'}]]);

    } else if(awaiting === 'edit_hashtags') {
      setSetting('hashtags', text);
      await sendAdminMsg(chatId, '✅ تم حفظ الهاشتاقات', [[{text:'🔙 رجوع', callback_data:'writing_style'}]]);

    } else if(awaiting === 'edit_tg_token') {
      try {
        const r = await axios.get(`https://api.telegram.org/bot${text}/getMe`);
        if(r.data.ok) {
          setSetting('telegram_token', text);
          await sendAdminMsg(chatId, '✅ تم حفظ Bot Token - @'+r.data.result.username, [[{text:'🔙 رجوع', callback_data:'connection_settings'}]]);
        } else { await sendAdminMsg(chatId, '❌ Token غير صحيح'); }
      } catch(e) { await sendAdminMsg(chatId, '❌ خطأ: '+e.message); }

    } else if(awaiting === 'edit_tg_chat') {
      setSetting('telegram_chat', text);
      await sendAdminMsg(chatId, '✅ تم حفظ القناة الافتراضية: '+text, [[{text:'🔙 رجوع', callback_data:'connection_settings'}]]);

    } else if(awaiting === 'edit_webhook') {
      setSetting('make_webhook', text);
      await sendAdminMsg(chatId, '✅ تم حفظ Make.com Webhook', [[{text:'🔙 رجوع', callback_data:'connection_settings'}]]);
    }
  }
}

async function pollAdminBot() {
  const token = getSetting('admin_bot_token') || process.env.ADMIN_BOT_TOKEN;
  const adminId = getSetting('admin_chat_id') || process.env.ADMIN_CHAT_ID;
  if(!token || !adminId) return;
  try {
    const r = await axios.get(`https://api.telegram.org/bot${token}/getUpdates?offset=${botOffset}&timeout=5&limit=10`, {timeout:10000});
    if(r.data.ok && r.data.result.length) {
      for(const update of r.data.result) {
        botOffset = update.update_id + 1;
        if(update.message) {
          await handleAdminCommand(update.message.chat.id, update.message.text||'', update.message.message_id, null);
        } else if(update.callback_query) {
          await handleAdminCommand(update.callback_query.message.chat.id, update.callback_query.data, update.callback_query.message.message_id, update.callback_query.id);
        }
      }
    }
  } catch(e) {}
}

setInterval(pollAdminBot, 2000);

app.post('/api/admin-bot/setup', async(req,res) => {
  const {token, chatId} = req.body;
  if(!token || !chatId) return res.status(400).json({error:'token and chatId required'});
  try {
    const r = await axios.get(`https://api.telegram.org/bot${token}/getMe`);
    if(r.data.ok) {
      setSetting('admin_bot_token', token);
      setSetting('admin_chat_id', chatId);
      await sendAdminMsg(chatId, '✅ تم ربط بوت التحكم بنجاح!\n\nاضغط /start للبدء');
      res.json({success:true, botName: r.data.result.username});
    } else res.status(400).json({error:'Invalid token'});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// FB Sources API
app.get('/api/fb/sources', (req,res) => {
  const allSources = db.prepare('SELECT * FROM sources WHERE active=1').all();
  const fbSourceIds = db.prepare("SELECT key,value FROM settings WHERE key LIKE 'fb_source_%'").all()
    .map(r=>parseInt(r.value));
  const fbIntervalMap = {};
  db.prepare("SELECT key,value FROM settings WHERE key LIKE 'fb_interval_%'").all()
    .forEach(r=>{ fbIntervalMap[r.key.replace('fb_interval_','')] = r.value; });
  res.json({
    all: allSources,
    selected: fbSourceIds,
    intervals: fbIntervalMap
  });
});

app.post('/api/fb/sources', async(req,res) => {
  const {sourceIds, intervals} = req.body;
  // Clear old FB sources
  db.prepare("DELETE FROM settings WHERE key LIKE 'fb_source_%'").run();
  // Save new ones
  if(sourceIds && sourceIds.length) {
    sourceIds.forEach((id,i) => {
      db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('fb_source_'+i, String(id));
      if(intervals && intervals[id]) {
        db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('fb_interval_'+id, String(intervals[id]));
      }
    });
  }
  setupFBSchedules();
  res.json({success:true, count: sourceIds ? sourceIds.length : 0});
});

app.post('/api/fb/test', async(req,res) => {
  const webhook = getSetting('make_webhook');
  if(!webhook) return res.status(400).json({error:'Make.com webhook not configured'});
  try {
    await axios.post(webhook, {
      content: 'اختبار الربط مع فيسبوك عبر Make.com - ' + new Date().toLocaleString('ar'),
      platform: 'facebook',
      timestamp: new Date().toISOString()
    });
    res.json({success:true, message:'Test post sent to Make.com!'});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/fb/test-source', async(req,res) => {
  const {sourceId, url} = req.body;
  try {
    const webhook = getSetting('make_webhook');
    if(!webhook) return res.json({success:false, error:'Make.com webhook not configured'});

    const src = sourceId ? db.prepare('SELECT * FROM sources WHERE id=?').get(sourceId) : null;
    const type = src ? src.type : (url && url.includes('t.me') ? 'telegram' : 'rss');
    const srcUrl = src ? src.url : url;
    if(!srcUrl) return res.json({success:false, error:'source URL missing'});

    let latest = '';
    if(type === 'telegram') {
      const channel = srcUrl.replace('https://t.me/s/','').replace('https://t.me/','').replace('@','').trim();
      const r = await readTelegramChannel(channel);
      if(!r.success || !r.posts || !r.posts.length) {
        return res.json({success:false, error:'no posts found in channel'});
      }
      latest = (r.posts[0].text || '').trim();
    } else if(type === 'rss') {
      const items = await fetchRSS({url: srcUrl});
      if(!items || !items.length) return res.json({success:false, error:'no RSS items found'});
      const it = items[0];
      latest = ((it.title || '') + '\n\n' + (it.content || '')).trim();
    } else {
      return res.json({success:false, error:'unsupported source type: '+type});
    }

    if(!latest || latest.length < 10) return res.json({success:false, error:'source returned empty content'});

    const prompt = 'أعد صياغة هذا المحتوى كمنشور فيسبوك جذاب باللغة العربية بأسلوب بشري طبيعي. لا تذكر اسم المصدر ولا أي روابط. اختم بسؤال للتفاعل. الحد الأقصى 150 كلمة.\n\nالمحتوى:\n' + latest + '\n\nأعد المنشور فقط بدون مقدمات.';
    let rewritten;
    try {
      rewritten = await callAI(prompt, 600);
    } catch(e) {
      return res.json({success:false, error:'AI error: '+e.message});
    }
    if(!rewritten || !rewritten.trim()) return res.json({success:false, error:'AI returned empty result'});
    rewritten = filterSourceLinks(rewritten.trim());

    try {
      await axios.post(webhook, {
        content: rewritten,
        platform: 'facebook',
        source: src ? src.name : 'test',
        timestamp: new Date().toISOString()
      });
    } catch(e) {
      return res.json({success:false, error:'webhook error: '+e.message});
    }

    res.json({success:true, preview: rewritten.substring(0,100)});
  } catch(e) {
    res.json({success:false, error: e.message});
  }
});


app.post('/api/test/gemini-debug', async(req,res) => {
  const {key} = req.body;
  try {
    const r = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
      {contents:[{parts:[{text:'Say OK'}]}]},
      {headers:{'x-goog-api-key': key, 'Content-Type':'application/json'}, timeout:30000}
    );
    res.json({success:true, response: r.data.candidates[0].content.parts[0].text});
  } catch(e) {
    res.json({success:false, status: e.response?.status, error: e.response?.data || e.message});
  }
});

app.get('/api/test/gemini-debug', async(req,res) => {
  const key = getSetting('gemini_key');
  if(!key) return res.json({error:'No gemini key saved'});
  try {
    const r = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
      {contents:[{parts:[{text:'Say OK'}]}]},
      {headers:{'x-goog-api-key': key, 'Content-Type':'application/json'}, timeout:30000}
    );
    res.json({success:true, response: r.data.candidates[0].content.parts[0].text});
  } catch(e) {
    res.json({success:false, status: e.response?.status, error: e.response?.data || e.message});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server on port', PORT));

// ===== Per-Channel TG Scheduling =====
// Store active intervals
var tgIntervals = {};

async function downloadAndSendMedia(tgToken, tgChat, mediaUrl, caption, mediaType) {
  const tmpFile = os.tmpdir() + '/media_' + Date.now() + (mediaType === 'video' ? '.mp4' : '.jpg');
  try {
    const response = await axios.get(mediaUrl, {
      responseType: 'arraybuffer', timeout: 30000,
      headers: {'User-Agent': 'Mozilla/5.0'}
    });
    require('fs').writeFileSync(tmpFile, Buffer.from(response.data));
    const form = new FormData();
    form.append('chat_id', tgChat);
    form.append('caption', (caption||'').substring(0,1024));
    form.append('parse_mode', 'HTML');
    const endpoint = mediaType==='video' ? 'sendVideo' : 'sendPhoto';
    const fieldName = mediaType==='video' ? 'video' : 'photo';
    form.append(fieldName, require('fs').createReadStream(tmpFile));
    const r = await axios.post(`https://api.telegram.org/bot${tgToken}/${endpoint}`, form, {headers:form.getHeaders(), timeout:60000});
    return r.data.ok;
  } catch(e) {
    console.error('Media send error:', e.message);
    return false;
  } finally {
    try { if(require('fs').existsSync(tmpFile)) require('fs').unlinkSync(tmpFile); } catch(e) {}
  }
}

async function extractAndSendMedia(tgToken, tgChat, channel, msgId, caption) {
  try {
    const r = await axios.get('https://t.me/'+channel+'/'+msgId+'?embed=1&single=1', {
      timeout:10000, headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    });
    const $ = cheerio.load(r.data);

    // Collect all photos
    const photos = [];
    $('.tgme_widget_message_photo_wrap').each(function(i, el) {
      const style = $(el).attr('style') || '';
      const match = style.match(/url\(['"]?(https?:\/\/[^'"()]+)['"]?\)/);
      if(match) photos.push(match[1]);
    });

    // Check for video
    let videoUrl = '';
    $('video').each(function(i, el) {
      const src = $(el).attr('src') || $(el).find('source').attr('src') || '';
      if(src.startsWith('http') && !videoUrl) videoUrl = src;
    });
    // Also check video source tag
    $('video source').each(function(i, el) {
      const src = $(el).attr('src') || '';
      if(src.startsWith('http') && !videoUrl) videoUrl = src;
    });

    // Send video if found
    if(videoUrl) {
      const ok = await downloadAndSendMedia(tgToken, tgChat, videoUrl, caption, 'video');
      if(ok) return true;
    }

    // Send all photos as media group if multiple
    if(photos.length > 1) {
      try {
        // Download all photos to tmp
        const mediaGroup = [];
        const tmpFiles = [];
        for(let i=0; i<Math.min(photos.length, 10); i++) {
          const tmpFile = require('os').tmpdir()+'/photo_'+Date.now()+'_'+i+'.jpg';
          try {
            const res = await axios.get(photos[i], {responseType:'arraybuffer', timeout:20000, headers:{'User-Agent':'Mozilla/5.0'}});
            require('fs').writeFileSync(tmpFile, Buffer.from(res.data));
            tmpFiles.push(tmpFile);
            mediaGroup.push({type:'photo', media:'attach://photo'+i});
          } catch(e) {}
        }
        if(mediaGroup.length > 0) {
          const FormData = require('form-data');
          const form = new FormData();
          form.append('chat_id', tgChat);
          if(mediaGroup.length > 0) mediaGroup[0].caption = (caption||'').substring(0,1024);
          if(mediaGroup.length > 0) mediaGroup[0].parse_mode = 'HTML';
          form.append('media', JSON.stringify(mediaGroup));
          tmpFiles.forEach((f,i) => {
            if(require('fs').existsSync(f)) form.append('photo'+i, require('fs').createReadStream(f));
          });
          const mgR = await axios.post('https://api.telegram.org/bot'+tgToken+'/sendMediaGroup', form, {headers:form.getHeaders(), timeout:60000});
          tmpFiles.forEach(f => { try{ require('fs').unlinkSync(f); }catch(e){} });
          if(mgR.data.ok) return true;
        }
      } catch(e) { console.error('MediaGroup error:', e.message); }
    }

    // Single photo
    if(photos.length === 1) {
      const ok = await downloadAndSendMedia(tgToken, tgChat, photos[0], caption, 'photo');
      if(ok) return true;
    }

    // Fallback: og:image
    const ogImg = $('meta[property="og:image"]').attr('content') || '';
    if(ogImg.startsWith('http')) {
      return await downloadAndSendMedia(tgToken, tgChat, ogImg, caption, 'photo');
    }

    return false;
  } catch(e) {
    console.error('extractAndSendMedia error:', e.message);
    return false;
  }
}

function cleanArabicOnly(text) {
  return text
    .replace(/[^\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\s\d.,!?؟،؛:«»\-\(\)@#\n]/g, '')
    .replace(/\s{3,}/g, '\n\n')
    .trim();
}

function cleanRewrittenText(text) {
  const patterns = [
    /^صحيح[،,]?\s*/i,
    /^إليك\s+[^:\n]+[:\n]\s*/i,
    /^يعد\s+صياغة\s+[^:\n]+[:\n]\s*/i,
    /^بعد\s+إعادة\s+[^:\n]+[:\n]\s*/i,
    /^إعادة\s+صياغة\s+[^:\n]+[:\n]\s*/i,
    /^النص\s+المعاد\s+[^:\n]+[:\n]\s*/i,
    /^الخبر\s+[^:\n]+[:\n]\s*/i,
    /^تمت\s+إعادة\s+[^:\n]+[:\n]\s*/i,
    /^فيما\s+يلي\s+[^:\n]+[:\n]\s*/i,
    /^هذا\s+هو\s+[^:\n]+[:\n]\s*/i,
  ];
  let t = text.trim();
  for(const p of patterns) t = t.replace(p, '');
  return t.trim();
}

async function processTGChannel(channel) {
  try {
    const publishTo = getSetting('tg_publish_to_'+channel, '');
    const tgToken = getSetting('telegram_token');
    const tgChat = publishTo || getSetting('telegram_chat');
    if(!tgToken || !tgChat) return;

    const rules = JSON.parse(getSetting('tg_rules_'+channel, '{"mode":"rewrite","keywords":"","ignore":""}'));

    let myChannelLink = '';
    try {
      const myChans = JSON.parse(getSetting('my_tg_channels','[]'));
      const mc = myChans.find(c => c.chat===tgChat || c.chat==='@'+tgChat.replace('@',''));
      if(mc) myChannelLink = '\n\n📢 <a href="https://t.me/'+mc.chat.replace('@','')+'">'+(mc.name||mc.chat)+'</a>';
    } catch(e) {}
    const appendMine = txt => myChannelLink ? (txt.trim() + myChannelLink) : txt;

    let posts = [];
    try {
      const r = await axios.get('https://t.me/s/'+channel, {
        timeout:10000,
        headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
      });
      const $ = cheerio.load(r.data);
      $('.tgme_widget_message').each(function(i, el) {
        const msgLink = $(el).find('.tgme_widget_message_date').attr('href') || '';
        const msgIdMatch = msgLink.match(/\/([0-9]+)$/);
        const msgId = msgIdMatch ? parseInt(msgIdMatch[1]) : null;
        const text = $(el).find('.tgme_widget_message_text').text().trim();
        const hasPhoto = $(el).find('.tgme_widget_message_photo_wrap, .tgme_widget_message_sticker_wrap').length > 0;
        const hasVideo = $(el).find('.tgme_widget_message_video_wrap, .tgme_widget_message_video').length > 0;
        posts.push({ msgId, text, hasMedia: hasPhoto||hasVideo });
      });
      // Newest first
      posts = posts.filter(p=>p.msgId).sort((a,b)=>b.msgId-a.msgId);
    } catch(e) { console.error('Scrape error:', channel, e.message); return; }

    if(!posts.length) return;

    for(const post of posts.slice(0,3)) {
      const key = channel+'/'+post.msgId;
      const existing = db.prepare('SELECT id FROM posts WHERE original_url=?').get(key);
      if(existing) continue;

      console.log('Post msgId:'+post.msgId+' hasMedia:'+post.hasMedia+' textLen:'+(post.text||'').length);

      const ignoreWords = (rules.ignore||'').split(',').map(w=>w.trim()).filter(Boolean);
      const keywords = (rules.keywords||'').split(',').map(w=>w.trim()).filter(Boolean);

      if(ignoreWords.length && post.text && ignoreWords.some(w=>post.text.toLowerCase().includes(w.toLowerCase()))) {
        db.prepare('INSERT OR IGNORE INTO posts (source_id,original_title,original_url,original_content,status) VALUES(0,?,?,?,?)').run('IGNORED:'+post.msgId, key, post.text||'', 'ignored');
        continue;
      }
      if(keywords.length && post.text && !keywords.some(w=>post.text.toLowerCase().includes(w.toLowerCase()))) continue;

      const titleKey = post.text ? post.text.substring(0,60) : 'media_'+post.msgId;
      const mode = rules.mode || 'rewrite';
      let finalText = '';
      let usedFallback = false;
      let skipped = false;

      if(mode === 'as-is') {
        finalText = appendMine(filterSourceLinks(post.text||''));
      } else {
        // Rewrite with AI (strict Arabic-only); fallback to filtered original on failure
        try {
          if(!post.text || post.text.length < 10) {
            finalText = '';
          } else {
            const text = post.text;
            const srcTone = getSetting('tg_tone_'+channel, getSetting('writing_tone','informative'));
            const toneMap = {informative:'إخباري احترافي', analytical:'تحليلي معمق', engaging:'جذاب وشيق', neutral:'محايد موضوعي'};
            const toneAr = toneMap[srcTone] || 'إخباري احترافي';
            const prompt = isArabicText(text)
              ? 'أعد صياغة هذا الخبر بالعربية الفصحى بأسلوب '+toneAr+'.\n\nقواعد صارمة:\n1. اكتب بالعربية فقط - ممنوع أي حرف من لغة أخرى\n2. إذا وجدت كلمات غير عربية في المصدر، ترجمها أو احذفها\n3. لا تذكر اسم القناة أو المصدر أو أي روابط\n4. إذا كان النص إعلاناً أو رأياً شخصياً بدون خبر حقيقي: أجب فقط بكلمة SKIP\n5. الحد الأقصى 250 كلمة\n\nالخبر:\n' + text + '\n\nأعد الخبر بالعربية فقط بدون أي حرف أجنبي.'
              : 'You are a professional Arabic translator and news editor. Style: '+toneAr+'.\n\nYour task: Translate and rewrite the following text into fluent, professional Arabic.\n\nSTRICT RULES:\n1. ALWAYS write the output in Arabic ONLY - translate everything\n2. NEVER leave any English, Chinese, Russian, or other non-Arabic words in the output\n3. Do NOT mention the source, channel name, or any URLs\n4. If the text is ONLY an advertisement, spam, or meaningless: reply with exactly the word SKIP\n5. Keep the meaning intact, maximum 250 words\n\nText to translate:\n' + text + '\n\nWrite the Arabic translation now:';
            await new Promise(r=>setTimeout(r,2000));
            let rewritten = '';
            try {
              rewritten = await callAI(prompt, 800);
            } catch(e) {
              if(e.message && e.message.includes('429')) {
                console.log('Rate limit 429, waiting 15s then retry...');
                await new Promise(r=>setTimeout(r,15000));
                try { rewritten = await callAI(prompt, 800); } catch(e2) {
                  console.log('Retry also failed:', e2.message);
                  rewritten = '';
                }
              } else {
                throw e;
              }
            }
            if(rewritten && rewritten.trim() === 'SKIP') {
              skipped = true;
            } else {
              const refusalPhrases = ['لا أستطيع','لا يمكنني','عذراً','آسف','I cannot','I am unable','أنصحك','مصادر موثوقة','لا أملك','غير قادر'];
              if(!rewritten || refusalPhrases.some(p => rewritten.includes(p))) throw new Error('ai_refusal');
              rewritten = cleanArabicOnly(cleanRewrittenText(rewritten));
              finalText = appendMine(filterSourceLinks(rewritten));
            }
          }
        } catch(e) {
          console.log('AI failed for msg', post.msgId, '- using filtered original:', e.message);
          usedFallback = true;
          finalText = appendMine(filterSourceLinks(post.text || ''));
        }
      }

      if(skipped) {
        db.prepare('INSERT OR IGNORE INTO posts (source_id,original_title,original_url,original_content,status) VALUES(0,?,?,?,?)').run('SKIP:'+post.msgId, key, post.text||'', 'ignored');
        console.log('AI returned SKIP for msg', post.msgId);
        continue;
      }

      const pid = db.prepare('INSERT OR IGNORE INTO posts (source_id,original_title,original_url,original_content,rewritten_telegram,status) VALUES(0,?,?,?,?,?)').run(titleKey, key, post.text||'', finalText, 'ready').lastInsertRowid;
      if(!pid) continue;

      try {
        if(post.hasMedia) {
          console.log('Trying extractAndSendMedia for @'+channel+' msgId:'+post.msgId);
          const mediaSent = await extractAndSendMedia(tgToken, tgChat, channel, post.msgId, finalText);
          if(mediaSent) {
            console.log('Media sent via download @'+channel+' msg:'+post.msgId);
            db.prepare("UPDATE posts SET status='published', published_at=datetime('now') WHERE id=?").run(pid);
            db.prepare("INSERT INTO publish_log(post_id,platform,status,message) VALUES(?,?,?,?)").run(pid,'telegram','success','@'+channel+' +media downloaded');
            await new Promise(r=>setTimeout(r,800));
            continue;
          } else {
            console.log('Media extraction failed, sending text only for msgId:'+post.msgId);
          }
        }

        // Send rewritten text as separate message
        if(finalText && finalText.trim().length > 5) {
          const r = await axios.post(`https://api.telegram.org/bot${tgToken}/sendMessage`,{
            chat_id: tgChat, text: finalText, parse_mode: 'HTML'
          });
          if(r.data.ok) {
            db.prepare("UPDATE posts SET status='published', published_at=datetime('now') WHERE id=?").run(pid);
            db.prepare("INSERT INTO publish_log(post_id,platform,status,message) VALUES(?,?,?,?)").run(pid,'telegram','success', usedFallback?'published (fallback)':'published');
            console.log('PUBLISHED from @'+channel+' msg '+post.msgId+(usedFallback?' [fallback]':''));
          }
        } else if(post.hasMedia) {
          // Media-only post: mark published after forward
          db.prepare("UPDATE posts SET status='published', published_at=datetime('now') WHERE id=?").run(pid);
          db.prepare("INSERT INTO publish_log(post_id,platform,status,message) VALUES(?,?,?,?)").run(pid,'telegram','success','media forwarded');
        }
      } catch(e) {
        // Never publish error messages to the channel
        db.prepare("INSERT INTO publish_log(post_id,platform,status,message) VALUES(?,?,?,?)").run(pid,'telegram','error',e.message);
      }
      await new Promise(r=>setTimeout(r,800));
    }
  } catch(e) { console.error('processTGChannel error:', channel, e.message); }
}


function setupTGSchedules() {
  // Clear existing cron jobs
  Object.values(tgIntervals).forEach(job => { try { job.stop(); } catch(e) {} });
  tgIntervals = {};

  // Get all TG sources
  const tgSources = db.prepare("SELECT * FROM sources WHERE type='telegram' AND active=1").all();

  tgSources.forEach(src => {
    const channel = src.url.replace('https://t.me/s/','');
    const intervalMin = parseInt(getSetting('tg_interval_'+channel, '5'));
    const publishTo = getSetting('tg_publish_to_'+channel, '');

    // Build cron expression
    let cronExpr;
    if(intervalMin <= 1) cronExpr = '* * * * *';
    else if(intervalMin < 60) cronExpr = `*/${intervalMin} * * * *`;
    else cronExpr = `0 */${Math.floor(intervalMin/60)} * * *`;

    console.log(`TG: @${channel} cron="${cronExpr}" -> ${publishTo||'default'}`);

    // Run immediately first
    processTGChannel(channel).catch(console.error);

    // Then schedule with cron
    try {
      const job = cron.schedule(cronExpr, () => {
        processTGChannel(channel).catch(console.error);
      }, { timezone: 'Asia/Riyadh' });
      tgIntervals[channel] = job;
    } catch(e) {
      console.error('Cron error for', channel, e.message);
      // Fallback to setInterval
      tgIntervals[channel] = { stop: () => {} };
      setInterval(() => processTGChannel(channel).catch(console.error), intervalMin * 60 * 1000);
    }
  });

  console.log(`TG schedules active: ${Object.keys(tgIntervals).length} channels`);
}

// Setup on startup + refresh when settings change
app.post('/api/tg/refresh-schedules', (req,res) => {
  setupTGSchedules();
  const channels = Object.keys(tgIntervals);
  res.json({success:true, active:channels.length, channels:channels});
});

app.get('/api/tg/schedules-status', (req,res) => {
  const tgSources = db.prepare("SELECT * FROM sources WHERE type='telegram' AND active=1").all();
  const status = tgSources.map(s => {
    const ch = s.url.replace('https://t.me/s/','');
    return {
      channel: ch,
      interval: getSetting('tg_interval_'+ch,'5'),
      publishTo: getSetting('tg_publish_to_'+ch,''),
      active: !!tgIntervals[ch]
    };
  });
  res.json({success:true, schedules:status, total:status.length, activeCount:status.filter(s=>s.active).length});
});

// ===== Channel Rules API =====
app.post('/api/tg/rules', async(req,res) => {
  const {channel, mode, keywords, ignore} = req.body;
  if(!channel) return res.status(400).json({error:'channel required'});
  setSetting('tg_rules_'+channel, JSON.stringify({mode:mode||'rewrite', keywords:keywords||'', ignore:ignore||''}));
  res.json({success:true});
});

app.get('/api/tg/rules/:channel', (req,res) => {
  const rules = JSON.parse(getSetting('tg_rules_'+req.params.channel, '{"mode":"rewrite","keywords":"","ignore":""}'));
  res.json({success:true, rules});
});

// Start schedules on boot
setTimeout(setupTGSchedules, 3000);
setTimeout(setupFBSchedules, 5000);

// Re-setup every hour as failsafe
setInterval(() => {
  console.log('Hourly re-setup of TG schedules...');
  setupTGSchedules();
}, 60 * 60 * 1000);

// ===== Keep-Alive: prevent Railway sleep =====
const RAILWAY_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : process.env.RAILWAY_URL || '';

if(RAILWAY_URL) {
  // Ping self every 4 minutes to prevent sleep
  setInterval(async () => {
    try {
      await axios.get(RAILWAY_URL + '/api/ping', { timeout: 10000 });
      console.log('Keep-alive ping OK');
    } catch(e) {
      console.log('Keep-alive ping failed:', e.message);
    }
  }, 4 * 60 * 1000);
  console.log('Keep-alive enabled for:', RAILWAY_URL);
} else {
  console.log('Keep-alive: set RAILWAY_URL env variable to enable');
}
