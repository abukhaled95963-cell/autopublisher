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

const app = express();
const parser = new Parser();

// Persistent DB path
const DB_DIR = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : '/app/data';
try { if(!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, {recursive:true}); } catch(e) {}
const DB_FILE = process.env.DB_PATH || (fs.existsSync(DB_DIR) ? DB_DIR+'/autopublisher.db' : 'autopublisher.db');
const db = new Database(DB_FILE);
console.log('DB:', DB_FILE);

app.use(cors());
app.use(express.json());

// Static files
const publicPath = path.join(__dirname, 'public');
if(fs.existsSync(publicPath)) app.use(express.static(publicPath));

// ===== DB Setup =====
db.exec(`
  CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, url TEXT NOT NULL UNIQUE,
    type TEXT DEFAULT 'rss', active INTEGER DEFAULT 1,
    last_check TEXT, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER, original_title TEXT,
    original_url TEXT UNIQUE, original_content TEXT,
    rewritten_twitter TEXT, rewritten_facebook TEXT,
    rewritten_instagram TEXT, rewritten_telegram TEXT,
    rewritten_blogger TEXT, status TEXT DEFAULT 'pending',
    published_at TEXT, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS publish_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER, platform TEXT, status TEXT,
    message TEXT, published_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

function getSetting(k, d) { const r=db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r?r.value:(d||''); }
function setSetting(k, v) { db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(k,v); }

// ===== AI =====
async function callAI(prompt, maxTokens) {
  maxTokens = maxTokens || 800;
  const provider = getSetting('ai_provider','claude');
  if(provider === 'gemini') {
    const key = getSetting('gemini_key');
    if(!key) throw new Error('Gemini key not set');
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
      { contents:[{parts:[{text:prompt}]}], generationConfig:{maxOutputTokens:maxTokens} }
    );
    return r.data.candidates[0].content.parts[0].text;
  } else if(provider === 'openai') {
    const key = getSetting('openai_key');
    if(!key) throw new Error('OpenAI key not set');
    const r = await axios.post('https://api.openai.com/v1/chat/completions',
      {model:'gpt-4o-mini', max_tokens:maxTokens, messages:[{role:'user',content:prompt}]},
      {headers:{Authorization:'Bearer '+key}}
    );
    return r.data.choices[0].message.content;
  } else if(provider === 'groq') {
    const key = getSetting('groq_key');
    if(!key) throw new Error('Groq key not set');
    const r = await axios.post('https://api.groq.com/openai/v1/chat/completions',
      {model:'llama3-8b-8192', max_tokens:maxTokens, messages:[{role:'user',content:prompt}]},
      {headers:{Authorization:'Bearer '+key}}
    );
    return r.data.choices[0].message.content;
  } else {
    const key = getSetting('claude_key');
    if(!key) throw new Error('Claude key not set');
    const r = await axios.post('https://api.anthropic.com/v1/messages',
      {model:'claude-sonnet-4-20250514', max_tokens:maxTokens, messages:[{role:'user',content:prompt}]},
      {headers:{'x-api-key':key,'anthropic-version':'2023-06-01'}}
    );
    return r.data.content[0].text;
  }
}

// ===== Read TG Channel =====
async function readTelegramChannel(channel) {
  const ch = channel.replace('@','').trim();
  let results = [];
  // Method 1: rsshub
  try {
    const rssUrl = 'https://rsshub.app/telegram/channel/'+ch;
    const r = await axios.get('https://api.rss2json.com/v1/api.json?rss_url='+encodeURIComponent(rssUrl)+'&count=10',{timeout:8000});
    if(r.data.status==='ok' && r.data.items && r.data.items.length>0) {
      r.data.items.forEach(i=>{
        const text=(i.content||i.title||'').replace(/<[^>]*>/g,'').trim();
        if(text) results.push({text,date:i.pubDate,source:'rsshub'});
      });
      if(results.length>0) return {success:true, posts:results, method:'rsshub'};
    }
  } catch(e) {}
  // Method 2: t.me/s scraping
  try {
    const r = await axios.get('https://t.me/s/'+ch,{timeout:10000,headers:{'User-Agent':'Mozilla/5.0'}});
    const $ = cheerio.load(r.data);
    $('.tgme_widget_message_text').each(function(i,el){
      if(i<10){const text=$(el).text().trim(); if(text) results.push({text:text.substring(0,500),date:new Date().toISOString(),source:'tme'});}
    });
    if(results.length>0) return {success:true, posts:results, method:'tme_scrape'};
  } catch(e) {}
  return {success:false, posts:[], message:'Cannot read @'+ch+' — must be public'};
}

// ===== Process TG Channel (with media forward) =====
async function processTGChannel(channel) {
  try {
    const publishTo = getSetting('tg_publish_to_'+channel,'');
    const tgToken = getSetting('telegram_token');
    const tgChat = publishTo || getSetting('telegram_chat');
    if(!tgToken || !tgChat) { console.log('No token/chat for @'+channel); return; }

    const rules = JSON.parse(getSetting('tg_rules_'+channel,'{"mode":"rewrite","keywords":"","ignore":""}'));
    const mode = rules.mode || 'rewrite';

    let myChannelLink = '';
    try {
      const myChans = JSON.parse(getSetting('my_tg_channels','[]'));
      const mc = myChans.find(c=>c.chat===tgChat||c.chat==='@'+tgChat.replace('@',''));
      if(mc) myChannelLink = '\n\n📢 @'+mc.chat.replace('@','');
    } catch(e) {}

    // Scrape for msgIds + text + hasMedia
    let posts = [];
    try {
      const r = await axios.get('https://t.me/s/'+channel,{timeout:12000,headers:{'User-Agent':'Mozilla/5.0'}});
      const $ = cheerio.load(r.data);
      $('.tgme_widget_message').each(function(i,el){
        const link = $(el).find('.tgme_widget_message_date').attr('href')||'';
        const m = link.match(/\/([0-9]+)$/);
        const msgId = m ? parseInt(m[1]) : null;
        const text = $(el).find('.tgme_widget_message_text').text().trim();
        const hasMedia = $(el).find('.tgme_widget_message_photo_wrap,.tgme_widget_message_video_wrap,.tgme_widget_message_video').length>0;
        if(msgId) posts.push({msgId,text,hasMedia});
      });
      posts = posts.sort((a,b)=>b.msgId-a.msgId);
    } catch(e) { console.error('Scrape @'+channel+':',e.message); return; }

    if(!posts.length) return;

    const ignoreWords = (rules.ignore||'').split(',').map(w=>w.trim()).filter(Boolean);
    const keywords = (rules.keywords||'').split(',').map(w=>w.trim()).filter(Boolean);

    for(const post of posts.slice(0,3)) {
      const key = channel+'/'+post.msgId;
      if(db.prepare('SELECT id FROM posts WHERE original_url=?').get(key)) continue;

      const text = post.text || '';
      if(ignoreWords.length && text && ignoreWords.some(w=>text.toLowerCase().includes(w.toLowerCase()))) {
        db.prepare('INSERT OR IGNORE INTO posts (source_id,original_title,original_url,original_content,status) VALUES(0,?,?,?,?)').run('IGN:'+post.msgId,key,text,'ignored');
        continue;
      }
      if(keywords.length && text && !keywords.some(w=>text.toLowerCase().includes(w.toLowerCase()))) continue;

      if(mode==='forward') {
        try {
          const fwd = await axios.post(`https://api.telegram.org/bot${tgToken}/forwardMessage`,{chat_id:tgChat,from_chat_id:'@'+channel,message_id:post.msgId});
          if(fwd.data.ok) {
            db.prepare('INSERT OR IGNORE INTO posts (source_id,original_title,original_url,original_content,status,published_at) VALUES(0,?,?,?,?,datetime("now"))').run(text.substring(0,60)||'fwd',key,text,'published');
            db.prepare("INSERT INTO publish_log(post_id,platform,status,message) VALUES(0,'telegram','success',?)").run('fwd @'+channel);
            console.log('FORWARDED @'+channel+' msg:'+post.msgId);
          }
        } catch(e) { console.error('Forward:',e.message); }
        await new Promise(r=>setTimeout(r,800)); continue;
      }

      // Forward media first
      let mediaOk = false;
      if(post.hasMedia) {
        try {
          const fwd = await axios.post(`https://api.telegram.org/bot${tgToken}/forwardMessage`,{chat_id:tgChat,from_chat_id:'@'+channel,message_id:post.msgId});
          mediaOk = fwd.data.ok;
          if(mediaOk) await new Promise(r=>setTimeout(r,500));
        } catch(e) {}
      }

      if(!text || text.length<10) {
        if(mediaOk) db.prepare('INSERT OR IGNORE INTO posts (source_id,original_title,original_url,original_content,status,published_at) VALUES(0,?,?,?,?,datetime("now"))').run('media:'+post.msgId,key,text,'published');
        await new Promise(r=>setTimeout(r,800)); continue;
      }

      let finalText = '';
      if(mode==='as-is') {
        finalText = text + myChannelLink;
      } else {
        const isNonArabic = !/[\u0600-\u06FF]/.test(text.substring(0,50));
        const prompt = isNonArabic
          ? `You are an Arabic news editor. Rewrite as professional Arabic news.\nRules: if sarcasm/ad/opinion only → reply SKIP. No source URLs.\nPost: ${text}\nReturn Arabic article or SKIP.`
          : `أعد صياغة هذا الخبر بالعربية الاحترافية.\nقواعد: لا تذكر المصدر أو روابط. إذا كان إعلاناً → أجب SKIP.\nالخبر: ${text}\nأعد الخبر فقط.`;
        let rewritten = text;
        try { rewritten = await callAI(prompt, 600); } catch(e) {}
        if(rewritten.trim().toUpperCase().startsWith('SKIP')) {
          db.prepare('INSERT OR IGNORE INTO posts (source_id,original_title,original_url,original_content,status) VALUES(0,?,?,?,?)').run('SKIP:'+post.msgId,key,text,'ignored');
          console.log('SKIPPED @'+channel+' msg:'+post.msgId);
          await new Promise(r=>setTimeout(r,500)); continue;
        }
        const refusals = ['لا أستطيع','لا يمكنني','عذراً، لكن','I cannot','I am unable'];
        if(refusals.some(p=>rewritten.includes(p))) rewritten = text;
        rewritten = rewritten.replace(/https?:\/\/\S+/g,'').replace(/t\.me\/\S+/g,'').trim();
        finalText = rewritten + myChannelLink;
      }

      if(finalText.trim().length<5) { await new Promise(r=>setTimeout(r,800)); continue; }
      const pid = db.prepare('INSERT OR IGNORE INTO posts (source_id,original_title,original_url,original_content,rewritten_telegram,status) VALUES(0,?,?,?,?,?)').run(text.substring(0,60),key,text,finalText,'ready').lastInsertRowid;
      if(!pid) { await new Promise(r=>setTimeout(r,800)); continue; }
      try {
        const msgR = await axios.post(`https://api.telegram.org/bot${tgToken}/sendMessage`,{chat_id:tgChat,text:finalText,parse_mode:'HTML'});
        if(msgR.data.ok) {
          db.prepare("UPDATE posts SET status='published', published_at=datetime('now') WHERE id=?").run(pid);
          db.prepare("INSERT INTO publish_log(post_id,platform,status,message) VALUES(?,?,?,?)").run(pid,'telegram','success','@'+channel+(mediaOk?' +media':''));
          console.log('PUBLISHED @'+channel+' msg:'+post.msgId+(mediaOk?' +media':''));
        }
      } catch(e) {
        db.prepare("INSERT INTO publish_log(post_id,platform,status,message) VALUES(?,?,?,?)").run(pid,'telegram','error',e.message);
      }
      await new Promise(r=>setTimeout(r,800));
    }
  } catch(e) { console.error('processTGChannel @'+channel+':',e.message); }
}

// ===== TG Schedules =====
var tgIntervals = {};
function setupTGSchedules() {
  Object.values(tgIntervals).forEach(j=>{try{j.stop();}catch(e){}});
  tgIntervals = {};
  const sources = db.prepare("SELECT * FROM sources WHERE type='telegram' AND active=1").all();
  sources.forEach(src=>{
    const channel = src.url.replace('https://t.me/s/','');
    const mins = parseInt(getSetting('tg_interval_'+channel,'5'));
    const cronExpr = mins<60 ? `*/${Math.max(1,mins)} * * * *` : `0 */${Math.floor(mins/60)} * * *`;
    processTGChannel(channel).catch(console.error);
    try {
      tgIntervals[channel] = cron.schedule(cronExpr,()=>processTGChannel(channel).catch(console.error),{timezone:'Asia/Riyadh'});
    } catch(e) {
      setInterval(()=>processTGChannel(channel).catch(console.error), mins*60*1000);
    }
    console.log('TG schedule @'+channel+' every '+mins+'min');
  });
}

// ===== Fetch RSS =====
async function fetchRSS(source) {
  try {
    const feed = await parser.parseURL(source.url);
    return feed.items.slice(0,5).map(i=>({title:i.title||'',url:i.link||'',content:(i.contentSnippet||i.content||i.title||'').substring(0,500)}));
  } catch(e) { return []; }
}

// ===== Rewrite Content =====
async function rewriteContent(title, content, url) {
  const lang = getSetting('content_lang','ar');
  const tone = getSetting('writing_tone','informative');
  const hashtags = getSetting('hashtags','');
  const langTxt = lang==='ar'?'باللغة العربية':lang==='en'?'in English':'بالعربية والإنجليزية';
  const toneMap = {informative:'إخباري',analytical:'تحليلي',engaging:'جذاب',neutral:'محايد'};
  const prompt = `أعد صياغة هذا المحتوى بأسلوب ${toneMap[tone]||'إخباري'} ${langTxt}. لا تذكر المصدر أو روابط.\n\nالعنوان: ${title}\nالمحتوى: ${(content||'').substring(0,800)}\n\n[TWITTER]نص مختصر ${hashtags}[/TWITTER]\n[FACEBOOK]فقرة جذابة + سؤال[/FACEBOOK]\n[INSTAGRAM]نص + هاشتاقات[/INSTAGRAM]\n[TELEGRAM]تحليل 200 كلمة[/TELEGRAM]\n[BLOGGER]مقال 400 كلمة[/BLOGGER]`;
  const result = await callAI(prompt, 2000);
  const extract = tag => { const m=result.match(new RegExp('\\['+tag+'\\]([\\s\\S]*?)\\[/'+tag+'\\]','i')); return m?m[1].trim():''; };
  return {twitter:extract('TWITTER'),facebook:extract('FACEBOOK'),instagram:extract('INSTAGRAM'),telegram:extract('TELEGRAM'),blogger:extract('BLOGGER')};
}

// ===== Publish Post =====
async function publishPost(post) {
  const logs = [];
  const tgToken=getSetting('telegram_token'), tgChat=getSetting('telegram_chat');
  const webhook=getSetting('make_webhook');
  const fbToken=getSetting('facebook_page_token'), fbPageId=getSetting('facebook_page_id');
  if(tgToken && tgChat && post.rewritten_telegram) {
    try { const r=await axios.post(`https://api.telegram.org/bot${tgToken}/sendMessage`,{chat_id:tgChat,text:post.rewritten_telegram,parse_mode:'HTML'}); logs.push({platform:'telegram',status:r.data.ok?'success':'error'}); }
    catch(e) { logs.push({platform:'telegram',status:'error',message:e.message}); }
  }
  if(fbToken && fbPageId && post.rewritten_facebook) {
    try { await axios.post(`https://graph.facebook.com/v19.0/${fbPageId}/feed`,{message:post.rewritten_facebook,access_token:fbToken}); logs.push({platform:'facebook',status:'success'}); }
    catch(e) { logs.push({platform:'facebook',status:'error',message:e.message}); }
  }
  if(webhook && (post.rewritten_twitter||post.rewritten_facebook)) {
    try { await axios.post(webhook,{content:post.rewritten_twitter||post.rewritten_facebook,platforms:['twitter','instagram'],timestamp:new Date().toISOString()}); logs.push({platform:'twitter/instagram',status:'success'}); }
    catch(e) { logs.push({platform:'twitter/instagram',status:'error',message:e.message}); }
  }
  logs.forEach(l=>db.prepare('INSERT INTO publish_log(post_id,platform,status,message) VALUES(?,?,?,?)').run(post.id,l.platform,l.status,l.message||''));
  db.prepare("UPDATE posts SET status='published', published_at=datetime('now') WHERE id=?").run(post.id);
  return logs;
}

// ===== Daily Cycle =====
async function dailyCycle() {
  console.log('Daily cycle:', new Date().toISOString());
  const sources = db.prepare("SELECT * FROM sources WHERE active=1 AND type!='telegram'").all();
  for(const src of sources) {
    let items = [];
    try {
      if(src.type==='youtube') {
        const videoId = src.url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/)?.[1];
        if(videoId && !db.prepare('SELECT id FROM posts WHERE original_url LIKE ?').get('%'+videoId+'%')) {
          let title='YouTube '+videoId;
          try { const oe=await axios.get('https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v='+videoId+'&format=json'); title=oe.data.title; } catch(e) {}
          items=[{title,url:'https://youtu.be/'+videoId,content:title}];
        }
      } else { items=await fetchRSS(src); }
    } catch(e) {}
    db.prepare("UPDATE sources SET last_check=datetime('now') WHERE id=?").run(src.id);
    for(const item of items) {
      if(!item.url) continue;
      if(db.prepare('SELECT id FROM posts WHERE original_url=?').get(item.url)) continue;
      try {
        const rw = await rewriteContent(item.title,item.content,item.url);
        const pid = db.prepare("INSERT OR IGNORE INTO posts (source_id,original_title,original_url,original_content,rewritten_twitter,rewritten_facebook,rewritten_instagram,rewritten_telegram,rewritten_blogger,status) VALUES(?,?,?,?,?,?,?,?,?,'ready')").run(src.id,item.title,item.url,item.content,rw.twitter,rw.facebook,rw.instagram,rw.telegram,rw.blogger).lastInsertRowid;
        if(pid && getSetting('auto_publish','1')==='1') {
          const p = db.prepare('SELECT * FROM posts WHERE id=?').get(pid);
          await publishPost(p);
        }
        await new Promise(r=>setTimeout(r,2000));
      } catch(e) { console.error('Item error:',e.message); }
    }
  }
  console.log('Daily cycle done');
}

// ===== Facebook Sources =====
async function processFBSource(source) {
  const webhook = getSetting('make_webhook');
  if(!webhook) return;
  let posts = [];
  try {
    if(source.type==='telegram') {
      const ch = source.url.replace('https://t.me/s/','');
      const r = await readTelegramChannel(ch);
      if(r.success) posts = r.posts.slice(0,3);
    } else {
      const items = await fetchRSS(source);
      posts = items.map(i=>({text:i.title+'. '+i.content}));
    }
  } catch(e) {}
  for(const post of posts.slice(0,2)) {
    const text = post.text||'';
    if(text.length<20) continue;
    const key = 'fb_'+source.id+'_'+text.substring(0,40);
    if(db.prepare('SELECT id FROM posts WHERE original_url=?').get(key)) continue;
    const prompt = `أنت كاتب محتوى فيسبوك. أعد صياغة هذا المحتوى بأسلوب جذاب مناسب لفيسبوك باللغة العربية. لا تذكر المصدر أو الروابط. اختم بسؤال للتفاعل.\n\n${text.substring(0,600)}\n\nأعد المنشور فقط.`;
    let fbText = text;
    try { fbText = await callAI(prompt,500); } catch(e) {}
    const refusals=['لا أستطيع','لا يمكنني','عذراً، لكن'];
    if(refusals.some(p=>fbText.includes(p))) fbText=text.substring(0,400);
    const pid = db.prepare("INSERT OR IGNORE INTO posts (source_id,original_title,original_url,original_content,rewritten_facebook,status) VALUES(?,?,?,?,?,'ready')").run(source.id,text.substring(0,80),key,text,fbText).lastInsertRowid;
    if(!pid) continue;
    try {
      await axios.post(webhook,{content:fbText,platform:'facebook',timestamp:new Date().toISOString()});
      db.prepare("UPDATE posts SET status='published', published_at=datetime('now') WHERE id=?").run(pid);
      db.prepare("INSERT INTO publish_log(post_id,platform,status,message) VALUES(?,'facebook','success','via Make.com')").run(pid);
    } catch(e) { db.prepare("INSERT INTO publish_log(post_id,platform,status,message) VALUES(?,'facebook','error',?)").run(pid,e.message); }
    await new Promise(r=>setTimeout(r,2000));
  }
}

var fbIntervals = {};
function setupFBSchedules() {
  Object.values(fbIntervals).forEach(j=>{try{j.stop();}catch(e){}});
  fbIntervals = {};
  const fbKeys = db.prepare("SELECT key,value FROM settings WHERE key LIKE 'fb_source_%'").all();
  fbKeys.forEach(k=>{
    const src = db.prepare('SELECT * FROM sources WHERE id=? AND active=1').get(parseInt(k.value));
    if(!src) return;
    const mins = parseInt(getSetting('fb_interval_'+src.id,'30'));
    const cronExpr = mins<60 ? `*/${mins} * * * *` : `0 */${Math.floor(mins/60)} * * *`;
    processFBSource(src);
    try { fbIntervals[src.id]=cron.schedule(cronExpr,()=>processFBSource(src),{timezone:'Asia/Riyadh'}); } catch(e) {}
  });
}

// ===== API Routes =====
app.get('/api/ping',(req,res)=>res.json({status:'alive',time:new Date().toISOString(),uptime:process.uptime()}));

app.get('/api/stats',(req,res)=>res.json({
  totalSources:db.prepare("SELECT COUNT(*) c FROM sources WHERE active=1").get().c,
  totalPosts:db.prepare("SELECT COUNT(*) c FROM posts").get().c,
  publishedToday:db.prepare("SELECT COUNT(*) c FROM publish_log WHERE date(published_at)=date('now') AND status='success'").get().c,
  errors:db.prepare("SELECT COUNT(*) c FROM publish_log WHERE date(published_at)=date('now') AND status='error'").get().c
}));

app.get('/api/sources',(req,res)=>res.json(db.prepare('SELECT * FROM sources ORDER BY created_at DESC').all()));
app.post('/api/sources',(req,res)=>{
  const {name,url,type}=req.body;
  try { res.json({success:true,id:db.prepare('INSERT INTO sources(name,url,type) VALUES(?,?,?)').run(name,url,type||'rss').lastInsertRowid}); }
  catch(e){res.status(400).json({error:e.message});}
});
app.delete('/api/sources/:id',(req,res)=>{db.prepare('DELETE FROM sources WHERE id=?').run(req.params.id);res.json({success:true});});
app.patch('/api/sources/:id/toggle',(req,res)=>{
  const s=db.prepare('SELECT active FROM sources WHERE id=?').get(req.params.id);
  db.prepare('UPDATE sources SET active=? WHERE id=?').run(s.active?0:1,req.params.id);
  res.json({success:true});
});

app.get('/api/posts',(req,res)=>res.json(db.prepare('SELECT p.*,s.name source_name FROM posts p LEFT JOIN sources s ON p.source_id=s.id ORDER BY p.created_at DESC LIMIT 50').all()));
app.post('/api/posts/:id/publish',async(req,res)=>{
  const post=db.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id);
  if(!post) return res.status(404).json({error:'Not found'});
  try{res.json({success:true,logs:await publishPost(post)});}catch(e){res.status(500).json({error:e.message});}
});
app.delete('/api/posts/:id',(req,res)=>{db.prepare('DELETE FROM posts WHERE id=?').run(req.params.id);res.json({success:true});});

app.get('/api/logs',(req,res)=>res.json(db.prepare('SELECT l.*,p.original_title FROM publish_log l LEFT JOIN posts p ON l.post_id=p.id ORDER BY l.published_at DESC LIMIT 100').all()));

app.get('/api/settings',(req,res)=>{
  const rows=db.prepare('SELECT key,value FROM settings').all();
  const s={};
  rows.forEach(r=>{s[r.key]=r.key.match(/key|token|secret|password/)?( r.value?'***':''):r.value;});
  res.json(s);
});
app.post('/api/settings/bulk',(req,res)=>{Object.entries(req.body).forEach(([k,v])=>setSetting(k,v));res.json({success:true});});

app.post('/api/telegram/channel/fetch',async(req,res)=>{
  const {channel}=req.body; if(!channel) return res.status(400).json({error:'Channel required'});
  res.json(await readTelegramChannel(channel));
});

app.post('/api/telegram/channel/test-post',async(req,res)=>{
  const {channel}=req.body;
  const tgToken=getSetting('telegram_token'), tgChat=getSetting('telegram_chat');
  if(!tgToken||!tgChat) return res.status(400).json({error:'Bot token and chat not configured'});
  const r=await readTelegramChannel(channel);
  if(!r.success||!r.posts.length) return res.json({success:false,message:r.message||'No posts found'});
  const testMsg='📢 آخر رسالة من @'+channel.replace('@','')+' :\n\n'+r.posts[0].text.substring(0,300);
  try {
    await axios.post(`https://api.telegram.org/bot${tgToken}/sendMessage`,{chat_id:tgChat,text:testMsg,parse_mode:'HTML'});
    res.json({success:true,message:'Sent!'});
  } catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/tg/refresh-schedules',(req,res)=>{
  setupTGSchedules();
  res.json({success:true,active:Object.keys(tgIntervals).length,channels:Object.keys(tgIntervals)});
});

app.get('/api/tg/schedules-status',(req,res)=>{
  const sources=db.prepare("SELECT * FROM sources WHERE type='telegram' AND active=1").all();
  res.json({success:true,schedules:sources.map(s=>{
    const ch=s.url.replace('https://t.me/s/','');
    return {channel:ch,interval:getSetting('tg_interval_'+ch,'5'),publishTo:getSetting('tg_publish_to_'+ch,''),active:!!tgIntervals[ch]};
  })});
});

app.post('/api/tg/rules',async(req,res)=>{
  const {channel,mode,keywords,ignore}=req.body;
  if(!channel) return res.status(400).json({error:'channel required'});
  setSetting('tg_rules_'+channel,JSON.stringify({mode:mode||'rewrite',keywords:keywords||'',ignore:ignore||''}));
  res.json({success:true});
});

app.get('/api/tg/rules/:channel',(req,res)=>{
  res.json({success:true,rules:JSON.parse(getSetting('tg_rules_'+req.params.channel,'{"mode":"rewrite","keywords":"","ignore":""}'))});
});

app.post('/api/youtube/analyze',async(req,res)=>{
  const {url}=req.body; if(!url) return res.status(400).json({error:'URL required'});
  const videoId=url.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/)?.[1];
  if(!videoId) return res.status(400).json({error:'Invalid YouTube URL'});
  let title='YouTube Video',ch='YouTube',desc='';
  try{const oe=await axios.get('https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v='+videoId+'&format=json');title=oe.data.title;ch=oe.data.author_name;}catch(e){}
  const myLink=(()=>{try{const mc=JSON.parse(getSetting('my_tg_channels','[]'));if(mc.length)return '\n\n📢 @'+mc[0].chat.replace('@','');}catch(e){}return '';})();
  const prompt=`حلّل عنوان هذا الفيديو وأنتج:\n[TELEGRAM]\nتحليل إخباري احترافي 200 كلمة بالعربية - لا تذكر القناة أو روابط\n[/TELEGRAM]\n[FACEBOOK]\nمنشور جذاب 100 كلمة - اختم بسؤال - لا تذكر روابط\n[/FACEBOOK]\n\nعنوان: "${title}" | القناة: ${ch}`;
  try{
    const result=await callAI(prompt,1200);
    const extract=tag=>{const m=result.match(new RegExp('\\['+tag+'\\]([\\s\\S]*?)\\[/'+tag+'\\]','i'));return m?m[1].trim().replace(/https?:\/\/\S+/g,'').trim():'';};
    res.json({success:true,videoId,title,channelName:ch,thumbnail:`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,telegram:extract('TELEGRAM')+myLink,facebook:extract('FACEBOOK')});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/youtube/publish',async(req,res)=>{
  const {videoId,thumbnail,title,tgText,fbText,publishTo}=req.body;
  const tgToken=getSetting('telegram_token'),tgChat=getSetting('telegram_chat'),webhook=getSetting('make_webhook');
  const published=[];
  if(publishTo&&publishTo.includes('telegram')&&tgToken&&tgChat&&tgText){
    try{
      try{await axios.post(`https://api.telegram.org/bot${tgToken}/sendPhoto`,{chat_id:tgChat,photo:thumbnail||`https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,caption:title||''});}catch(e){}
      await axios.post(`https://api.telegram.org/bot${tgToken}/sendMessage`,{chat_id:tgChat,text:tgText,parse_mode:'HTML'});
      published.push('telegram');
    }catch(e){console.error('YT TG:',e.message);}
  }
  if(publishTo&&publishTo.includes('facebook')&&webhook&&fbText){
    try{await axios.post(webhook,{content:fbText,platform:'facebook',timestamp:new Date().toISOString()});published.push('facebook');}catch(e){}
  }
  res.json({success:published.length>0,published});
});

app.get('/api/fb/sources',(req,res)=>{
  const all=db.prepare('SELECT * FROM sources WHERE active=1').all();
  const selected=db.prepare("SELECT value FROM settings WHERE key LIKE 'fb_source_%'").all().map(r=>parseInt(r.value));
  const intervals={};
  db.prepare("SELECT key,value FROM settings WHERE key LIKE 'fb_interval_%'").all().forEach(r=>{intervals[r.key.replace('fb_interval_','')]=r.value;});
  res.json({all,selected,intervals});
});

app.post('/api/fb/sources',(req,res)=>{
  const {sourceIds,intervals}=req.body;
  db.prepare("DELETE FROM settings WHERE key LIKE 'fb_source_%'").run();
  if(sourceIds&&sourceIds.length){
    sourceIds.forEach((id,i)=>{
      db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('fb_source_'+i,String(id));
      if(intervals&&intervals[id]) db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('fb_interval_'+id,String(intervals[id]));
    });
  }
  setupFBSchedules();
  res.json({success:true,count:sourceIds?sourceIds.length:0});
});

app.post('/api/fb/test',async(req,res)=>{
  const webhook=getSetting('make_webhook');
  if(!webhook) return res.status(400).json({error:'Make.com webhook not configured'});
  try{await axios.post(webhook,{content:'اختبار الربط مع فيسبوك - '+new Date().toLocaleString('ar'),platform:'facebook',timestamp:new Date().toISOString()});res.json({success:true});}
  catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/test/telegram',async(req,res)=>{
  const {token,chat}=req.body;
  try{
    const r=await axios.get(`https://api.telegram.org/bot${token}/getMe`);
    if(r.data.ok){setSetting('telegram_token',token);if(chat)setSetting('telegram_chat',chat);res.json({success:true,username:r.data.result.username});}
    else res.status(400).json({error:r.data.description});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/test/facebook',async(req,res)=>{
  const {pageToken,pageId}=req.body;
  try{
    const r=await axios.get(`https://graph.facebook.com/v19.0/me?access_token=${pageToken}`);
    if(r.data.id){setSetting('facebook_page_token',pageToken);if(pageId)setSetting('facebook_page_id',pageId);res.json({success:true,name:r.data.name});}
    else res.status(400).json({error:'Invalid token'});
  }catch(e){res.status(500).json({error:e.response?.data?.error?.message||e.message});}
});

app.post('/api/test/ai',async(req,res)=>{
  const {key,provider}=req.body;
  try{
    if(provider==='openai') setSetting('openai_key',key);
    else if(provider==='gemini') setSetting('gemini_key',key);
    else if(provider==='groq') setSetting('groq_key',key);
    else setSetting('claude_key',key);
    setSetting('ai_provider',provider);
    const result=await callAI('Say OK',10);
    res.json({success:true,message:result,provider});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/test/github',async(req,res)=>{
  const {token,repo}=req.body;
  try{
    const r=await axios.get(`https://api.github.com/repos/${repo}`,{headers:{Authorization:'Bearer '+token}});
    setSetting('github_token',token);setSetting('github_repo',repo);
    res.json({success:true,name:r.data.full_name});
  }catch(e){res.status(400).json({error:e.response?.data?.message||e.message});}
});

app.get('/api/version',(req,res)=>res.json({version:getSetting('app_version','1.0.0'),lastUpdate:getSetting('last_update',''),updateNotes:getSetting('update_notes',''),updateSeen:getSetting('update_seen','1')}));
app.post('/api/version/seen',(req,res)=>{setSetting('update_seen','1');res.json({success:true});});

app.post('/api/run-now',(req,res)=>{res.json({message:'Started'});dailyCycle().catch(console.error);});

app.get('/',(req,res)=>{
  const paths=[path.join(__dirname,'public','index.html'),path.join(__dirname,'index.html')];
  for(const p of paths){if(fs.existsSync(p)) return res.sendFile(p);}
  res.send('<h2>Server running</h2>');
});

// ===== Schedules =====
const checkTime = getSetting('check_time','08:00');
cron.schedule(`${checkTime.split(':')[1]||0} ${checkTime.split(':')[0]||8} * * *`,dailyCycle,{timezone:'Asia/Riyadh'});

// Boot
setTimeout(setupTGSchedules, 3000);
setTimeout(setupFBSchedules, 5000);
setInterval(()=>{ setupTGSchedules(); },60*60*1000);

// Keep-alive
const RAILWAY_URL = process.env.RAILWAY_URL||'';
if(RAILWAY_URL){
  setInterval(async()=>{
    try{await axios.get(RAILWAY_URL+'/api/ping',{timeout:10000});}catch(e){}
  },4*60*1000);
  console.log('Keep-alive enabled');
}

const PORT = process.env.PORT||3000;
app.listen(PORT,()=>console.log('Server on port',PORT,'| DB:',DB_FILE));
