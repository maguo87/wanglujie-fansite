// Service Worker — 忙鱼の橹杰收藏馆
var CACHE_NAME = 'wlj-v2';
var urlsToCache = [
  '/',
  '/index.html',
  '/forum.html',
  '/manifest.json',
  '/hero.jpg',
  '/profile.jpg',
  '/hitchcock.jpg',
  '/work0.jpg',
  '/work1.jpg',
  '/work2.jpg',
  '/work3.jpg',
  '/work4.jpg',
  '/work5.jpg',
  '/work6.jpg',
  '/work7.jpg',
  '/work8.jpg',
  '/work9.jpg',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css'
];

// 安装：预缓存核心文件
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(urlsToCache).catch(function() {});
    })
  );
  self.skipWaiting();
});

// 激活：清理旧缓存
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE_NAME; }).map(function(k) {
        return caches.delete(k);
      }));
    })
  );
  self.clients.claim();
});

// 请求拦截：缓存优先（静态资源），网络优先（API）
self.addEventListener('fetch', function(event) {
  var url = new URL(event.request.url);

  // API 请求走网络
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then(function(cached) {
      return cached || fetch(event.request).then(function(response) {
        if (response.ok && response.type === 'basic') {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(function() {
        // 离线回退
        if (event.request.headers.get('accept').indexOf('text/html') !== -1) {
          return caches.match('/index.html');
        }
        return new Response('离线中，请联网后重试', { status: 503 });
      });
    })
  );
});
