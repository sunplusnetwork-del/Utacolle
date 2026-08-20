/*
 * 合唱曲コレクション - Service Worker
 *
 * 役割:
 *  - アプリの「殻」(HTML/CSS/JS)をキャッシュし、オフラインでも起動できるようにする
 *  - 曲データそのものはIndexedDBに保存されているため、このSWはキャッシュしない
 *
 * 使い方:
 *  1. このファイルを index.html と同じ階層(サイトのルート)に置く
 *  2. index.html の <script> 内で以下のように登録する:
 *
 *     if ('serviceWorker' in navigator) {
 *       window.addEventListener('load', () => {
 *         navigator.serviceWorker.register('./service-worker.js');
 *       });
 *     }
 *
 *  3. APP_SHELL_FILES を実際のビルド出力のファイル名に合わせて書き換える
 *     (このリストが正しくないと、キャッシュに失敗してオフライン起動できません)
 *
 * 注意: このファイルは実際のWebサーバー(GitHub Pages等、https経由)に配置して
 * 初めて動作します。Claudeのプレビュー内では有効化されません。
 */

const CACHE_VERSION = 'chorusdb-v3';

// 実際のビルド出力に合わせて書き換えてください
const APP_SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// 基本方針: ネットワーク優先(オンライン時は常に最新のファイルを取得してキャッシュを更新する)。
// オフラインでfetchが失敗した場合のみキャッシュを使い、それも無ければindex.htmlへフォールバックする。
// (以前は「キャッシュ優先」だったため、一度訪問した端末は新しいビルドを配信し直しても
//  ずっと古いキャッシュのまま表示され続けるという不具合があった)
// なお、ページ本体(index.html)へのアクセスは cache:'no-store' を指定し、ブラウザ自体のHTTP
// キャッシュも経由させない。ここを素通りさせないと、ホスティング側のキャッシュ設定次第では
// SWが「ネットワークから取得したつもり」でも実際には古いHTTPキャッシュが返ってきてしまうため。
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const isNavigation = event.request.mode === 'navigate' || event.request.destination === 'document';

  event.respondWith(
    fetch(event.request, isNavigation ? { cache: 'no-store' } : {})
      .then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => cached || caches.match('./index.html'))
      )
  );
});
