const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const sanitizeHtml = require('sanitize-html');
const multer = require('multer');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'wanglujie-lumos-2026-secret-key';
const TOKEN_EXPIRE = '7d';
const DATA_FILE = path.join(__dirname, 'data.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// 确保 uploads 目录存在
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// --- 敏感词列表 ---
const BAD_WORDS = ['广告', '加微信', '加V', '免费领取', '赚钱', '兼职', '代购', '微商', '引流', 'fuck', 'shit', '傻逼', '妈的', '操你', 'sb', 'cnm'];

// --- 数据读写 (内存缓存 + 异步批量写入，解决同步IO卡顿) ---
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) { console.error('读取数据失败:', e.message); }
  return { users: [], comments: [], posts: [], nextUserId: 1, nextCommentId: 1, nextPostId: 1 };
}

var saveTimer = null;

// 异步延迟写入：500ms 内的多次修改合并为一次磁盘写入，避免频繁IO阻塞
function saveData() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(function() {
    fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2), 'utf8', function(err) {
      if (err) console.error('保存数据失败:', err.message);
    });
  }, 500);
}

// 立即同步写入（进程退出时使用）
function saveDataSync() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8'); } catch(e) {}
}

function getNow() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
}

// --- 初始化 + 种子数据 ---
var db = loadData();

// 数据迁移：补缺失字段
var migrated = false;
if (!db.posts) { db.posts = []; db.nextPostId = 1; migrated = true; }
db.comments.forEach(function(c) {
  if (c.post_id === undefined) { c.post_id = null; migrated = true; }
});
if (migrated) saveData();

// 种子数据
if (db.comments.length === 0 && db.posts.length === 0) {
  var hash = bcrypt.hashSync('mangyu520', 10);
  db.users.push({ id: 1, username: '忙鱼', password: hash, created_at: '2025-12-06 20:30' });
  db.nextUserId = 2;
  var presets = [
    ['忙鱼', '橹橹！从2025年12月6日入坑到现在，每一天都被你治愈着。《希区考克》的舞台我看了无数遍，每次都会心动。会一直做你的Lumos，陪你走下去！💚✨', '2025-12-06 20:30'],
    ['橹橹的小星星', '从你公开第一天就喜欢你了，会一直陪你走下去！🌟', null],
    ['Lumos永远', 'Lumos永远为橹杰照亮前方的路 ✨', null],
    ['碧玉守护者', '每一次舞台都让人惊艳，未来可期！', null],
    ['成都老乡', '同为成都人为你骄傲！彝族少年加油 💚', null],
  ];
  presets.forEach(function(item, i) {
    if (i === 0) {
      db.comments.push({ id: 1, post_id: null, user_id: 1, username: item[0], content: item[1], created_at: item[2] });
      db.nextCommentId = 2;
    } else {
      var uid = db.nextUserId++;
      db.users.push({ id: uid, username: item[0], password: bcrypt.hashSync(item[0] + '123', 10), created_at: getNow() });
      db.comments.push({ id: db.nextCommentId++, post_id: null, user_id: uid, username: item[0], content: item[1], created_at: getNow() });
    }
  });
  saveDataSync();
  console.log('种子数据已初始化');
}

// --- 工具函数 ---
function checkBadWords(text) {
  var lower = text.toLowerCase();
  for (var i = 0; i < BAD_WORDS.length; i++) {
    if (lower.indexOf(BAD_WORDS[i]) !== -1) return BAD_WORDS[i];
  }
  return null;
}

function cleanHtml(text) {
  return sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} });
}

function validateUsername(name) {
  if (!name || name.length < 2 || name.length > 12) return '昵称2-12个字符';
  if (!/^[一-龥a-zA-Z0-9_]+$/.test(name)) return '昵称只能包含中文/英文/数字/下划线';
  return null;
}

// --- Multer 图片上传配置 ---
var storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: function(req, file, cb) {
    var ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomBytes(8).toString('hex') + ext);
  }
});

var upload = multer({
  storage: storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: function(req, file, cb) {
    var allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    var ext = path.extname(file.originalname).toLowerCase();
    if (allowed.indexOf(ext) === -1) {
      return cb(new Error('仅支持 jpg/png/gif/webp 格式'));
    }
    cb(null, true);
  }
});

// --- 中间件 ---
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname)));

// 全局限流
var globalLimiter = rateLimit({ windowMs: 60 * 1000, max: 200, message: { error: '请求太频繁' } });
app.use('/api', globalLimiter);

// 登录/注册限流
var authLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, message: { error: '操作太频繁，请稍后重试' } });

// 发帖限流
var postLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 3, message: { error: '发帖太频繁，5分钟后再试' } });

// 评论限流
var commentLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, message: { error: '评论太频繁，请稍后再试' } });

// 上传限流
var uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, message: { error: '上传太频繁，请稍后再试' } });

// JWT 认证
function auth(req, res, next) {
  var h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: '请先登录' });
  try { req.user = jwt.verify(h.split(' ')[1], JWT_SECRET); next(); }
  catch (e) { return res.status(401).json({ error: '登录已过期，请重新登录' }); }
}

// ==============================
//  用户 API（不变）
// ==============================

app.post('/api/register', authLimiter, function(req, res) {
  var username = (req.body.username || '').trim();
  var password = req.body.password || '';
  var valErr = validateUsername(username);
  if (valErr) return res.status(400).json({ error: valErr });
  if (password.length < 6 || password.length > 20) return res.status(400).json({ error: '密码6-20位' });

  // db 已在内存缓存中，无需重复读取
  if (db.users.some(function(u) { return u.username === username; })) {
    return res.status(409).json({ error: '该昵称已被注册' });
  }

  db.users.push({ id: db.nextUserId, username: username, password: bcrypt.hashSync(password, 10), created_at: getNow() });
  var token = jwt.sign({ id: db.nextUserId, username: username }, JWT_SECRET, { expiresIn: TOKEN_EXPIRE });
  db.nextUserId++;
  saveData();
  res.json({ token: token, user: { id: db.nextUserId - 1, username: username } });
});

app.post('/api/login', authLimiter, function(req, res) {
  var username = (req.body.username || '').trim();
  var password = req.body.password || '';
  // db 已在内存缓存中，无需重复读取
  var user = db.users.find(function(u) { return u.username === username; });
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: '昵称或密码错误' });
  }
  var token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: TOKEN_EXPIRE });
  res.json({ token: token, user: { id: user.id, username: user.username } });
});

// ==============================
//  留言板 API（不变）
// ==============================

app.get('/api/comments', function(req, res) {
  // db 已在内存缓存中，无需重复读取
  var comments = db.comments.filter(function(c) { return !c.post_id; })
    .sort(function(a, b) { return b.created_at.localeCompare(a.created_at); }).slice(0, 100);
  res.json(comments);
});

app.post('/api/comments', auth, commentLimiter, function(req, res) {
  var content = (req.body.content || '').trim();
  var cleaned = cleanHtml(content);
  if (!cleaned) return res.status(400).json({ error: '留言不能为空' });
  if (cleaned.length > 200) return res.status(400).json({ error: '留言最多200字' });
  var bad = checkBadWords(cleaned);
  if (bad) return res.status(400).json({ error: '内容包含不当词汇' });

  // db 已在内存缓存中，无需重复读取
  db.comments.push({ id: db.nextCommentId, post_id: null, user_id: req.user.id, username: req.user.username, content: cleaned, created_at: getNow() });
  db.nextCommentId++;
  saveData();
  broadcast({ type: 'new_comment', comment: db.comments[db.comments.length - 1] });
  res.json(db.comments[db.comments.length - 1]);
});

// ==============================
//  论坛帖子 API
// ==============================

// 帖子列表
app.get('/api/posts', function(req, res) {
  // db 已在内存缓存中，无需重复读取
  var page = parseInt(req.query.page) || 1;
  var perPage = 20;
  var posts = db.posts.slice().sort(function(a, b) { return b.created_at.localeCompare(a.created_at); });
  var total = posts.length;
  posts = posts.slice((page - 1) * perPage, page * perPage);
  res.json({ posts: posts, total: total, page: page, hasMore: page * perPage < total });
});

// 帖子详情
app.get('/api/posts/:id', function(req, res) {
  // db 已在内存缓存中，无需重复读取
  var post = db.posts.find(function(p) { return p.id === parseInt(req.params.id); });
  if (!post) return res.status(404).json({ error: '帖子不存在' });
  var comments = db.comments.filter(function(c) { return c.post_id === post.id; })
    .sort(function(a, b) { return a.created_at.localeCompare(b.created_at); });
  res.json({ post: post, comments: comments });
});

// 发帖
app.post('/api/posts', auth, postLimiter, function(req, res) {
  var title = (req.body.title || '').trim();
  var content = (req.body.content || '').trim();
  var images = req.body.images || [];

  title = cleanHtml(title);
  content = cleanHtml(content);

  if (!title) return res.status(400).json({ error: '标题不能为空' });
  if (title.length > 30) return res.status(400).json({ error: '标题最多30字' });
  if (!content) return res.status(400).json({ error: '内容不能为空' });
  if (content.length > 500) return res.status(400).json({ error: '内容最多500字' });
  if (!Array.isArray(images) || images.length > 3) return res.status(400).json({ error: '最多3张图片' });

  var bad = checkBadWords(title) || checkBadWords(content);
  if (bad) return res.status(400).json({ error: '内容包含不当词汇' });

  // 验证图片确实存在于 uploads 目录
  images = images.filter(function(f) {
    return typeof f === 'string' && f.length < 100 && fs.existsSync(path.join(UPLOAD_DIR, f));
  });

  // db 已在内存缓存中，无需重复读取
  var post = {
    id: db.nextPostId++, user_id: req.user.id, username: req.user.username,
    title: title, content: content, images: images, comment_count: 0,
    created_at: getNow()
  };
  db.posts.push(post);
  saveData();
  broadcast({ type: 'new_post', post: post });
  res.json(post);
});

// 删帖
app.delete('/api/posts/:id', auth, function(req, res) {
  // db 已在内存缓存中，无需重复读取
  var idx = db.posts.findIndex(function(p) { return p.id === parseInt(req.params.id); });
  if (idx === -1) return res.status(404).json({ error: '帖子不存在' });
  if (db.posts[idx].user_id !== req.user.id) return res.status(403).json({ error: '只能删除自己的帖子' });

  var post = db.posts[idx];
  // 删除关联图片
  (post.images || []).forEach(function(f) {
    var p = path.join(UPLOAD_DIR, f);
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
  });
  // 删除关联评论
  db.comments = db.comments.filter(function(c) { return c.post_id !== post.id; });
  db.posts.splice(idx, 1);
  saveData();
  res.json({ ok: true });
});

// 帖子评论
app.post('/api/posts/:id/comments', auth, commentLimiter, function(req, res) {
  var content = (req.body.content || '').trim();
  var cleaned = cleanHtml(content);
  if (!cleaned) return res.status(400).json({ error: '评论不能为空' });
  if (cleaned.length > 200) return res.status(400).json({ error: '评论最多200字' });
  var bad = checkBadWords(cleaned);
  if (bad) return res.status(400).json({ error: '内容包含不当词汇' });

  // db 已在内存缓存中，无需重复读取
  var pid = parseInt(req.params.id);
  var postIdx = db.posts.findIndex(function(p) { return p.id === pid; });
  if (postIdx === -1) return res.status(404).json({ error: '帖子不存在' });

  var comment = { id: db.nextCommentId++, post_id: pid, user_id: req.user.id, username: req.user.username, content: cleaned, created_at: getNow() };
  db.comments.push(comment);
  db.posts[postIdx].comment_count = (db.posts[postIdx].comment_count || 0) + 1;
  saveData();
  broadcast({ type: 'new_post_comment', comment: comment, postId: pid });
  res.json(comment);
});

// 删除评论
app.delete('/api/posts/:id/comments/:cid', auth, function(req, res) {
  // db 已在内存缓存中，无需重复读取
  var cid = parseInt(req.params.cid);
  var pid = parseInt(req.params.id);
  var cIdx = db.comments.findIndex(function(c) { return c.id === cid && c.post_id === pid; });
  if (cIdx === -1) return res.status(404).json({ error: '评论不存在' });
  if (db.comments[cIdx].user_id !== req.user.id) return res.status(403).json({ error: '只能删除自己的评论' });
  db.comments.splice(cIdx, 1);
  var postIdx = db.posts.findIndex(function(p) { return p.id === pid; });
  if (postIdx !== -1) db.posts[postIdx].comment_count = Math.max(0, (db.posts[postIdx].comment_count || 1) - 1);
  saveData();
  res.json({ ok: true });
});

// ==============================
//  图片上传 API
// ==============================

app.post('/api/upload', auth, uploadLimiter, function(req, res) {
  upload.single('image')(req, res, function(err) {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: '图片不能超过2MB' });
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: '请选择图片' });
    res.json({ filename: req.file.filename });
  });
});

// ==============================
//  统一 SSE 推送
// ==============================

var sseClients = new Set();

app.get('/api/events', function(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*'
  });
  res.write('data: {"type":"connected"}\n\n');
  sseClients.add(res);
  req.on('close', function() { sseClients.delete(res); });
});

// 留言板 SSE（兼容旧前端）
app.get('/api/comments/stream', function(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*'
  });
  res.write('data: {"type":"connected"}\n\n');
  sseClients.add(res);
  req.on('close', function() { sseClients.delete(res); });
});

function broadcast(data) {
  var msg = 'data: ' + JSON.stringify(data) + '\n\n';
  sseClients.forEach(function(c) { try { c.write(msg); } catch (e) { sseClients.delete(c); } });
}

setInterval(function() { broadcast({ type: 'ping' }); }, 30000);

// --- 进程退出时确保数据落盘 ---
process.on('SIGINT', function() { saveDataSync(); process.exit(0); });
process.on('SIGTERM', function() { saveDataSync(); process.exit(0); });
process.on('beforeExit', function() { saveDataSync(); });

// --- 启动 ---
app.listen(PORT, function() {
  console.log('Server: http://localhost:' + PORT);
});
