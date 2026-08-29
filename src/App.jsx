import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Papa from 'papaparse';
import jsQR from 'jsqr';
import appIconUrl from './assets/app-icon.png';
import bannerUrl from './assets/banner.png';
import wordmarkUrl from './assets/wordmark.png';
import {
  Music2, Plus, Search, Users, Share2, Copy, Trash2, Pencil, Shuffle,
  X, Check, UserPlus, UserMinus, ExternalLink, Sparkles, ChevronLeft, ChevronRight, ChevronUp,
  User, ChevronDown, Loader2, Ticket, BookOpen, Eye, EyeOff, Film, FileText, QrCode,
  Radar, MapPin, Bell, Ban, Flag, ShieldCheck, Lock, Camera, VolumeX, GripVertical, Gift,
} from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  定数・データ層                                                     */
/* ------------------------------------------------------------------ */

const STORAGE_KEY = 'app-data';   // 全データ(曲・ユーザー)をまとめて保存するキー
const SESSION_KEY = 'session';    // この端末でどのプロフィールを使っているか

/* ---- 広告表示ゲート ----
   曲の新規登録: アカウント作成から7日間は広告なし。8日目以降は、登録1・6・11・16・21回目...
   (通算の新規登録回数が5件おきの節目)の直前に短い広告(15秒)を挟む。ただし1日に5回広告を見た
   後は、その日はもう広告を挟まない。
   CSV一括登録は上記のルールと関係なく、毎回アップロード前に30秒の広告を挟む。
   広告本体はGoogle Publisher Tag(GPT)のテスト用ユニットを使用(AdGateModal参照)。 */
const AD_SONG_COUNT_KEY = 'chorusdb:song-reg-count'; // 通算の新規曲登録回数
const AD_DAILY_VIEWS_KEY = 'chorusdb:ad-daily-views'; // { date: 'YYYY-MM-DD', count } その日に見た広告数
const AD_FREE_DAYS = 7;
const AD_DAILY_CAP = 5;
const AD_CADENCE = 5; // 1, 6, 11, 16, 21... の間隔

async function bumpSongRegistrationCount() {
  const current = (await idbGet(AD_SONG_COUNT_KEY)) || 0;
  const next = current + 1;
  await idbSet(AD_SONG_COUNT_KEY, next);
  return next;
}
function isAdDueForCount(count) {
  return count >= 1 && (count - 1) % AD_CADENCE === 0;
}
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
async function getTodayAdViewCount() {
  const rec = await idbGet(AD_DAILY_VIEWS_KEY);
  return rec && rec.date === todayStr() ? (rec.count || 0) : 0;
}
async function bumpTodayAdViewCount() {
  const rec = await idbGet(AD_DAILY_VIEWS_KEY);
  const count = (rec && rec.date === todayStr() ? rec.count : 0) + 1;
  await idbSet(AD_DAILY_VIEWS_KEY, { date: todayStr(), count });
  return count;
}

// テーマ変更: 1回目は無料、2回目以降は毎回短い広告(10秒)を挟む。曲登録の広告カウントとは別管理。
const THEME_CHANGE_COUNT_KEY = 'chorusdb:theme-change-count';
async function bumpThemeChangeCount() {
  const current = (await idbGet(THEME_CHANGE_COUNT_KEY)) || 0;
  const next = current + 1;
  await idbSet(THEME_CHANGE_COUNT_KEY, next);
  return next;
}

/* ---- IndexedDBストレージ層 ----
   Claude環境専用のwindow.storageではなく、ブラウザ標準のIndexedDBを直接使用。
   将来このコードをそのまま自分のサーバー/GitHub Pages等へ持ち出しても動作する。
   IndexedDBが使えない場合(プライベートブラウジング等)はlocalStorageに自動フォールバック。 */

const IDB_NAME = 'chorusdb';
const IDB_VERSION = 1;
const IDB_STORE = 'kv';

function openIdb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('IndexedDB is not available')); return; }
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  try {
    const db = await openIdb();
    const value = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (value !== undefined) return value;
  } catch (e) {
    console.warn('IndexedDBから読み込めなかったため、localStorageを確認します', e);
  }
  try {
    const raw = localStorage.getItem(`chorusdb:${key}`);
    return raw ? JSON.parse(raw) : undefined;
  } catch (e) {
    return undefined;
  }
}

async function idbSet(key, value) {
  let ok = false;
  try {
    const db = await openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const req = tx.objectStore(IDB_STORE).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    ok = true;
  } catch (e) {
    console.warn('IndexedDBへの書き込みに失敗したため、localStorageへ保存します', e);
  }
  try {
    localStorage.setItem(`chorusdb:${key}`, JSON.stringify(value));
  } catch (e) {
    /* 保存先が全く無い場合はあきらめる(プロトタイプにつき致命的ではない) */
  }
  return ok;
}

/* ---- Googleログイン & Driveデータ同期層 ----
   ログインは任意。ログインしない場合は従来通りIndexedDBのみで完結する。
   ログインした場合は、ユーザー本人のGoogleドライブ内「アプリ専用の隠し領域(appDataFolder)」
   にJSONファイル(1個)としてデータを保存する。この領域は本人にもGoogleドライブの画面上には
   表示されず、他のアプリやユーザーからもアクセスできない、このアプリ専用の保存場所。
   曲やプロフィールの「共有」は、これまで通りQRコード/URLへのデータ埋め込みのみで行うため、
   Googleドライブの共有設定は一切関与しない。

   利用にはユーザー自身のGoogle Cloud ConsoleでOAuthクライアントID(ウェブアプリケーション用)を
   発行し、下記GOOGLE_CLIENT_IDに設定する必要がある(詳細はDEPLOY.md参照)。 */

const GOOGLE_CLIENT_ID = '293915239537-nrniurq3gju1kthbhhh2gfu5fobhtlsc.apps.googleusercontent.com';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file';
const DRIVE_FILE_NAME = 'chorus-data.json';

// 曲の一括共有(Googleドライブ経由)に使うAPIキー。OAuthクライアントIDとは別に、
// Google Cloud Console → APIとサービス → 認証情報 → 「認証情報を作成」→「APIキー」で発行する。
// (公開されたドライブファイルをログインなしの相手でも読み込めるようにするために必要。
//  セキュリティのため、発行したAPIキーは「APIの制限」でGoogle Drive APIのみに絞ることを推奨)
const GOOGLE_API_KEY = 'AIzaSyDMXiZaQZyZcZ3MZh6m00naV1TZXHenouM';

if (typeof window !== 'undefined') {
  if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.startsWith('YOUR_GOOGLE_OAUTH_CLIENT_ID')) {
    console.warn(
      '[うたコレ] GOOGLE_CLIENT_ID が未設定のままです(src/App.jsx 96行目付近)。'
      + 'このままだと「Googleでログイン」ボタンは表示されません。'
      + 'Google Cloud ConsoleでOAuthクライアントIDを取得し、GOOGLE_CLIENT_ID に設定した上で、'
      + '必ず npm run build → 再デプロイ してください。'
    );
  } else if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(GOOGLE_CLIENT_ID.trim())) {
    console.warn(
      `[うたコレ] GOOGLE_CLIENT_ID の形式が想定と異なります: "${GOOGLE_CLIENT_ID}"。`
      + '"xxxxxxxx.apps.googleusercontent.com" の形式になっているか確認してください。'
    );
  }
  if (!GOOGLE_API_KEY || GOOGLE_API_KEY.startsWith('YOUR_GOOGLE_API_KEY')) {
    console.warn(
      '[うたコレ] GOOGLE_API_KEY が未設定です。Googleドライブ経由の大量共有機能は使えません'
      + '(ログイン自体・appDataFolderへの個人保存には影響ありません)。'
    );
  }
}
const GOOGLE_SIGNED_IN_FLAG = 'chorusdb:google-was-signed-in'; // 次回起動時に自動で再ログインを試みるための目印(トークン自体は保存しない)
const LAST_SEEN_CHANGELOG_KEY = 'chorusdb:last-seen-changelog'; // 「お知らせ」を最後に見たバージョン(端末ごとに保存)

/* ---- お知らせ(更新履歴) ----
   新しい変更があったら、この配列の先頭に追加していく。versionは日付(YYYY-MM-DD)でよい。
   起動時、前回このお知らせを見た時より新しい項目があれば、自動でポップアップ表示する。
   マイページの「お知らせ」からは、いつでも全履歴を見返せる。 */
const CHANGELOG = [
  {
    version: '2026-08-28',
    items: [
      'スターターパックVol.1に、実際の合唱曲100曲を追加しました。ぜひ開封してみてください！',
    ],
  },
  {
    version: '2026-08-26',
    items: [
      '新機能「スターターパック」を追加しました。コレクションタブの隣から、あらかじめ用意された曲セットの中からランダムで10曲を、ガチャのような演出付きで引けます(1パックにつき24時間に1回)',
    ],
  },
  {
    version: '2026-08-23',
    items: [
      'スマホでアプリを開くたびにポップアップの許可を毎回聞かれる問題について、別の原因(起動時の自動再ログイン処理)を見つけて対応しました',
      '車のモニターの表示について、前回の対策が逆効果だったため、以前の(うたコレの情報がほとんどの場合正しく表示されていた)方式に戻しました',
      '詳細フィルタの作詩・作曲欄で、何も入力しなくても、登録済みの名前一覧をプルダウンから選べるようにしました',
      '詳細フィルタの作詩・作曲欄で、登録済みの名前をプルダウンから選べるようにしました(最近使ったもの・よく使うものが上位に表示されます)',
      '車のモニターで、たまにうたコレの登録内容ではなくYouTube側の動画タイトル・投稿者名が表示されてしまうことがある問題への対策をしました',
      'コレクション一覧で、下にスクロールして曲を追加読み込みする際、まれに読み込みが止まってしまうことがある不具合を修正しました',
      '曲の登録画面に「組曲タイトルのよみがな」欄を追加しました(組曲名での並び替え精度が上がります)',
      'スマホで曲を登録するときに、ポップアップの許可を毎回聞かれてしまう問題を直しました',
    ],
  },
  {
    version: '2026-08-21',
    items: [
      '曲の詳細画面から共有した時、その曲だけが選ばれた状態で共有できるようにしました',
      '動画のプレイリスト再生中は、スマホを振ってシャッフルする機能を自動的にオフにするようにしました',
      '共有用のURLを短くしました',
      '共有したリンクをX(旧Twitter)などのSNSに貼った時に、アプリの案内画像が表示されるようにしました',
      '曲の並び順に「歌った日が新しい順・古い順」を追加しました',
      '「組曲でまとめて表示する」機能で、絞り込み条件によって組曲の一部の曲しか表示されないことがある不具合を直しました',
      'ダークモードの試作テーマ(試作002)を追加し、見えにくかった文字色を修正しました',
      'Googleドライブ連携で、別の端末から同じアカウントでログインした時に、意図せず別のプロフィールが作られてしまう不具合を修正しました',
    ],
  },
  {
    version: '2026-08-18',
    items: [
      '車のBluetooth/CarPlayの「次へ」「前へ」ボタンで、プレイリストの再生を操作できるようにしました',
      '「スマホを振ってシャッフル」のオン・オフをマイページで設定できるようにしました',
      'YouTubeの動画情報から曲を登録する際の表記を分かりやすく整理しました',
    ],
  },
];

function getLatestChangelogVersion() {
  return CHANGELOG.length ? CHANGELOG[0].version : '';
}
function loadLastSeenChangelogVersion() {
  try { return localStorage.getItem(LAST_SEEN_CHANGELOG_KEY) || ''; } catch (e) { return ''; }
}
function saveLastSeenChangelogVersion(version) {
  try { localStorage.setItem(LAST_SEEN_CHANGELOG_KEY, version); } catch (e) { /* noop */ }
}

function driveAuthHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

async function driveFindFileId(token) {
  const params = new URLSearchParams({
    spaces: 'appDataFolder',
    q: `name='${DRIVE_FILE_NAME}' and trashed=false`,
    fields: 'files(id,modifiedTime)',
    pageSize: '1',
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    headers: driveAuthHeader(token),
  });
  if (!res.ok) throw new Error(`Driveの検索に失敗しました (${res.status})`);
  const json = await res.json();
  return json.files && json.files[0] ? json.files[0].id : null;
}

async function driveDownload(token, fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: driveAuthHeader(token),
  });
  if (!res.ok) throw new Error(`Driveからの読み込みに失敗しました (${res.status})`);
  return res.json();
}

async function driveDeleteFile(token, fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'DELETE',
    headers: driveAuthHeader(token),
  });
  if (!res.ok && res.status !== 404) throw new Error(`Driveのデータ削除に失敗しました (${res.status})`);
}

async function driveUpload(token, fileId, data) {
  const boundary = 'chorusdb_' + Math.random().toString(36).slice(2);
  const metadata = fileId ? {} : { name: DRIVE_FILE_NAME, parents: ['appDataFolder'] };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(data)}\r\n` +
    `--${boundary}--`;
  const url = fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
  const res = await fetch(url, {
    method: fileId ? 'PATCH' : 'POST',
    headers: { ...driveAuthHeader(token), 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Driveへの保存に失敗しました (${res.status})`);
  return res.json();
}

/* ---- 曲リストの大量共有(Googleドライブ経由) ----
   appDataFolder(隠し領域)とは別に、この機能専用の「通常のドライブファイル」を作成する。
   隠し領域のファイルは本人の同じアプリからしかアクセスできず、他人と共有する手段が無いため。
   作成したファイルには「リンクを知っている全員が閲覧可」の権限をアプリが自動で付与する
   (ユーザーがGoogleドライブの画面を開いて手動で共有設定をすることはない)。 */

async function driveCreatePublicJsonFile(token, filename, data) {
  const boundary = 'chorusdb_' + Math.random().toString(36).slice(2);
  const metadata = { name: filename }; // parentsを指定しないのでマイドライブ直下に作成される
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(data)}\r\n` +
    `--${boundary}--`;
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: { ...driveAuthHeader(token), 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`ドライブへのファイル作成に失敗しました (${res.status})`);
  const file = await res.json();

  const permRes = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}/permissions`, {
    method: 'POST',
    headers: { ...driveAuthHeader(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });
  if (!permRes.ok) throw new Error(`共有設定に失敗しました (${permRes.status})`);

  return file.id;
}

function drivePublicFileUrl(fileId) {
  return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${GOOGLE_API_KEY}`;
}

async function driveFetchPublicJson(fileId) {
  const res = await fetch(drivePublicFileUrl(fileId));
  if (!res.ok) throw new Error(`共有データの取得に失敗しました (${res.status})`);
  return res.json();
}

const FORMATIONS = ['混声四部', '混声三部', '男声', '女声', '同声二部', 'その他'];
const ACCOMPANIMENTS = ['ピアノ', 'ヴァイオリン', 'オーケストラ', '吹奏楽', 'アカペラ', 'その他'];
const LANGUAGES = ['日本語', 'ドイツ語', 'ラテン語', 'イタリア語', 'フランス語', '英語', 'ロシア語', 'その他'];
const TAG_PRESETS = ['歌ったことある', '歌いたい', '好き', '練習中', '思い出の曲'];

const THEME_STORAGE_KEY = 'theme';
const SHAKE_PREF_STORAGE_KEY = 'shakeToShufflePref';
const THEMES = [
  { id: 'wine', name: 'ワイン(標準)', category: 'classic-wa', paper: '#F3EEE1', ink: '#241F1B', inkSoft: '#6B6154', wine: '#7A2E2E', wineSoft: '#F1E1DD', gold: '#B08D57', goldSoft: '#F1E8D6', sage: '#5F6F4E', sageSoft: '#E7ECDD', line: '#DED5C0' },
  { id: 'indigo', name: '藍', category: 'classic-wa', paper: '#EFF1F0', ink: '#1B2430', inkSoft: '#5C6670', wine: '#2B4C6F', wineSoft: '#DCE6EE', gold: '#9C7C42', goldSoft: '#EFE6D2', sage: '#3F6656', sageSoft: '#DCEAE3', line: '#D6DAD8' },
  { id: 'sakura', name: '桜', category: 'classic-wa', paper: '#FBF1F0', ink: '#3A2A2C', inkSoft: '#8A6E70', wine: '#B95C6B', wineSoft: '#F6DEE1', gold: '#C08A4E', goldSoft: '#F3E5CF', sage: '#6E8A72', sageSoft: '#E4EEE2', line: '#EBD9D6' },
  { id: 'matcha', name: '抹茶', category: 'classic-wa', paper: '#F1F3E9', ink: '#25301F', inkSoft: '#5D6B52', wine: '#4F6B3A', wineSoft: '#DCE8CE', gold: '#9C8A3E', goldSoft: '#EDE7CB', sage: '#3E6B55', sageSoft: '#D8EBE0', line: '#DBE2C9' },
  { id: 'sumi', name: '墨', category: 'classic-wa', paper: '#EDEDEA', ink: '#1B1B1B', inkSoft: '#5A5A58', wine: '#3B3B3B', wineSoft: '#DADADA', gold: '#8C7A4C', goldSoft: '#E7E1CE', sage: '#4B5A52', sageSoft: '#DEE5E1', line: '#D4D3CE' },
  { id: 'sunset', name: '夕焼け', category: 'classic-wa', paper: '#FBEDE0', ink: '#3A2416', inkSoft: '#8A6A50', wine: '#C1613A', wineSoft: '#F5DCC9', gold: '#C99A3F', goldSoft: '#F3E6C6', sage: '#78735A', sageSoft: '#EAE6D6', line: '#EBD8C4' },
  { id: 'umi', name: '海', category: 'classic-wa', paper: '#EAF1F2', ink: '#12262B', inkSoft: '#4F6C72', wine: '#1F6E7A', wineSoft: '#D6E9EB', gold: '#9C8341', goldSoft: '#EBE4CB', sage: '#3A6E63', sageSoft: '#D9EAE5', line: '#D2E0E1' },
  { id: 'kohaku', name: '琥珀', category: 'classic-wa', paper: '#F6EEDD', ink: '#3A2C15', inkSoft: '#8C7A54', wine: '#A9722C', wineSoft: '#F0DDBB', gold: '#C9A03F', goldSoft: '#F3E8C8', sage: '#6E7A46', sageSoft: '#E6EAD4', line: '#E9DCBF' },
  { id: 'budou', name: '葡萄', category: 'classic-wa', paper: '#F0EBF1', ink: '#2A1F30', inkSoft: '#6E5F76', wine: '#6A3E7A', wineSoft: '#E8DCEC', gold: '#A98650', goldSoft: '#EEE4CF', sage: '#5A6E5E', sageSoft: '#DEE8DF', line: '#DFD5E1' },
  { id: 'shironeri', name: '白練', category: 'classic-wa', paper: '#F7F7F5', ink: '#26262A', inkSoft: '#6C6C72', wine: '#54595F', wineSoft: '#E3E5E7', gold: '#A48F5E', goldSoft: '#EFE9D6', sage: '#5A6B5E', sageSoft: '#E1E9E2', line: '#DFDFDC' },
  { id: 'pop-pink', name: 'バブルガム', category: 'pop', paper: '#F7EEF2', ink: '#351D29', inkSoft: '#895870', wine: '#E6338C', wineSoft: '#F0DBE6', gold: '#D56144', goldSoft: '#EEE0DD', sage: '#4ACFA2', sageSoft: '#DEEDE8', line: '#DED3D9' },
  { id: 'pop-cyan', name: 'ミントソーダ', category: 'pop', paper: '#EEF7F6', ink: '#1D3533', inkSoft: '#588985', wine: '#20B6AA', wineSoft: '#DBF0EE', gold: '#396FC6', goldSoft: '#DDE3EE', sage: '#A13E36', sageSoft: '#EDDFDE', line: '#D3DEDD' },
  { id: 'pop-lemon', name: 'レモンポップ', category: 'pop', paper: '#F7F5EE', ink: '#35311D', inkSoft: '#898158', wine: '#E2C012', wineSoft: '#F0ECDB', gold: '#87DD3C', goldSoft: '#E5EEDD', sage: '#2B2BCA', sageSoft: '#DEDEED', line: '#DEDCD3' },
  { id: 'pop-purple', name: 'グレープキャンディ', category: 'pop', paper: '#F4EEF7', ink: '#2D1D35', inkSoft: '#785889', wine: '#9F35D4', wineSoft: '#E9DBF0', gold: '#C6539C', goldSoft: '#EEDDE8', sage: '#60BC4E', sageSoft: '#E0EDDE', line: '#DBD3DE' },
  { id: 'pop-orange', name: 'タンジェリン', category: 'pop', paper: '#F7F1EE', ink: '#35261D', inkSoft: '#896B58', wine: '#ED701D', wineSoft: '#F0E3DB', gold: '#CDDD3C', goldSoft: '#EDEEDD', sage: '#357AD4', sageSoft: '#DEE4ED', line: '#DED8D3' },
  { id: 'pop-sky', name: 'スカイポップ', category: 'pop', paper: '#EEF4F7', ink: '#1D2D35', inkSoft: '#587889', wine: '#2597D0', wineSoft: '#DBE9F0', gold: '#514DCB', goldSoft: '#DDDDEE', sage: '#B87A3D', sageSoft: '#EDE6DE', line: '#D3DBDE' },
  { id: 'pop-coral', name: 'コーラルポップ', category: 'pop', paper: '#F7EFEE', ink: '#35201D', inkSoft: '#895E58', wine: '#E45944', wineSoft: '#F0DEDB', gold: '#D1BA47', goldSoft: '#EEEBDD', sage: '#59ABCF', sageSoft: '#DEE9ED', line: '#DED5D3' },
  { id: 'pop-lime', name: 'ライムツイスト', category: 'pop', paper: '#F3F7EE', ink: '#2A351D', inkSoft: '#728958', wine: '#6AA329', wineSoft: '#E6F0DB', gold: '#43B156', goldSoft: '#DDEEE0', sage: '#713D8F', sageSoft: '#E8DEED', line: '#D9DED3' },
  { id: 'casual-mustard', name: 'マスタードカフェ', category: 'casual', paper: '#F5F3F0', ink: '#342F23', inkSoft: '#7E7663', wine: '#BE9537', wineSoft: '#F0EADB', gold: '#95BA5E', goldSoft: '#E7EEDD', sage: '#505BA5', sageSoft: '#DEE0ED', line: '#DEDBD3' },
  { id: 'casual-denim', name: 'デニムブルー', category: 'casual', paper: '#F0F2F5', ink: '#232B34', inkSoft: '#63707E', wine: '#4573A1', wineSoft: '#DBE6F0', gold: '#6E5DB1', goldSoft: '#E1DEED', sage: '#957E50', sageSoft: '#ECE8DF', line: '#D3D9DE' },
  { id: 'casual-terracotta', name: 'テラコッタ', category: 'casual', paper: '#F5F1F0', ink: '#342823', inkSoft: '#7E6B63', wine: '#BF6640', wineSoft: '#F0E1DB', gold: '#B4B464', goldSoft: '#EEEEDD', sage: '#5982A6', sageSoft: '#DEE6ED', line: '#DED7D3' },
  { id: 'casual-mint', name: 'ソフトミント', category: 'casual', paper: '#F0F5F3', ink: '#23342E', inkSoft: '#637E75', wine: '#3F836C', wineSoft: '#DDEEE8', gold: '#4C809E', goldSoft: '#DFE7EC', sage: '#7E444E', sageSoft: '#EBE0E2', line: '#D3DEDB' },
  { id: 'casual-blush', name: 'ブラッシュピンク', category: 'casual', paper: '#F5F0F1', ink: '#342326', inkSoft: '#7E6367', wine: '#CA7281', wineSoft: '#F0DBDF', gold: '#B48F64', goldSoft: '#EEE6DD', sage: '#81BBBB', sageSoft: '#DEEDED', line: '#DED3D5' },
  { id: 'casual-olive', name: 'オリーブカジュアル', category: 'casual', paper: '#F4F5F0', ink: '#303423', inkSoft: '#777E63', wine: '#69783A', wineSoft: '#EAEEDD', gold: '#4B9447', goldSoft: '#E0ECDF', sage: '#553E74', sageSoft: '#E5E0EB', line: '#DBDED3' },
  { id: 'casual-lavender', name: 'ラベンダーデイズ', category: 'casual', paper: '#F2F0F5', ink: '#2A2334', inkSoft: '#6E637E', wine: '#8664B4', wineSoft: '#E4DDEE', gold: '#B464AB', goldSoft: '#ECDFEA', sage: '#87AF6A', sageSoft: '#E5EBE0', line: '#D8D3DE' },
  { id: 'casual-sand', name: 'サンドベージュ', category: 'casual', paper: '#F5F2F0', ink: '#342C23', inkSoft: '#7E7163', wine: '#A57D50', wineSoft: '#EEE6DD', gold: '#A2B464', goldSoft: '#E9ECDF', sage: '#566C9F', sageSoft: '#E0E3EB', line: '#DED9D3' },
  { id: 'classic-navy', name: 'ロイヤルネイビー', category: 'classic-western', paper: '#EEEFF2', ink: '#191E29', inkSoft: '#5D6A83', wine: '#203A6F', wineSoft: '#DBE2F0', gold: '#523781', goldSoft: '#E3DDEE', sage: '#60582E', sageSoft: '#EDEBDE', line: '#D3D7DE' },
  { id: 'classic-bordeaux', name: 'ボルドー', category: 'classic-western', paper: '#F2EEEE', ink: '#29191C', inkSoft: '#835D63', wine: '#772230', wineSoft: '#F0DBDF', gold: '#88633A', goldSoft: '#EEE6DD', sage: '#326767', sageSoft: '#DEEDED', line: '#DED3D5' },
  { id: 'classic-emerald', name: 'エメラルド', category: 'classic-western', paper: '#EEF2F0', ink: '#192923', inkSoft: '#5D8373', wine: '#216348', wineSoft: '#DBF0E7', gold: '#386475', goldSoft: '#DDE9EE', sage: '#562E38', sageSoft: '#EDDEE2', line: '#D3DEDA' },
  { id: 'classic-plum', name: 'プラム', category: 'classic-western', paper: '#F2EEF2', ink: '#291929', inkSoft: '#835D83', wine: '#6B2E6B', wineSoft: '#F0DBF0', gold: '#833F53', goldSoft: '#EDDEE2', sage: '#36633D', sageSoft: '#DFECE1', line: '#DED3DE' },
  { id: 'classic-charcoal', name: 'チャコール&ゴールド', category: 'classic-western', paper: '#F2F0EE', ink: '#292419', inkSoft: '#83775D', wine: '#53462D', wineSoft: '#EDE8DE', gold: '#5C7237', goldSoft: '#E7EBE0', sage: '#2D3353', sageSoft: '#E2E3E9', line: '#DEDBD3' },
  { id: 'classic-teal', name: 'ディープティール', category: 'classic-western', paper: '#EEF1F2', ink: '#192729', inkSoft: '#5D7D83', wine: '#1C545F', wineSoft: '#DBECF0', gold: '#313A72', goldSoft: '#DDDFEE', sage: '#533628', sageSoft: '#EDE3DE', line: '#D3DCDE' },
  { id: 'classic-forest', name: 'フォレストグリーン', category: 'classic-western', paper: '#EEF2EF', ink: '#19291E', inkSoft: '#5D836A', wine: '#225934', wineSoft: '#DBF0E2', gold: '#356C6E', goldSoft: '#DDEEEE', sage: '#502B3D', sageSoft: '#EDDEE6', line: '#D3DED7' },
  { id: 'classic-burgundy', name: 'バーガンディ', category: 'classic-western', paper: '#F2EEEE', ink: '#291A19', inkSoft: '#83605D', wine: '#6B2A24', wineSoft: '#F0DDDB', gold: '#7C6E3C', goldSoft: '#EEEBDD', sage: '#32525D', sageSoft: '#DEE9ED', line: '#DED4D3' },
  { id: 'ethnic-turmeric', name: 'ターメリック', category: 'ethnic', paper: '#F2EFE9', ink: '#322B1B', inkSoft: '#897A58', wine: '#CD981D', wineSoft: '#F0EADB', gold: '#98D043', goldSoft: '#E7EEDD', sage: '#3546B6', sageSoft: '#DEE0ED', line: '#DEDBD3' },
  { id: 'ethnic-indigo', name: 'インディゴ染め', category: 'ethnic', paper: '#E9EBF2', ink: '#1B2132', inkSoft: '#586489', wine: '#263973', wineSoft: '#DBE0F0', gold: '#5E3F83', goldSoft: '#E5DDEE', sage: '#636036', sageSoft: '#EDECDE', line: '#D3D6DE' },
  { id: 'ethnic-henna', name: 'ヘナ', category: 'ethnic', paper: '#F2EBE9', ink: '#32211B', inkSoft: '#896458', wine: '#9B4427', wineSoft: '#F0E0DB', gold: '#AAA541', goldSoft: '#EEEEDD', sage: '#3A6788', sageSoft: '#DEE7ED', line: '#DED6D3' },
  { id: 'ethnic-clay', name: '赤土', category: 'ethnic', paper: '#F2ECE9', ink: '#32221B', inkSoft: '#896858', wine: '#A65730', wineSoft: '#F0E2DB', gold: '#AFB24D', goldSoft: '#EEEEDD', sage: '#466B91', sageSoft: '#DEE6ED', line: '#DED7D3' },
  { id: 'ethnic-saffron', name: 'サフラン', category: 'ethnic', paper: '#F2EEE9', ink: '#32281B', inkSoft: '#897358', wine: '#E68D19', wineSoft: '#F0E7DB', gold: '#AFD742', goldSoft: '#EAEEDD', sage: '#335CCC', sageSoft: '#DEE2ED', line: '#DED9D3' },
  { id: 'ethnic-brick', name: 'ブリックレッド', category: 'ethnic', paper: '#F2EAE9', ink: '#321F1B', inkSoft: '#896058', wine: '#963D2C', wineSoft: '#F0DFDB', gold: '#A49846', goldSoft: '#EEECDD', sage: '#3F6C83', sageSoft: '#DEE8ED', line: '#DED5D3' },
  { id: 'ethnic-ochre', name: 'オーカー', category: 'ethnic', paper: '#F2EEE9', ink: '#32291B', inkSoft: '#897758', wine: '#A37629', wineSoft: '#F0E8DB', gold: '#8DB143', goldSoft: '#E8EEDD', sage: '#3D4E8F', sageSoft: '#DEE1ED', line: '#DEDAD3' },
  { id: 'ethnic-batik', name: 'バティック藍', category: 'ethnic', paper: '#E9EEF2', ink: '#1B2832', inkSoft: '#587489', wine: '#274D68', wineSoft: '#DBE7F0', gold: '#433C7C', goldSoft: '#DFDDEE', sage: '#5D4B32', sageSoft: '#EDE7DE', line: '#D3DADE' },
  { id: 'vivid-red', name: 'プライマリーレッド', category: 'vivid', paper: '#F6F3F3', ink: '#2E1919', inkSoft: '#895858', wine: '#E21212', wineSoft: '#F0DBDB', gold: '#DDAC3C', goldSoft: '#EEE9DD', sage: '#2BAFCA', sageSoft: '#DEEBED', line: '#DED3D3' },
  { id: 'vivid-blue', name: 'プライマリーブルー', category: 'vivid', paper: '#F3F5F6', ink: '#19222E', inkSoft: '#586C89', wine: '#1269E2', wineSoft: '#DBE4F0', gold: '#693CDD', goldSoft: '#E2DDEE', sage: '#CAA22B', sageSoft: '#EDE9DE', line: '#D3D8DE' },
  { id: 'vivid-yellow', name: 'プライマリーイエロー', category: 'vivid', paper: '#F6F6F3', ink: '#2E2A19', inkSoft: '#897F58', wine: '#F9C806', wineSoft: '#F0ECDB', gold: '#8CE830', goldSoft: '#E6EEDD', sage: '#2026DF', sageSoft: '#DEDEED', line: '#DEDCD3' },
  { id: 'vivid-green', name: 'プライマリーグリーン', category: 'vivid', paper: '#F3F6F4', ink: '#192E1D', inkSoft: '#588960', wine: '#1DA534', wineSoft: '#DBF0DF', gold: '#35B6A5', goldSoft: '#DDEEEC', sage: '#913071', sageSoft: '#EDDEE8', line: '#D3DED5' },
  { id: 'vivid-orange', name: 'ビビッドオレンジ', category: 'vivid', paper: '#F6F5F3', ink: '#2E2319', inkSoft: '#896F58', wine: '#F2780D', wineSoft: '#F0E5DB', gold: '#C6E236', goldSoft: '#EBEEDD', sage: '#2668D9', sageSoft: '#DEE3ED', line: '#DED8D3' },
  { id: 'vivid-purple', name: 'ビビッドパープル', category: 'vivid', paper: '#F5F3F6', ink: '#24192E', inkSoft: '#705889', wine: '#7322C3', wineSoft: '#E6DBF0', gold: '#C945AF', goldSoft: '#EEDDEB', sage: '#60AC39', sageSoft: '#E3EDDE', line: '#D9D3DE' },
  { id: 'vivid-magenta', name: 'ビビッドマゼンタ', category: 'vivid', paper: '#F6F3F5', ink: '#2E1927', inkSoft: '#895878', wine: '#DC189B', wineSoft: '#F0DBE9', gold: '#D74742', goldSoft: '#EEDDDD', sage: '#31C47A', sageSoft: '#DEEDE6', line: '#DED3DB' },
  { id: 'vivid-turquoise', name: 'ビビッドターコイズ', category: 'vivid', paper: '#F3F6F6', ink: '#192E2E', inkSoft: '#588989', wine: '#18AAAA', wineSoft: '#DBF0F0', gold: '#2F59BC', goldSoft: '#DDE2EE', sage: '#963D2C', sageSoft: '#EDE0DE', line: '#D3DEDE' },
  {
    id: 'apple-light', name: '試作001', category: 'apple',
    paper: '#F2F2F7', ink: '#1C1C1E', inkSoft: '#8E8E93',
    wine: '#007AFF', wineSoft: '#E5F1FF',
    gold: '#FF9500', goldSoft: '#FFF2E0',
    sage: '#34C759', sageSoft: '#E3F9E9',
    line: '#E5E5EA',
    // 色以外のデザイントークン(角丸・影・フォント)。他のテーマはこれらのキーを持たないため影響を受けない。
    fontDisplay: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif',
    fontBody: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif',
    radiusControl: 10, radiusCard: 16, radiusPill: 999,
    shadowCard: '0 1px 2px rgba(0,0,0,.06), 0 1px 1px rgba(0,0,0,.04)',
    shadowModal: '0 20px 44px rgba(0,0,0,.18)',
    flatBar: true, // Apple系ではウィンドウ上部の虹色グラデーションバーを非表示にする
  },
  {
    id: 'apple-dark', name: '試作002', category: 'apple',
    // ダークモード: 黒背景に白文字を基本とした配色
    paper: '#0A0A0A', ink: '#F2F2F2', inkSoft: '#BDBDC2',
    wine: '#0A84FF', wineSoft: '#16273A',
    gold: '#FF9F0A', goldSoft: '#3A2A12',
    sage: '#30D158', sageSoft: '#12321E',
    line: '#2C2C2E',
    surface: '#1C1C1E', // カード・入力欄などの一段明るい面(白決め打ちだったところをここで上書き)
    danger: '#FF6B5B', // エラー・警告文字色。黒背景でも読めるよう明るめの赤に
    goldText: '#FFC670', // イベント関連の文字色。黒背景でも読めるよう明るめの黄に
    fontDisplay: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif',
    fontBody: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif',
    radiusControl: 10, radiusCard: 16, radiusPill: 999,
    shadowCard: '0 1px 2px rgba(0,0,0,.4), 0 1px 1px rgba(0,0,0,.3)',
    shadowModal: '0 20px 44px rgba(0,0,0,.6)',
    flatBar: true,
  },
];
const THEME_CATEGORIES = [
  { id: 'classic-wa', label: '和・クラシカル' },
  { id: 'pop', label: 'POP' },
  { id: 'casual', label: 'カジュアル' },
  { id: 'classic-western', label: 'クラシカル(洋)' },
  { id: 'ethnic', label: 'エスニック' },
  { id: 'vivid', label: '原色・ビビッド' },
  { id: 'apple', label: '試作' },
];
function getTheme(id) {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

async function loadThemeId() {
  try {
    const v = await idbGet(THEME_STORAGE_KEY);
    return v?.themeId || 'wine';
  } catch (e) {
    return 'wine';
  }
}
async function saveThemeId(themeId) {
  try {
    await idbSet(THEME_STORAGE_KEY, { themeId });
  } catch (e) {
    console.error('テーマの保存に失敗しました', e);
  }
}

/* ---- 「スマホを振ってシャッフル」機能のオン/オフ設定 ----
   マイページから設定する、端末に保存される利用者の希望(オン/オフ)。既定はオン。 */
async function loadShakePref() {
  try {
    const v = await idbGet(SHAKE_PREF_STORAGE_KEY);
    return v?.enabled !== false; // 未設定(初回)は既定でオン
  } catch (e) {
    return true;
  }
}
async function saveShakePref(enabled) {
  try {
    await idbSet(SHAKE_PREF_STORAGE_KEY, { enabled });
  } catch (e) {
    console.error('シェイク設定の保存に失敗しました', e);
  }
}

const ID_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';
function genUserId(existingIds) {
  for (let attempt = 0; attempt < 30; attempt++) {
    let id = '';
    for (let i = 0; i < 8; i++) id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
    if (!existingIds.includes(id)) return id;
  }
  return `u${Date.now().toString(36)}`;
}

function getYoutubeVideoId(rawUrl) {
  if (!rawUrl) return null;
  const trimmed = rawUrl.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withProtocol);
    let videoId = null;
    if (u.hostname.includes('youtu.be')) {
      videoId = u.pathname.split('/').filter(Boolean)[0] || null;
    } else if (u.hostname.includes('youtube.com')) {
      if (u.pathname === '/watch') videoId = u.searchParams.get('v');
      else if (u.pathname.startsWith('/shorts/')) videoId = u.pathname.split('/')[2];
      else if (u.pathname.startsWith('/embed/')) videoId = u.pathname.split('/')[2];
      else if (u.pathname.startsWith('/live/')) videoId = u.pathname.split('/')[2];
    }
    return videoId || null;
  } catch (e) {
    return null;
  }
}

function getYoutubeThumbnail(url) {
  const id = getYoutubeVideoId(url);
  return id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : null;
}

/* ---- CSV一括登録 ---- */

const CSV_HEADERS = ['曲名', 'よみがな', '組曲の種類', '組曲タイトル', '組曲タイトルのよみがな', '組曲内での順番', '作詩', '作曲', '編曲', '発表年', '編成', '伴奏', '言語', '動画URL', '楽譜入手先', 'タグ'];

function buildCsvTemplate() {
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const header = CSV_HEADERS.map(esc).join(',');
  const example1 = ['大地讃頌', 'だいちさんしょう', '混声合唱のためのカンタータ', '土の歌', '1', '大木惇夫', '佐藤眞', '', '1962', '混声四部', 'ピアノ', '日本語', '', ''].map(esc).join(',');
  return `${header}\n${example1}\n`;
}

function parseCsvRows(rows) {
  const valid = [];
  const errors = [];
  rows.forEach((row, i) => {
    const rowNum = i + 2; // ヘッダー行を1行目とした実際の行番号
    const get = (key) => String(row[key] || '').replace(/^\uFEFF/, '').trim();
    const title = get('曲名');
    if (!title) { errors.push({ row: rowNum, reason: '曲名が空です' }); return; }

    const lyricist = mergeName(get('作詩'));
    if (!lyricist) { errors.push({ row: rowNum, reason: '作詩が空です' }); return; }

    const composer = mergeName(get('作曲'));
    if (!composer) { errors.push({ row: rowNum, reason: '作曲が空です' }); return; }

    const formationRaw = get('編成');
    if (!formationRaw) { errors.push({ row: rowNum, reason: '編成が空です' }); return; }
    const formation = FORMATIONS.includes(formationRaw) ? formationRaw : 'その他';
    const formationOther = FORMATIONS.includes(formationRaw) ? '' : formationRaw;

    const accompanimentRaw = get('伴奏');
    const accompaniment = !accompanimentRaw ? '' : (ACCOMPANIMENTS.includes(accompanimentRaw) ? accompanimentRaw : 'その他');
    const accompanimentOther = !accompanimentRaw || ACCOMPANIMENTS.includes(accompanimentRaw) ? '' : accompanimentRaw;

    const languageRaw = get('言語');
    const language = !languageRaw ? '' : (LANGUAGES.includes(languageRaw) ? languageRaw : 'その他');
    const languageOther = !languageRaw || LANGUAGES.includes(languageRaw) ? '' : languageRaw;

    const suiteOrderRaw = get('組曲内での順番').replace(/[^0-9]/g, '');
    const tagsRaw = get('タグ');
    const tags = tagsRaw
      ? tagsRaw.split(/[、,;]/).map((t) => t.trim()).filter(Boolean).map((name) => ({ name, visibility: 'public' }))
      : [];

    valid.push({
      ...emptySongDraft(),
      title,
      titleKana: get('よみがな'),
      suiteGenre: get('組曲の種類'),
      suiteTitle: get('組曲タイトル'),
      suiteTitleKana: get('組曲タイトルのよみがな'),
      suiteOrder: suiteOrderRaw ? Number(suiteOrderRaw) : '',
      lyricist, composer,
      arranger: mergeName(get('編曲')),
      year: get('発表年').replace(/[^0-9]/g, ''),
      formation, formationOther, accompaniment, accompanimentOther, language, languageOther,
      videoUrl: get('動画URL'),
      scoreSource: get('楽譜入手先'),
      tags,
    });
  });
  return { valid, errors };
}

function songsToCsv(songs) {
  const rows = songs.map((s) => ({
    '曲名': s.title || '',
    'よみがな': s.titleKana || '',
    '組曲の種類': s.suiteGenre || '',
    '組曲タイトル': s.suiteTitle || '',
    '組曲タイトルのよみがな': s.suiteTitleKana || '',
    '組曲内での順番': s.suiteOrder === '' || s.suiteOrder == null ? '' : s.suiteOrder,
    '作詩': s.lyricist || '',
    '作曲': s.composer || '',
    '編曲': s.arranger || '',
    '発表年': s.year || '',
    '編成': fieldOrOther(s.formation, s.formationOther),
    '伴奏': s.accompaniment ? fieldOrOther(s.accompaniment, s.accompanimentOther) : '',
    '言語': s.language ? fieldOrOther(s.language, s.languageOther) : '',
    '動画URL': s.videoUrl || '',
    '楽譜入手先': s.scoreSource || '',
    'タグ': (s.tags || []).filter((t) => t.visibility === 'public').map((t) => t.name).join('、'),
  }));
  return Papa.unparse(rows, { columns: CSV_HEADERS });
}

// ダウンロード用CSVは常にUTF-8+BOM付きにする。BOMが無いと、Excel(Windows版)で直接開いた際に
// 文字コードを正しく判別できず、日本語が文字化けすることがあるため。
function csvDownloadHref(csvText) {
  return `data:text/csv;charset=utf-8,${encodeURIComponent('\uFEFF' + csvText)}`;
}

// アップロードされたCSVファイルの文字コードを判定して文字列に変換する。
// UTF-8として正しく読めればそのまま採用し、読めない場合はShift-JIS(Excelの既定形式)として解釈し直す。
async function decodeCsvFile(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    try {
      return new TextDecoder('shift_jis').decode(buf);
    } catch (e2) {
      // Shift-JISのデコーダ自体が使えない場合は、多少文字化けしてもUTF-8として読む
      return new TextDecoder('utf-8').decode(buf);
    }
  }
}

function isValidBackupShape(obj) {
  return !!obj && typeof obj === 'object' && typeof obj.users === 'object' && typeof obj.songs === 'object';
}

/* ---- 共有(QRコード/URL) ----
   サーバーにデータを置かず、URL(またはQRコード)自体にデータを埋め込んで受け渡す方式。
   3種類のtypeを扱う: 'songs'(曲リスト) / 'event'(イベント参加) / 'profile'(プロフィール)
   容量を抑えるため、キー名を短縮した専用フォーマットでエンコードする。 */

/* ---- 自前QRコードエンコーダ(外部サービス非依存) ----
   ISO/IEC 18004準拠。参照実装(Python `qrcode`ライブラリ)とバイト単位・
   モジュール単位で完全一致することを検証済み(Byte modeのみ対応、v1-40、EC全レベル)。 */

// QR Code encoder (pure JS, no dependencies) — verification build
// Supports Byte mode only, versions 1-40, EC levels L/M/Q/H.

/* ---- GF(256) ---- */
const GF_EXP = new Array(512);
const GF_LOG = new Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/* ---- Reed-Solomon generator polynomial ---- */
function rsGeneratorPoly(degree) {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], GF_EXP[i]);
    }
    g = next;
  }
  return g;
}

function rsEncode(dataCodewords, ecCount) {
  const generator = rsGeneratorPoly(ecCount);
  const msg = dataCodewords.concat(new Array(ecCount).fill(0));
  for (let i = 0; i < dataCodewords.length; i++) {
    const coef = msg[i];
    if (coef !== 0) {
      for (let j = 0; j < generator.length; j++) {
        msg[i + j] ^= gfMul(generator[j], coef);
      }
    }
  }
  return msg.slice(dataCodewords.length);
}

/* ---- RS block table (ISO 18004). Index: (version-1)*4 + ecLevelIndex(L=0,M=1,Q=2,H=3) ---- */
/* Each entry: flat list of [count, totalCodewords, dataCodewords, count2, totalCodewords2, dataCodewords2] */
const RS_BLOCK_TABLE = [
  [1,26,19],[1,26,16],[1,26,13],[1,26,9],
  [1,44,34],[1,44,28],[1,44,22],[1,44,16],
  [1,70,55],[1,70,44],[2,35,17],[2,35,13],
  [1,100,80],[2,50,32],[2,50,24],[4,25,9],
  [1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],
  [2,86,68],[4,43,27],[4,43,19],[4,43,15],
  [2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],
  [2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],
  [2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],
  [2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],
  [4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],
  [2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],
  [4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],
  [3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],
  [5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12,7,37,13],
  [5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16],
  [1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],
  [5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],
  [3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],
  [3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],
  [4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17],
  [2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13],
  [4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],
  [6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],
  [8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],
  [10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],
  [8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],
  [3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],
  [7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],
  [5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],
  [13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],
  [17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],
  [17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],
  [13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],
  [12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16],
  [6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],
  [17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],
  [4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],
  [20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],
  [19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16],
];

const EC_LEVELS = { L: 1, M: 0, Q: 3, H: 2 }; // bits used in format info (see BCH_type_info usage: (ecLevel<<3)|mask)
// NOTE: actual QR spec ecLevel indicator bits: L=01(1), M=00(0), Q=11(3), H=10(2)

function getRSBlocks(version, ecLevelLetter) {
  const offset = { L: 0, M: 1, Q: 2, H: 3 }[ecLevelLetter];
  const row = RS_BLOCK_TABLE[(version - 1) * 4 + offset];
  const blocks = [];
  for (let i = 0; i < row.length; i += 3) {
    const [count, total, data] = [row[i], row[i + 1], row[i + 2]];
    for (let k = 0; k < count; k++) blocks.push({ total, data });
  }
  return blocks;
}

/* ---- Alignment pattern position table ---- */
const PATTERN_POSITION_TABLE = [
  [],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],
  [6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],
  [6,30,56,82],[6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],
  [6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],
  [6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],
  [6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],
  [6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170],
];

/* ---- BCH ---- */
const G15 = (1<<10)|(1<<8)|(1<<5)|(1<<4)|(1<<2)|(1<<1)|(1<<0);
const G18 = (1<<12)|(1<<11)|(1<<10)|(1<<9)|(1<<8)|(1<<5)|(1<<2)|(1<<0);
const G15_MASK = (1<<14)|(1<<12)|(1<<10)|(1<<4)|(1<<1);

function bchDigit(data) {
  let digit = 0;
  while (data !== 0) { digit++; data >>>= 1; }
  return digit;
}
function bchTypeInfo(data) {
  let d = data << 10;
  while (bchDigit(d) - bchDigit(G15) >= 0) d ^= G15 << (bchDigit(d) - bchDigit(G15));
  return ((data << 10) | d) ^ G15_MASK;
}
function bchTypeNumber(data) {
  let d = data << 12;
  while (bchDigit(d) - bchDigit(G18) >= 0) d ^= G18 << (bchDigit(d) - bchDigit(G18));
  return (data << 12) | d;
}

/* ---- Mask functions ---- */
const MASK_FUNCS = [
  (i, j) => (i + j) % 2 === 0,
  (i, j) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0,
];

/* ---- BitBuffer ---- */
class BitBuffer {
  constructor() { this.buffer = []; this.length = 0; }
  put(num, length) {
    for (let i = 0; i < length; i++) this.putBit(((num >>> (length - i - 1)) & 1) === 1);
  }
  putBit(bit) {
    const bufIndex = Math.floor(this.length / 8);
    if (this.buffer.length <= bufIndex) this.buffer.push(0);
    if (bit) this.buffer[bufIndex] |= 0x80 >>> (this.length % 8);
    this.length += 1;
  }
}

/* ---- Byte-mode data + RS interleave ---- */
const PAD0 = 0xec, PAD1 = 0x11;

function utf8Bytes(str) {
  return Array.from(new TextEncoder().encode(str));
}

function createData(version, ecLevelLetter, bytes) {
  const buffer = new BitBuffer();
  buffer.put(0b0100, 4); // byte mode indicator
  const lenBits = version < 10 ? 8 : 16;
  buffer.put(bytes.length, lenBits);
  for (const b of bytes) buffer.put(b, 8);

  const rsBlocks = getRSBlocks(version, ecLevelLetter);
  const bitLimit = rsBlocks.reduce((sum, b) => sum + b.data * 8, 0);
  if (buffer.length > bitLimit) throw new Error(`Data too long for version ${version}`);

  for (let i = 0; i < Math.min(bitLimit - buffer.length, 4); i++) buffer.putBit(false);
  const delimit = buffer.length % 8;
  if (delimit) for (let i = 0; i < 8 - delimit; i++) buffer.putBit(false);
  const bytesToFill = Math.floor((bitLimit - buffer.length) / 8);
  for (let i = 0; i < bytesToFill; i++) buffer.put(i % 2 === 0 ? PAD0 : PAD1, 8);

  // interleave
  let offset = 0;
  let maxDc = 0, maxEc = 0;
  const dcData = [], ecData = [];
  for (const block of rsBlocks) {
    const dcCount = block.data;
    const ecCount = block.total - dcCount;
    maxDc = Math.max(maxDc, dcCount);
    maxEc = Math.max(maxEc, ecCount);
    const dc = [];
    for (let i = 0; i < dcCount; i++) dc.push(buffer.buffer[i + offset] & 0xff);
    offset += dcCount;
    const ec = rsEncode(dc, ecCount);
    dcData.push(dc);
    ecData.push(ec);
  }
  const data = [];
  for (let i = 0; i < maxDc; i++) for (const dc of dcData) if (i < dc.length) data.push(dc[i]);
  for (let i = 0; i < maxEc; i++) for (const ec of ecData) if (i < ec.length) data.push(ec[i]);
  return data;
}

function bitLimitForVersion(version, ecLevelLetter) {
  return getRSBlocks(version, ecLevelLetter).reduce((sum, b) => sum + b.data * 8, 0);
}

function findVersion(byteLength, ecLevelLetter) {
  for (let v = 1; v <= 40; v++) {
    const lenBits = v < 10 ? 8 : 16;
    const neededBits = 4 + lenBits + byteLength * 8;
    if (neededBits <= bitLimitForVersion(v, ecLevelLetter)) return v;
  }
  return null;
}

/* ---- Matrix construction ---- */
function buildMatrix(version, ecLevelLetter, dataBytes, forceMask) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(null));

  const setFinder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      if (row + r <= -1 || size <= row + r) continue;
      for (let c = -1; c <= 7; c++) {
        if (col + c <= -1 || size <= col + c) continue;
        const isDark = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                        (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                        (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        modules[row + r][col + c] = isDark;
      }
    }
  };
  setFinder(0, 0);
  setFinder(size - 7, 0);
  setFinder(0, size - 7);

  // alignment
  const pos = PATTERN_POSITION_TABLE[version - 1];
  for (const row of pos) {
    for (const col of pos) {
      if (modules[row][col] !== null) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const isDark = r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
          modules[row + r][col + c] = isDark;
        }
      }
    }
  }

  // timing
  for (let r = 8; r < size - 8; r++) if (modules[r][6] === null) modules[r][6] = r % 2 === 0;
  for (let c = 8; c < size - 8; c++) if (modules[6][c] === null) modules[6][c] = c % 2 === 0;

  // version info (v>=7)
  if (version >= 7) {
    const bits = bchTypeNumber(version);
    for (let i = 0; i < 18; i++) {
      const mod = ((bits >>> i) & 1) === 1;
      modules[Math.floor(i / 3)][(i % 3) + size - 8 - 3] = mod;
      modules[(i % 3) + size - 8 - 3][Math.floor(i / 3)] = mod;
    }
  }

  const ecBits = { L: 1, M: 0, Q: 3, H: 2 }[ecLevelLetter];

  const setFormatInfo = (maskPattern) => {
    const data = (ecBits << 3) | maskPattern;
    const bits = bchTypeInfo(data);
    for (let i = 0; i < 15; i++) {
      const mod = ((bits >>> i) & 1) === 1;
      if (i < 6) modules[i][8] = mod;
      else if (i < 8) modules[i + 1][8] = mod;
      else modules[size - 15 + i][8] = mod;
    }
    for (let i = 0; i < 15; i++) {
      const mod = ((bits >>> i) & 1) === 1;
      if (i < 8) modules[8][size - i - 1] = mod;
      else if (i < 9) modules[8][15 - i - 1 + 1] = mod;
      else modules[8][15 - i - 1] = mod;
    }
    modules[size - 8][8] = true;
  };

  // data placement (function pattern cells are already non-null; will skip)
  const placeData = (maskPattern, modulesCopy) => {
    let inc = -1, row = size - 1, bitIndex = 7, byteIndex = 0;
    const maskFn = MASK_FUNCS[maskPattern];
    const dataLen = dataBytes.length;
    for (let colBase = size - 1; colBase > 0; colBase -= 2) {
      let col = colBase <= 6 ? colBase - 1 : colBase;
      while (true) {
        for (const c of [col, col - 1]) {
          if (modulesCopy[row][c] === null) {
            let dark = false;
            if (byteIndex < dataLen) dark = ((dataBytes[byteIndex] >>> bitIndex) & 1) === 1;
            if (maskFn(row, c)) dark = !dark;
            modulesCopy[row][c] = dark;
            bitIndex -= 1;
            if (bitIndex === -1) { byteIndex += 1; bitIndex = 7; }
          }
        }
        row += inc;
        if (row < 0 || size <= row) { row -= inc; inc = -inc; break; }
      }
    }
  };

  const lostPoint = (mods) => {
    let total = 0;
    const n = size;
    // rule 1
    const container = new Array(n + 1).fill(0);
    for (let row = 0; row < n; row++) {
      let prev = mods[row][0], len = 0;
      for (let col = 0; col < n; col++) {
        if (mods[row][col] === prev) len++;
        else { if (len >= 5) container[len]++; len = 1; prev = mods[row][col]; }
      }
      if (len >= 5) container[len]++;
    }
    for (let col = 0; col < n; col++) {
      let prev = mods[0][col], len = 0;
      for (let row = 0; row < n; row++) {
        if (mods[row][col] === prev) len++;
        else { if (len >= 5) container[len]++; len = 1; prev = mods[row][col]; }
      }
      if (len >= 5) container[len]++;
    }
    for (let l = 5; l <= n; l++) total += container[l] * (l - 2);
    // rule 2
    for (let row = 0; row < n - 1; row++) {
      for (let col = 0; col < n - 1; col++) {
        const v = mods[row][col];
        if (v === mods[row][col + 1] && v === mods[row + 1][col] && v === mods[row + 1][col + 1]) total += 3;
      }
    }
    // rule 3
    const patternMatch = (arr, start) => {
      const p1 = [true, false, true, true, true, false, true, false, false, false, false];
      const p2 = [false, false, false, false, true, false, true, true, true, false, true];
      let m1 = true, m2 = true;
      for (let i = 0; i < 11; i++) {
        if (arr[start + i] !== p1[i]) m1 = false;
        if (arr[start + i] !== p2[i]) m2 = false;
      }
      return m1 || m2;
    };
    for (let row = 0; row < n; row++) {
      for (let col = 0; col <= n - 11; col++) if (patternMatch(mods[row], col)) total += 40;
    }
    for (let col = 0; col < n; col++) {
      const colArr = mods.map((r) => r[col]);
      for (let row = 0; row <= n - 11; row++) if (patternMatch(colArr, row)) total += 40;
    }
    // rule 4
    let dark = 0;
    for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) if (mods[row][col]) dark++;
    const percent = (dark / (n * n)) * 100;
    total += Math.floor(Math.abs(percent - 50) / 5) * 10;
    return total;
  };

  let best = null, bestScore = Infinity, bestMask = 0;
  if (forceMask !== undefined) {
    const copy = modules.map((row) => row.slice());
    setFormatInfoOn(copy, forceMask);
    placeData(forceMask, copy);
    best = copy;
    bestMask = forceMask;
  } else {
    for (let mp = 0; mp < 8; mp++) {
      const copy = modules.map((row) => row.slice());
      setFormatInfoOn(copy, mp);
      placeData(mp, copy);
      const score = lostPoint(copy);
      if (score < bestScore) { bestScore = score; best = copy; bestMask = mp; }
    }
  }

  function setFormatInfoOn(mods, maskPattern) {
    const data = (ecBits << 3) | maskPattern;
    const bits = bchTypeInfo(data);
    for (let i = 0; i < 15; i++) {
      const mod = ((bits >>> i) & 1) === 1;
      if (i < 6) mods[i][8] = mod;
      else if (i < 8) mods[i + 1][8] = mod;
      else mods[size - 15 + i][8] = mod;
    }
    for (let i = 0; i < 15; i++) {
      const mod = ((bits >>> i) & 1) === 1;
      if (i < 8) mods[8][size - i - 1] = mod;
      else if (i < 9) mods[8][15 - i - 1 + 1] = mod;
      else mods[8][15 - i - 1] = mod;
    }
    mods[size - 8][8] = true;
  }

  return { modules: best, mask: bestMask, size };
}

function encodeQR(text, ecLevelLetter = 'M') {
  const bytes = utf8Bytes(text);
  const version = findVersion(bytes.length, ecLevelLetter);
  if (!version) throw new Error('Data too long for QR code (max version 40 exceeded)');
  const dataBytes = createData(version, ecLevelLetter, bytes);
  const { modules, mask, size } = buildMatrix(version, ecLevelLetter, dataBytes);
  return { modules, version, mask, size };
}


/* ---- Ver.1では「人に関する機能」を凍結中 ----
   フォロー・フォロワー・さがす・すれ違い・プロフィール共有・通報/ブロック/擁護など。
   Ver.1は「Googleドライブと連携して自分の合唱曲DBを整備する」ことに集中し、
   曲(リスト)の共有はSNS経由のリンクや現実のQRコードのみで行う。
   データモデル・関連コードは残したままこのフラグで表示を止めているだけなので、
   Ver.2でこの値をtrueに戻せば復活する。 */
const SOCIAL_FEATURES_ENABLED = false;

const SHARE_URL_BASE = 'https://utacolle.com/';
const SHARE_QR_SAFE_LIMIT = 1200; // 文字数。これを超えるとQRの読み取り信頼性が下がる

function songDupKey(s) {
  const norm = (v) => (v || '').trim().replace(/\s+/g, '');
  return `${norm(s.title)}|${norm(s.lyricist)}|${norm(s.composer)}`;
}
function findDuplicateSong(song, mySongs) {
  const key = songDupKey(song);
  if (key === '||') return null; // 曲名・作詩・作曲が全部空なら判定しない
  return mySongs.find((s) => songDupKey(s) === key) || null;
}
function mergeSongInfo(existing, incoming, fields) {
  const list = fields && fields.length ? fields : ['suiteGenre', 'suiteTitle', 'arranger', 'year', 'formation', 'formationOther', 'accompaniment', 'accompanimentOther', 'language', 'languageOther', 'videoUrl', 'scoreSource'];
  const next = { ...existing };
  list.forEach((k) => { if (incoming[k]) next[k] = incoming[k]; });
  next.updatedAt = Date.now();
  return next;
}
function overwriteSongInfo(existing, incoming) {
  const fields = ['title', 'titleKana', 'suiteGenre', 'suiteTitle', 'suiteTitleKana', 'lyricist', 'composer', 'arranger', 'year', 'formation', 'formationOther', 'accompaniment', 'accompanimentOther', 'language', 'languageOther', 'videoUrl', 'scoreSource'];
  const next = { ...existing };
  fields.forEach((k) => { next[k] = incoming[k]; });
  next.updatedAt = Date.now();
  return next;
}

const DUP_COMPARE_FIELDS = [
  ['suiteGenre', '組曲の種類'],
  ['suiteTitle', '組曲タイトル'],
  ['arranger', '編曲'],
  ['year', '発表年'],
  ['formation', '編成'],
  ['accompaniment', '伴奏'],
  ['language', '言語'],
];
function dupFieldDisplay(s, key) {
  if (key === 'formation') return fieldOrOther(s.formation, s.formationOther) || '';
  if (key === 'accompaniment') return s.accompaniment ? fieldOrOther(s.accompaniment, s.accompanimentOther) : '';
  if (key === 'language') return s.language ? fieldOrOther(s.language, s.languageOther) : '';
  return s[key] || '';
}
function MiniYoutubeThumb({ url }) {
  const thumb = getYoutubeThumbnail(url);
  return (
    <a href={url} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
      {thumb && (
        <img
          src={thumb} alt="" style={{ width: 56, height: 32, objectFit: 'cover', borderRadius: 4, display: 'block', flexShrink: 0 }}
          onError={(e) => { e.target.style.display = 'none'; }}
        />
      )}
      <ExternalLink size={11} />
    </a>
  );
}
function SongCompareCard({ existing, incoming }) {
  const rows = DUP_COMPARE_FIELDS
    .map(([key, label]) => ({ key, label, a: dupFieldDisplay(existing, key), b: dupFieldDisplay(incoming, key) }))
    .filter((r) => r.a || r.b);
  const hasVideo = existing.videoUrl || incoming.videoUrl;
  const hasScore = existing.scoreSource || incoming.scoreSource;
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '58px 1fr 1fr', gap: '4px 8px', alignItems: 'center',
      fontSize: 11.5, background: 'var(--surface, #fff)', border: '1px solid var(--line)', borderRadius: 6, padding: '8px 10px', margin: '6px 0',
    }}>
      <div />
      <div style={{ fontWeight: 600, color: 'var(--ink-soft)' }}>登録済み</div>
      <div style={{ fontWeight: 600, color: 'var(--wine)' }}>今回のデータ</div>
      {rows.map((r) => (
        <React.Fragment key={r.key}>
          <div style={{ color: 'var(--ink-soft)' }}>{r.label}</div>
          <div>{r.a || '—'}</div>
          <div style={{ color: r.a !== r.b ? 'var(--wine)' : 'inherit', fontWeight: r.a !== r.b ? 600 : 400 }}>{r.b || '—'}</div>
        </React.Fragment>
      ))}
      {hasVideo && (
        <React.Fragment>
          <div style={{ color: 'var(--ink-soft)' }}>動画</div>
          <div>{existing.videoUrl ? <MiniYoutubeThumb url={existing.videoUrl} /> : '—'}</div>
          <div>{incoming.videoUrl ? <MiniYoutubeThumb url={incoming.videoUrl} /> : '—'}</div>
        </React.Fragment>
      )}
      {hasScore && (
        <React.Fragment>
          <div style={{ color: 'var(--ink-soft)' }}>楽譜</div>
          <div style={{ wordBreak: 'break-all' }}>{existing.scoreSource || '—'}</div>
          <div style={{ wordBreak: 'break-all', color: existing.scoreSource !== incoming.scoreSource ? 'var(--wine)' : 'inherit' }}>{incoming.scoreSource || '—'}</div>
        </React.Fragment>
      )}
    </div>
  );
}
const DUP_ACTION_OPTIONS = [
  ['merge', '一部の情報を追加・上書き(項目を選択)'],
  ['skip', 'この曲の登録をスキップする'],
  ['overwrite', '同じ曲として、自分の登録内容を上書きする'],
  ['new', '別の曲として、新規に登録する'],
];
const MERGE_FIELD_GROUPS = [
  { key: 'suiteGenre', label: '組曲の種類', fields: ['suiteGenre'] },
  { key: 'suiteTitle', label: '組曲タイトル', fields: ['suiteTitle', 'suiteTitleKana'] },
  { key: 'arranger', label: '編曲', fields: ['arranger'] },
  { key: 'year', label: '発表年', fields: ['year'] },
  { key: 'formation', label: '編成', fields: ['formation', 'formationOther'] },
  { key: 'accompaniment', label: '伴奏', fields: ['accompaniment', 'accompanimentOther'] },
  { key: 'language', label: '言語', fields: ['language', 'languageOther'] },
  { key: 'videoUrl', label: '動画URL', fields: ['videoUrl'] },
  { key: 'scoreSource', label: '楽譜入手先', fields: ['scoreSource'] },
];
function defaultMergeFieldKeys(existing, incoming) {
  const picked = new Set();
  MERGE_FIELD_GROUPS.forEach((g) => {
    const incomingHas = g.fields.some((f) => incoming[f]);
    if (!incomingHas) return;
    const existingHas = g.fields.some((f) => existing[f]);
    if (!existingHas || g.key === 'videoUrl' || g.key === 'scoreSource') picked.add(g.key);
  });
  return picked;
}
function flattenMergeFieldKeys(keys) {
  const out = [];
  MERGE_FIELD_GROUPS.forEach((g) => { if (keys.has(g.key)) out.push(...g.fields); });
  return out;
}
function DupActionPicker({ existing, incoming, value, onChange, name }) {
  const mode = value?.mode || 'skip';
  const mergeFields = value?.mergeFields || new Set();
  const setMode = (m) => {
    if (m === 'merge' && mergeFields.size === 0) {
      onChange({ mode: m, mergeFields: defaultMergeFieldKeys(existing, incoming) });
    } else {
      onChange({ mode: m, mergeFields });
    }
  };
  const toggleField = (key) => {
    const next = new Set(mergeFields);
    if (next.has(key)) next.delete(key); else next.add(key);
    onChange({ mode: 'merge', mergeFields: next });
  };
  const eligibleGroups = MERGE_FIELD_GROUPS.filter((g) => g.fields.some((f) => incoming[f]));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {DUP_ACTION_OPTIONS.map(([val, label]) => (
        <label key={val} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
          <input type="radio" name={name} checked={mode === val} onChange={() => setMode(val)} style={{ width: 13, height: 13 }} />
          {label}
        </label>
      ))}
      {mode === 'merge' && eligibleGroups.length > 0 && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 8, marginLeft: 19, marginTop: 2,
          padding: '6px 8px', background: 'var(--surface, #fff)', borderRadius: 6, border: '1px solid var(--line)',
        }}>
          {eligibleGroups.map((g) => (
            <label key={g.key} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, cursor: 'pointer' }}>
              <input type="checkbox" checked={mergeFields.has(g.key)} onChange={() => toggleField(g.key)} style={{ width: 12, height: 12 }} />
              {g.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function songToShareEntry(s) {
  const e = { t: s.title, ly: s.lyricist, co: s.composer, fo: s.formation };
  if (s.titleKana) e.tk = s.titleKana;
  if (s.suiteGenre) e.sg = s.suiteGenre;
  if (s.suiteTitle) e.st = s.suiteTitle;
  if (s.suiteTitleKana) e.stk = s.suiteTitleKana;
  if (s.arranger) e.ar = s.arranger;
  if (s.year) e.y = s.year;
  if (s.formationOther) e.foO = s.formationOther;
  if (s.accompaniment) e.ac = s.accompaniment;
  if (s.accompanimentOther) e.acO = s.accompanimentOther;
  if (s.language) e.la = s.language;
  if (s.languageOther) e.laO = s.languageOther;
  if (s.videoUrl) e.vu = s.videoUrl;
  if (s.scoreSource) e.sc = s.scoreSource;
  return e;
}

function shareEntryToSong(e) {
  return {
    ...emptySongDraft(),
    title: e.t || '', titleKana: e.tk || '', suiteGenre: e.sg || '', suiteTitle: e.st || '', suiteTitleKana: e.stk || '',
    lyricist: e.ly || '', composer: e.co || '', arranger: e.ar || '',
    year: e.y || '', formation: e.fo || '', formationOther: e.foO || '',
    accompaniment: e.ac || '', accompanimentOther: e.acO || '',
    language: e.la || '', languageOther: e.laO || '',
    videoUrl: e.vu || '', scoreSource: e.sc || '',
  };
}

function base64UrlEncode(str) {
  const b64 = btoa(unescape(encodeURIComponent(str)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64UrlDecode(str) {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return decodeURIComponent(escape(atob(b64)));
}

function base64UrlEncodeBytes(bytes) {
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64UrlDecodeBytes(str) {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* ---- 共有URLを短くするための圧縮(gzip/deflate)付きエンコード ----
   対応ブラウザ(CompressionStream/DecompressionStreamが使える。主要ブラウザはほぼ対応)では、
   JSONをdeflateで圧縮してからbase64にする。先頭に "z:" を付けて圧縮版だと分かるようにする
   (base64urlの文字にコロン":"は絶対に現れないので、旧形式のリンクと誤認することはない)。
   非対応ブラウザや、圧縮しても逆に大きくなってしまう極端に短いデータの場合は、
   従来通りの無圧縮のbase64(先頭"z:"なし)にそのままフォールバックする。
   → 古い(圧縮対応前の)共有リンクも、先頭に"z:"が無い形式として引き続き読み取れる(後方互換)。 */
async function compactEncodeJSON(obj) {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  if (typeof CompressionStream !== 'undefined') {
    try {
      const cs = new CompressionStream('deflate-raw');
      const stream = new Blob([bytes]).stream().pipeThrough(cs);
      const buf = await new Response(stream).arrayBuffer();
      const compressed = new Uint8Array(buf);
      if (compressed.length < bytes.length) {
        return 'z:' + base64UrlEncodeBytes(compressed);
      }
    } catch (e) {
      // 圧縮に失敗しても致命的ではないので、下の無圧縮版にフォールバックする
    }
  }
  return base64UrlEncodeBytes(bytes);
}
async function compactDecodeJSON(str) {
  const isCompressed = str.startsWith('z:');
  const body = isCompressed ? str.slice(2) : str;
  const bytes = base64UrlDecodeBytes(body);
  if (!isCompressed) return new TextDecoder().decode(bytes);
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('お使いのブラウザは、この共有リンクの読み込みに対応していません。ブラウザを最新版に更新してください。');
  }
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new TextDecoder().decode(buf);
}

/* ---- 曲リスト共有(type: 'songs') ---- */

function encodeSharePayload(fromName, songs) {
  const payload = { v: 2, ty: 'songs', from: fromName || '', songs: songs.map(songToShareEntry) };
  return compactEncodeJSON(payload);
}

/* ---- 曲リスト共有(type: 'songs-drive'、大量共有向け) ----
   曲データそのものではなく、Googleドライブ上の公開ファイルへの「参照」だけをQR/URLに埋め込む。
   ペイロード自体は常に小さいままなので、曲数がどれだけ多くてもQRコードで確実に読み取れる。 */

function encodeDriveSharePayload(fromName, driveFileId) {
  const payload = { v: 1, ty: 'songs-drive', from: fromName || '', fid: driveFileId };
  return compactEncodeJSON(payload);
}

/* ---- イベント参加(type: 'event') ---- */

function encodeEventPayload(eventName, eventDate, hostName) {
  const payload = {
    v: 2, ty: 'event', id: genId('evt'),
    n: eventName, d: eventDate || '', from: hostName || '',
  };
  return compactEncodeJSON(payload);
}

/* ---- プロフィール共有(type: 'profile') ---- */

function encodeProfilePayload(user) {
  const payload = {
    v: 2, ty: 'profile', uid: user.userId, name: user.displayName, bio: user.bio || '',
  };
  const age = ageLabel(user);
  if (age) payload.age = age;
  return compactEncodeJSON(payload);
}

/* ---- 共通デコード ---- */

async function decodeSharePayload(encoded) {
  const payload = JSON.parse(await compactDecodeJSON(encoded));
  if (!payload || typeof payload !== 'object') throw new Error('invalid payload');

  // v1(旧・曲リストのみ)との後方互換
  const type = payload.ty || (Array.isArray(payload.songs) ? 'songs' : null);
  if (!type) throw new Error('invalid payload');

  if (type === 'songs') {
    if (!Array.isArray(payload.songs)) throw new Error('invalid songs payload');
    return { type: 'songs', from: payload.from || '', songs: payload.songs.map(shareEntryToSong) };
  }
  if (type === 'songs-drive') {
    if (!payload.fid) throw new Error('invalid songs-drive payload');
    return { type: 'songs-drive', from: payload.from || '', driveFileId: payload.fid };
  }
  if (type === 'event') {
    if (!payload.n) throw new Error('invalid event payload');
    return { type: 'event', id: payload.id || genId('evt'), name: payload.n, date: payload.d || '', from: payload.from || '' };
  }
  if (type === 'profile') {
    if (!payload.uid || !payload.name) throw new Error('invalid profile payload');
    return { type: 'profile', userId: payload.uid, displayName: payload.name, bio: payload.bio || '', ageLabel: payload.age || '' };
  }
  throw new Error('unknown payload type');
}

function buildShareUrl(encoded) {
  return `${SHARE_URL_BASE}#${encoded}`;
}

function extractShareCodeFromInput(text) {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const hashIndex = trimmed.indexOf('#');
  return hashIndex >= 0 ? trimmed.slice(hashIndex + 1) : trimmed;
}

function emptySongFilters() {
  return { keyword: '', lyricist: '', composer: '', formation: '', language: '', tags: [] };
}

function isSongFilterActive(f) {
  return !!(f.keyword || f.lyricist || f.composer || f.formation || f.language || (f.tags && f.tags.length > 0));
}

function filterSongs(songs, f) {
  const kw = f.keyword.trim().toLowerCase();
  const lyr = f.lyricist.trim().toLowerCase();
  const comp = f.composer.trim().toLowerCase();
  return songs.filter((s) => {
    if (kw) {
      const hay = [s.title, s.suiteGenre, s.suiteTitle].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    if (lyr && !(s.lyricist || '').toLowerCase().includes(lyr)) return false;
    if (comp && !(s.composer || '').toLowerCase().includes(comp)) return false;
    if (f.formation && s.formation !== f.formation) return false;
    if (f.language && s.language !== f.language) return false;
    if (f.tags && f.tags.length > 0) {
      const songTagNames = (s.tags || []).map((t) => t.name);
      if (!f.tags.every((t) => songTagNames.includes(t))) return false;
    }
    return true;
  });
}

function seededHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return h;
}
function normalizeForSort(s) {
  // 全角英数を半角に、ひらがな/カタカナの表記ゆれを吸収し、前後の空白を除去
  return (s || '')
    .trim()
    .normalize('NFKC')
    .replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60)); // カタカナ→ひらがな
}
function sortSongs(songs, sortKey, randomSeed = '') {
  const list = [...songs];
  const titleCompare = (a, b) => {
    // 組曲名がある場合は組曲名(よみがな優先)を優先してまとめ、組曲内は曲名(よみがな優先)順にする
    const ak = normalizeForSort(a.suiteTitleKana || a.suiteTitle || a.title);
    const bk = normalizeForSort(b.suiteTitleKana || b.suiteTitle || b.title);
    const cmp = ak.localeCompare(bk, 'ja', { numeric: true, sensitivity: 'base' });
    if (cmp !== 0) return cmp;
    const at = normalizeForSort(a.titleKana || a.title);
    const bt = normalizeForSort(b.titleKana || b.title);
    return at.localeCompare(bt, 'ja', { numeric: true, sensitivity: 'base' });
  };
  if (sortKey === 'title-asc' || sortKey === 'title') return list.sort(titleCompare);
  if (sortKey === 'title-desc') return list.sort((a, b) => titleCompare(b, a));
  if (sortKey === 'oldest') return list.sort((a, b) => a.createdAt - b.createdAt);
  if (sortKey === 'updated') return list.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  if (sortKey === 'newest') return list.sort((a, b) => b.createdAt - a.createdAt);
  if (sortKey === 'sungDate-desc' || sortKey === 'sungDate-asc') {
    // 歌った記録の日付順。未入力の曲は常に最後に回す。
    const dir = sortKey === 'sungDate-desc' ? -1 : 1;
    return list.sort((a, b) => {
      const ad = a.sungRecord?.date || '';
      const bd = b.sungRecord?.date || '';
      if (!ad && !bd) return 0;
      if (!ad) return 1;
      if (!bd) return -1;
      return dir * ad.localeCompare(bd);
    });
  }
  // 'random'(デフォルト): セッション内では順序が変わらない疑似ランダム
  return list.sort((a, b) => seededHash(a.id + randomSeed) - seededHash(b.id + randomSeed));
}

const emptyData = () => ({ users: {}, songs: {} });

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function isStandaloneApp() {
  if (typeof window === 'undefined') return false;
  const byMediaQuery = !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  const byIosFlag = window.navigator && window.navigator.standalone === true; // iOSのホーム画面追加時
  return byMediaQuery || byIosFlag;
}

// スマホ・タブレットかどうかの判定。ホーム画面に追加済みかどうか(isStandaloneApp)を問わず、
// タッチ操作の小さい画面では別ウィンドウ(ポップアップ)を使わないようにするために使う。
// ポップアップはスマホのブラウザだと毎回「許可しますか」と聞かれてしまい体験が悪いため。
function isMobileDevice() {
  if (typeof window === 'undefined') return false;
  const byUserAgent = /Android|iPhone|iPad|iPod/i.test(window.navigator.userAgent || '');
  const byPointerAndWidth = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches) && window.innerWidth < 900;
  return byUserAgent || byPointerAndWidth;
}

/* ---- 他アプリの「共有」から届いたリンクの解析(Web Share Target) ---- */
function extractUrlFromShareParams(params) {
  const candidates = [params.get('shared_url'), params.get('shared_text'), params.get('shared_title')];
  for (const c of candidates) {
    if (!c) continue;
    const m = c.match(/https?:\/\/[^\s]+/);
    if (m) return m[0];
  }
  return '';
}
function guessSharedLinkField(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (host === 'youtube.com' || host === 'youtu.be' || host === 'music.youtube.com' || host === 'm.youtube.com') {
      return 'videoUrl';
    }
  } catch (e) { /* noop */ }
  return 'scoreSource';
}

async function loadData() {
  try {
    const v = await idbGet(STORAGE_KEY);
    if (!v) return emptyData();
    return { users: v.users || {}, songs: v.songs || {} };
  } catch (e) {
    return emptyData();
  }
}

async function saveData(data) {
  try {
    await idbSet(STORAGE_KEY, data);
  } catch (e) {
    console.error('保存に失敗しました', e);
  }
}

async function loadSession() {
  try {
    const v = await idbGet(SESSION_KEY);
    return v || null;
  } catch (e) {
    return null;
  }
}

async function saveSession(session) {
  try {
    await idbSet(SESSION_KEY, session);
  } catch (e) {
    console.error('セッション保存に失敗しました', e);
  }
}

function emptySongDraft() {
  return {
    title: '', titleKana: '', suiteGenre: '', suiteTitle: '', suiteTitleKana: '', suiteOrder: '',
    lyricist: '', composer: '', arranger: '',
    year: '', formation: '', formationOther: '', accompaniment: '',
    accompanimentOther: '', language: '', languageOther: '', videoUrl: '', scoreSource: '',
    tags: [], isPrivate: false,
    sungRecord: { concertName: '', date: '', place: '', choir: '', conductor: '', memo: '' },
  };
}

/* ---- スターターパック(運営があらかじめ用意する曲セット) ----
   開封すると、パックの曲プールからランダムでSTARTER_PACK_DRAW_COUNT曲(プールがそれ未満ならプール全体)
   が選ばれ、ガチャ演出のあとコレクションに追加できる。
   新しいパックを追加したい場合は、下のSTARTER_PACKS配列に新しいオブジェクトを追加するだけでよい
   (配列の先頭に置くと一覧の上に表示される)。1曲ずつ starterSong({...}) の形で曲情報を並べる。
   ここに入れる項目名は曲の登録フォームと同じ(title/lyricist/composer/formation/videoUrl など)。 */
function starterSong(overrides) {
  return { ...emptySongDraft(), ...overrides };
}

const STARTER_PACK_OPENED_KEY = 'chorusdb:starter-pack-opened'; // { [packId]: 最後に開封したtimestamp }
const STARTER_PACK_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 同じパックを再度開けるまでの時間(24時間)
const STARTER_PACK_DRAW_COUNT = 10; // 1回の開封で選ばれる曲数

function loadStarterPackOpenedMap() {
  try {
    const raw = localStorage.getItem(STARTER_PACK_OPENED_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}
function saveStarterPackOpenedAt(packId, timestamp) {
  try {
    const map = loadStarterPackOpenedMap();
    map[packId] = timestamp;
    localStorage.setItem(STARTER_PACK_OPENED_KEY, JSON.stringify(map));
  } catch (e) { /* noop */ }
}
// 残りクールダウン(ミリ秒)。0以下なら開封可能。
function getStarterPackCooldownRemaining(packId) {
  const map = loadStarterPackOpenedMap();
  const openedAt = map[packId];
  if (!openedAt) return 0;
  return Math.max(0, STARTER_PACK_COOLDOWN_MS - (Date.now() - openedAt));
}
function formatCooldown(ms) {
  const totalMin = Math.ceil(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `あと${h}時間${m}分`;
  return `あと${m}分`;
}
// パックの曲プールから、重複しないようSTARTER_PACK_DRAW_COUNT曲をランダムに選ぶ(Fisher-Yates)
function drawStarterPackSongs(pack) {
  const pool = [...pack.songs];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(STARTER_PACK_DRAW_COUNT, pool.length));
}

const STARTER_PACKS = [
  {
    id: 'starter-pack-vol1',
    name: 'スターターパックVol.1',
    description: '合唱の定番曲を中心に集めた100曲セットです。',
    songs: [
      starterSong({ title: '春に', suiteGenre: '混声合唱曲集', suiteTitle: '地平線のかなたへ', lyricist: '谷川俊太郎', composer: '木下牧子', year: '1992', formation: '混声', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/L_0H3wBgyCE?si=Zv0AsPTC4A8YsGDB', suiteOrder: 1 }),
      starterSong({ title: 'サッカーによせて', suiteGenre: '混声合唱曲集', suiteTitle: '地平線のかなたへ', lyricist: '谷川俊太郎', composer: '木下牧子', year: '1992', formation: '混声', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/FAyPSudXXZw?si=pHfKO5K_EfW0AtTg', suiteOrder: 2 }),
      starterSong({ title: '二十億光年の孤独', suiteGenre: '混声合唱曲集', suiteTitle: '地平線のかなたへ', lyricist: '谷川俊太郎', composer: '木下牧子', year: '1992', formation: '混声', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/vSy0FoM5N2s?si=FeGmTcn8_dAKDB65', suiteOrder: 3 }),
      starterSong({ title: '卒業式', suiteGenre: '混声合唱曲集', suiteTitle: '地平線のかなたへ', lyricist: '谷川俊太郎', composer: '木下牧子', year: '1992', formation: '混声', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/UzD-vJm0_Rg?si=10oFTiCgZrHidQie', suiteOrder: 4 }),
      starterSong({ title: 'ネロ-愛された小さな犬に', suiteGenre: '混声合唱曲集', suiteTitle: '地平線のかなたへ', lyricist: '谷川俊太郎', composer: '木下牧子', year: '1992', formation: '混声', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/bbkS-HDiUFY?si=Bc5Gmpap6vI3MKc3', suiteOrder: 5 }),
      starterSong({ title: '鴎', lyricist: '三好達治', composer: '木下牧子', formation: '混声', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/OwD8Yt-zeHs?si=nKnLWONfQI1WyxwQ' }),
      starterSong({ title: '夢みたものは', lyricist: '立原道造', composer: '木下牧子', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/F9DRLEbbAd4?si=ij_4ZfNhdXCaprkS' }),
      starterSong({ title: '聞こえる', lyricist: '岩間芳樹', composer: '新実徳英', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/1tS5O9Co1UQ?si=qE6Rps7q7NJpOSgq' }),
      starterSong({ title: 'ぜんぶ', suiteGenre: 'さくらももこの詩による無伴奏混声合唱曲集', suiteTitle: 'ぜんぶ ここに', lyricist: 'さくらももこ', composer: '相澤直人', formation: '混声', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/gDS862u8nZg?si=vB_ZWZ_RUMQ9h-pu', suiteOrder: 11 }),
      starterSong({ title: '雨', suiteGenre: '混声合唱組曲', suiteTitle: '水のいのち', lyricist: '高野喜久雄', composer: '高田三郎', year: '1964', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/wDSW0pETx0c?si=4l2DdtxQrhXZEn9N', suiteOrder: 1 }),
      starterSong({ title: '水たまり', suiteGenre: '混声合唱組曲', suiteTitle: '水のいのち', lyricist: '高野喜久雄', composer: '高田三郎', year: '1964', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/JkMnbpA2K3Q?si=l7wJXfbqxqlXXnxn', suiteOrder: 2 }),
      starterSong({ title: '川', suiteGenre: '混声合唱組曲', suiteTitle: '水のいのち', lyricist: '高野喜久雄', composer: '高田三郎', year: '1964', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/dyvdd9wUy5M?si=Grma1AYabVzYNpW2', suiteOrder: 3 }),
      starterSong({ title: '海', suiteGenre: '混声合唱組曲', suiteTitle: '水のいのち', lyricist: '高野喜久雄', composer: '高田三郎', year: '1964', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/lAlMC0YSIN4?si=a0GAgjvofesLY8lQ', suiteOrder: 4 }),
      starterSong({ title: '海よ', suiteGenre: '混声合唱組曲', suiteTitle: '水のいのち', lyricist: '高野喜久雄', composer: '高田三郎', year: '1964', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/GjV5eBa64iM?si=WWyOpkr4f-JHloed', suiteOrder: 5 }),
      starterSong({ title: '河口', suiteGenre: '混声合唱組曲', suiteTitle: '筑後川', lyricist: '丸山豊', composer: '團伊玖磨', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/RZele9k6bhg?si=EA10j1AzXSf5MjUC' }),
      starterSong({ title: '蔵王讃歌', suiteGenre: '混声合唱組曲', suiteTitle: '蔵王', lyricist: '尾崎左永子', composer: '佐藤眞', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/ukZr2BcrCnw?si=0EXVAQbQ8HYn5e9-', suiteOrder: 1 }),
      starterSong({ title: '風に', titleKana: 'かぜに', suiteGenre: '八戸東高等学校創立90周年記念歌', lyricist: '宇藤敬子', composer: '伊藤千蔵', formation: '女声', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/WyK3WrwzLDI?si=kUlvpediNcyPljc9' }),
      starterSong({ title: 'ひらく', suiteGenre: '混声合唱曲', suiteTitle: '季節へのまなざし', lyricist: '伊藤海彦', composer: '荻久保和明', year: '1978', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/upJwiacWBhM?si=j4WS_we64s3dO18K', suiteOrder: 1 }),
      starterSong({ title: 'のびる', suiteGenre: '混声合唱曲', suiteTitle: '季節へのまなざし', lyricist: '伊藤海彦', composer: '荻久保和明', year: '1978', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/uBpfasD9dyQ?si=MPdNS44tVqd1DAUA', suiteOrder: 2 }),
      starterSong({ title: 'みのる', suiteGenre: '混声合唱曲', suiteTitle: '季節へのまなざし', lyricist: '伊藤海彦', composer: '荻久保和明', year: '1978', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/cFhzONInRGc?si=dBqvz6Jm12XsbnkX', suiteOrder: 3 }),
      starterSong({ title: 'ゆめみる', suiteGenre: '混声合唱曲', suiteTitle: '季節へのまなざし', lyricist: '伊藤海彦', composer: '荻久保和明', year: '1978', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/67M29rQzmQs?si=ZWizsS5WnTTXVsC0', suiteOrder: 4 }),
      starterSong({ title: 'よろこび', suiteGenre: '混声合唱組曲', suiteTitle: '小さないのち', lyricist: 'みずかみかずよ', composer: '荻久保和明', year: '2011', formation: '混声四部', accompaniment: 'アカペラ', language: '日本語', videoUrl: 'https://youtu.be/8DikIvxci_8?si=l3nuFG7EiywrJUSc', scoreSource: 'https://store.kyogei.co.jp/products/detail/523', suiteOrder: 1 }),
      starterSong({ title: 'いのち', suiteGenre: '混声合唱組曲', suiteTitle: '小さないのち', lyricist: 'みずかみかずよ', composer: '荻久保和明', year: '2011', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', scoreSource: 'https://store.kyogei.co.jp/products/detail/523', suiteOrder: 2 }),
      starterSong({ title: 'たとえば・・・・・・', suiteGenre: '混声合唱組曲', suiteTitle: '小さないのち', lyricist: 'みずかみかずよ', composer: '荻久保和明', year: '2011', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', scoreSource: 'https://store.kyogei.co.jp/products/detail/523', suiteOrder: 3 }),
      starterSong({ title: '夜の雪', suiteGenre: '混声合唱組曲', suiteTitle: '小さないのち', lyricist: 'みずかみかずよ', composer: '荻久保和明', year: '2011', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', scoreSource: 'https://store.kyogei.co.jp/products/detail/523', suiteOrder: 4 }),
      starterSong({ title: '小さないのち', suiteGenre: '混声合唱組曲', suiteTitle: '小さないのち', lyricist: 'みずかみかずよ', composer: '荻久保和明', year: '2011', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://store.kyogei.co.jp/products/detail/523', suiteOrder: 5 }),
      starterSong({ title: '風に寄せて　その１', suiteGenre: '混声合唱組曲', suiteTitle: '風に寄せて［改定新版］', lyricist: '立原道造', composer: '尾形敏幸', year: '2025', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/asBzxwbuZ0Q?si=-_PY1paybGxprZEA', scoreSource: 'https://www.ongakunotomo.co.jp/catalog/detail.php?id=546050', suiteOrder: 1 }),
      starterSong({ title: '風に寄せて　その２', suiteGenre: '混声合唱組曲', suiteTitle: '風に寄せて［改定新版］', lyricist: '立原道造', composer: '尾形敏幸', year: '2025', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/Fcr37902AmA?si=IDuMZhZIu9Zct6Em', scoreSource: 'https://www.ongakunotomo.co.jp/catalog/detail.php?id=546051', suiteOrder: 2 }),
      starterSong({ title: '風に寄せて　その５', suiteGenre: '混声合唱組曲', suiteTitle: '風に寄せて［改定新版］', lyricist: '立原道造', composer: '尾形敏幸', year: '2025', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/2aIEfMm9xpE?si=6QZxNGiIHX4DIXaH', scoreSource: 'https://www.ongakunotomo.co.jp/catalog/detail.php?id=546052', suiteOrder: 3 }),
      starterSong({ title: '風の子守歌', suiteGenre: '混声合唱曲集', suiteTitle: '六つの子守歌', lyricist: '別役実', composer: '池辺晋一郎', year: '1973', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/xi-o4Ukn5pM?si=SZ70vHZXsfOAm9WE', scoreSource: 'https://www.editionkawai.jp/item/detail/91029/', suiteOrder: 1 }),
      starterSong({ title: '空と海の子守歌', suiteGenre: '混声合唱曲集', suiteTitle: '六つの子守歌', lyricist: '別役実', composer: '池辺晋一郎', year: '1973', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/_3vy8cMEk8o?si=qZkUdTIIKyu0eqoT', scoreSource: 'https://www.editionkawai.jp/item/detail/91029/', suiteOrder: 2 }),
      starterSong({ title: 'いつもの子守歌', suiteGenre: '混声合唱曲集', suiteTitle: '六つの子守歌', lyricist: '別役実', composer: '池辺晋一郎', year: '1973', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/0iPh7-JTrFc?si=jWDdzmrgErVdRoTO', scoreSource: 'https://www.editionkawai.jp/item/detail/91029/', suiteOrder: 3 }),
      starterSong({ title: '思い出の子守歌', suiteGenre: '混声合唱曲集', suiteTitle: '六つの子守歌', lyricist: '別役実', composer: '池辺晋一郎', year: '1973', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/2uGW3BtndvQ?si=qzVVwaHxcT0oOfVk', scoreSource: 'https://www.editionkawai.jp/item/detail/91029/', suiteOrder: 4 }),
      starterSong({ title: 'おさかなの子守歌', suiteGenre: '混声合唱曲集', suiteTitle: '六つの子守歌', lyricist: '別役実', composer: '池辺晋一郎', year: '1973', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/UcXf-Y_6J6I?si=TJ3j2eXDfxQp7srX', scoreSource: 'https://www.editionkawai.jp/item/detail/91029/', suiteOrder: 5 }),
      starterSong({ title: '眠っちゃいけない子守歌', suiteGenre: '混声合唱曲集', suiteTitle: '六つの子守歌', lyricist: '別役実', composer: '池辺晋一郎', year: '1973', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/mdGI-fKskPM?si=pRcuf8uUpx_cyrgZ', scoreSource: 'https://www.editionkawai.jp/item/detail/91029/', suiteOrder: 6 }),
      starterSong({ title: '光よ　そして緑', suiteGenre: '混声合唱曲集', suiteTitle: '終わりのない歌', lyricist: '銀色夏生', composer: '上田真樹', year: '2017', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/C3ynwlBz778?si=O3o44Dp3POx5syLG', suiteOrder: 1 }),
      starterSong({ title: '月の夜', suiteGenre: '混声合唱曲集', suiteTitle: '終わりのない歌', lyricist: '銀色夏生', composer: '上田真樹', year: '2017', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/e6jaWCByKJo?si=RDg5Ik_GSa6auleZ', suiteOrder: 2 }),
      starterSong({ title: '強い感情が僕を襲った', suiteGenre: '混声合唱曲集', suiteTitle: '終わりのない歌', lyricist: '銀色夏生', composer: '上田真樹', year: '2017', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', suiteOrder: 3 }),
      starterSong({ title: '終わりのない歌', suiteGenre: '混声合唱曲集', suiteTitle: '終わりのない歌', lyricist: '銀色夏生', composer: '上田真樹', year: '2017', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/9GBTcJUMJMM?si=qVvMG6jzxXBLZ_q5', suiteOrder: 4 }),
      starterSong({ title: '君のそばで会おう', suiteGenre: '混声合唱曲集', suiteTitle: '終わりのない歌', lyricist: '銀色夏生', composer: '上田真樹', year: '2017', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/ZqhdErUixhE?si=nPFWWMU_usKiFCpt', suiteOrder: 5 }),
      starterSong({ title: 'あなたのことを', suiteGenre: '混声合唱のための', lyricist: '銀色夏生', composer: '上田真樹', year: '2017', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/O8VrMf82Hxg?si=ft8fg4ujLSbhBNO6' }),
      starterSong({ title: '再会', suiteGenre: '混声合唱組曲', suiteTitle: '光る砂漠', lyricist: '矢澤宰', composer: '萩原英彦', year: '1971', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/hHtD6qqnWpo?si=4E6IOFUtz0V5x-8e', suiteOrder: 1 }),
      starterSong({ title: '恋の詩でも読んだあとのように', suiteGenre: '混声合唱組曲', suiteTitle: '光る砂漠', lyricist: '矢澤宰', composer: '萩原英彦', year: '1971', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/VFJXzlqThXA?si=c8oFomX4z-9JnecV', suiteOrder: 2 }),
      starterSong({ title: '早春', suiteGenre: '混声合唱組曲', suiteTitle: '光る砂漠', lyricist: '矢澤宰', composer: '萩原英彦', year: '1971', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/lg_yas3rF-o?si=NAQFBz8JFmyT2lcU', suiteOrder: 3 }),
      starterSong({ title: '海辺で', suiteGenre: '混声合唱組曲', suiteTitle: '光る砂漠', lyricist: '矢澤宰', composer: '萩原英彦', year: '1971', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/lWtQH17hr38?si=dDv5HQ8SWiJaqEcZ', suiteOrder: 4 }),
      starterSong({ title: 'ほたるは星になった', suiteGenre: '混声合唱組曲', suiteTitle: '光る砂漠', lyricist: '矢澤宰', composer: '萩原英彦', year: '1971', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/skJpjHrvBr8?si=QgSDvtbwEzHyXwHE', suiteOrder: 5 }),
      starterSong({ title: '落石', suiteGenre: '混声合唱組曲', suiteTitle: '光る砂漠', lyricist: '矢澤宰', composer: '萩原英彦', year: '1971', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/QJpeTGNgvtI?si=4vF-NXErc7zh3BNL', suiteOrder: 6 }),
      starterSong({ title: '秋の午後', suiteGenre: '混声合唱組曲', suiteTitle: '光る砂漠', lyricist: '矢澤宰', composer: '萩原英彦', year: '1971', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/8Hy_dTJpq4s?si=GxNwgLgNmBAEi9FU', suiteOrder: 7 }),
      starterSong({ title: 'さびしい道', suiteGenre: '混声合唱組曲', suiteTitle: '光る砂漠', lyricist: '矢澤宰', composer: '萩原英彦', year: '1971', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/AzeEgI1lJJ4?si=CXLwRjubBOemM0YJ', suiteOrder: 8 }),
      starterSong({ title: 'ふるさと', suiteGenre: '混声合唱組曲', suiteTitle: '光る砂漠', lyricist: '矢澤宰', composer: '萩原英彦', year: '1971', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/uEpuMxvtJdY?si=r4ATnCaJiF7vVWIQ', suiteOrder: 9 }),
      starterSong({ title: 'たんぽぽ', suiteGenre: '混声合唱とピアノのための', suiteTitle: '花に寄せて', lyricist: '星野富弘', composer: '新実徳英', year: '1986', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/ZTt4VtjzdEo?si=rv6-i54dVgRAgpT2', suiteOrder: 1 }),
      starterSong({ title: 'ねこじゃらし', suiteGenre: '混声合唱とピアノのための', suiteTitle: '花に寄せて', lyricist: '星野富弘', composer: '新実徳英', year: '1986', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/n9F5smpxRYc?si=ExuiZIXgk9UKnF7y', suiteOrder: 2 }),
      starterSong({ title: 'しおん', suiteGenre: '混声合唱とピアノのための', suiteTitle: '花に寄せて', lyricist: '星野富弘', composer: '新実徳英', year: '1986', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/KVjgwWGoxRI?si=kTpjWk2MYXD8EH1T', suiteOrder: 3 }),
      starterSong({ title: 'つばき・やぶかんぞう・あさがお', suiteGenre: '混声合唱とピアノのための', suiteTitle: '花に寄せて', lyricist: '星野富弘', composer: '新実徳英', year: '1986', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/gKIz8Cigo78?si=7cxQshlqRGjTywOp', suiteOrder: 4 }),
      starterSong({ title: 'てっせん・どくだみ', suiteGenre: '混声合唱とピアノのための', suiteTitle: '花に寄せて', lyricist: '星野富弘', composer: '新実徳英', year: '1986', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/u2FfAIef1jM?si=fvrX6I3W8vqtNnOh', suiteOrder: 5 }),
      starterSong({ title: 'みょうが', suiteGenre: '混声合唱とピアノのための', suiteTitle: '花に寄せて', lyricist: '星野富弘', composer: '新実徳英', year: '1986', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/GrDgC3fAYQk?si=5A_teHKsB6il6Yqi', suiteOrder: 6 }),
      starterSong({ title: 'ばら・きく・なずな－母に捧ぐ－', suiteGenre: '混声合唱とピアノのための', suiteTitle: '花に寄せて', lyricist: '星野富弘', composer: '新実徳英', year: '1986', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/7y3IgHTAJWE?si=491hhbW5445OJbmA', suiteOrder: 7 }),
      starterSong({ title: '島よ', suiteGenre: '混声合唱組曲', suiteTitle: '島よ', lyricist: '伊藤海彦', composer: '大中恩', year: '1970', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/QTD5fvecCHw?si=eSRHtG4ERybB1Ge4', suiteOrder: 1 }),
      starterSong({ title: '岬の墓', suiteGenre: '混声合唱曲', suiteTitle: '岬の墓', lyricist: '堀田善衛', composer: '團伊玖磨', year: '1963', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/s26zTVH--O4?si=MBVekujM7LdVEM9y', suiteOrder: 1 }),
      starterSong({ title: 'みなかみ', suiteGenre: '混声合唱組曲', suiteTitle: '筑後川', lyricist: '丸山豊', composer: '團伊玖磨', year: '1968', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/AWw7oNOkQLs?si=ydK27eu-7Hg4CuWM', suiteOrder: 1 }),
      starterSong({ title: 'ダムにて', suiteGenre: '混声合唱組曲', suiteTitle: '筑後川', lyricist: '丸山豊', composer: '團伊玖磨', year: '1968', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/2RPUDz2k6gU?si=d6axzN56m-7Uh5lS', suiteOrder: 2 }),
      starterSong({ title: '銀の魚', suiteGenre: '混声合唱組曲', suiteTitle: '筑後川', lyricist: '丸山豊', composer: '團伊玖磨', year: '1968', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/hOyN0Wq8zWE?si=tRFMsqJwpHCv-xhV', suiteOrder: 3 }),
      starterSong({ title: '川の祭', suiteGenre: '混声合唱組曲', suiteTitle: '筑後川', lyricist: '丸山豊', composer: '團伊玖磨', year: '1968', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/7cQ8-jSiamg?si=Z9asCPAF9hlt93Ig', suiteOrder: 4 }),
      starterSong({ title: '蔵王讃歌', suiteGenre: '混声合唱のための組曲', suiteTitle: '蔵王　[改訂新版]', lyricist: '尾崎左永子', composer: '佐藤眞', year: '1961', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/iZEiIQ5T7GM?si=t6XwSn7WazgsFg63', suiteOrder: 1 }),
      starterSong({ title: '投げよう林檎を', suiteGenre: '混声合唱のための組曲', suiteTitle: '蔵王　[改訂新版]', lyricist: '尾崎左永子', composer: '佐藤眞', year: '1961', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/E7FQmktGR7A?si=ZEArL4dbo8EiV--s', suiteOrder: 2 }),
      starterSong({ title: '苔の花', suiteGenre: '混声合唱のための組曲', suiteTitle: '蔵王　[改訂新版]', lyricist: '尾崎左永子', composer: '佐藤眞', year: '1961', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/uED3r5bkA2U?si=t5i6Bx2GvgYweAKd', suiteOrder: 3 }),
      starterSong({ title: 'どっこ沼', suiteGenre: '混声合唱のための組曲', suiteTitle: '蔵王　[改訂新版]', lyricist: '尾崎左永子', composer: '佐藤眞', year: '1961', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/X8ct92_-sk0?si=2gaWepmaOstBdwsu', suiteOrder: 4 }),
      starterSong({ title: 'おはなし', suiteGenre: '混声合唱のための組曲', suiteTitle: '蔵王　[改訂新版]', lyricist: '尾崎左永子', composer: '佐藤眞', year: '1961', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/2SK4MNVq-Sw?si=PPTBez0j-j6oASh6', suiteOrder: 5 }),
      starterSong({ title: '雪むすめ', suiteGenre: '混声合唱のための組曲', suiteTitle: '蔵王　[改訂新版]', lyricist: '尾崎左永子', composer: '佐藤眞', year: '1961', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/KqfTp1562P4?si=KZ7Yfj5mPl4Xmi6A', suiteOrder: 6 }),
      starterSong({ title: '吹雪', suiteGenre: '混声合唱のための組曲', suiteTitle: '蔵王　[改訂新版]', lyricist: '尾崎左永子', composer: '佐藤眞', year: '1961', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/TZ1KZiNJq84?si=5z1drqnYXh2PPVK2', suiteOrder: 7 }),
      starterSong({ title: '樹氷林', suiteGenre: '混声合唱のための組曲', suiteTitle: '蔵王　[改訂新版]', lyricist: '尾崎左永子', composer: '佐藤眞', year: '1961', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/NMmw1uASy8k?si=r2eDLlPBk0ddn34T', suiteOrder: 8 }),
      starterSong({ title: '早春', suiteGenre: '混声合唱のための組曲', suiteTitle: '蔵王　[改訂新版]', lyricist: '尾崎左永子', composer: '佐藤眞', year: '1961', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/R63D3TeZyls?si=zYg4eDu1S9BqaIiN', suiteOrder: 9 }),
      starterSong({ title: '木とともに　人とともに', suiteGenre: '混声合唱曲集', suiteTitle: '木とともに　人とともに', lyricist: '谷川俊太郎', composer: '三善晃', year: '1999', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/kCQKmGlC4V0?si=vLxTmG3_1Qge_hiu', suiteOrder: 1 }),
      starterSong({ title: '空', suiteGenre: '混声合唱曲集', suiteTitle: '木とともに　人とともに', lyricist: '谷川俊太郎', composer: '三善晃', year: '1999', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/-WnLgAcgYC0?si=yH8zNlfGfPFlNEYw', suiteOrder: 2 }),
      starterSong({ title: '生きる', suiteGenre: '混声合唱曲集', suiteTitle: '木とともに　人とともに', lyricist: '谷川俊太郎', composer: '三善晃', year: '1999', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/tXCRpzfe37w?si=be8GSZvdsNSeEo5O', suiteOrder: 3 }),
      starterSong({ title: '遠くに', suiteGenre: '混声合唱とピアノのための', suiteTitle: '音楽のとき～6つのワルツ', lyricist: '川崎洋', composer: '新実徳英', year: '2000', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', suiteOrder: 1 }),
      starterSong({ title: 'ギターを抱いて', suiteGenre: '混声合唱とピアノのための', suiteTitle: '音楽のとき～6つのワルツ', lyricist: '川崎洋', composer: '新実徳英', year: '2000', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', suiteOrder: 2 }),
      starterSong({ title: '都合のいい哲学', suiteGenre: '混声合唱とピアノのための', suiteTitle: '音楽のとき～6つのワルツ', lyricist: '川崎洋', composer: '新実徳英', year: '2000', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', suiteOrder: 3 }),
      starterSong({ title: '鳥と', suiteGenre: '混声合唱とピアノのための', suiteTitle: '音楽のとき～6つのワルツ', lyricist: '川崎洋', composer: '新実徳英', year: '2000', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', suiteOrder: 4 }),
      starterSong({ title: '自分の声を', suiteGenre: '混声合唱とピアノのための', suiteTitle: '音楽のとき～6つのワルツ', lyricist: '川崎洋', composer: '新実徳英', year: '2000', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', suiteOrder: 5 }),
      starterSong({ title: '雀のさえずりも', suiteGenre: '混声合唱とピアノのための', suiteTitle: '音楽のとき～6つのワルツ', lyricist: '川崎洋', composer: '新実徳英', year: '2000', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', suiteOrder: 6 }),
      starterSong({ title: '草の夜', suiteGenre: '混声合唱組曲', suiteTitle: '五月を送るうた', lyricist: '中井英夫', composer: '松下功', year: '1989', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/95-spvdrLv8?si=hyHxMoUV6CSZfbo_' }),
      starterSong({ title: '薔薇に寄す', suiteGenre: '混声合唱組曲', suiteTitle: '五月を送るうた', lyricist: '中井英夫', composer: '松下功', year: '1989', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/FfK2ZltyPdo?si=sY-aZ1zbXOIgp1Wk' }),
      starterSong({ title: '旅立ち', suiteGenre: '混声合唱組曲', suiteTitle: '五月を送るうた', lyricist: '中井英夫', composer: '松下功', year: '1989', formation: '混声四部', accompaniment: 'アカペラ', language: '日本語', videoUrl: 'https://youtu.be/TpAFw-pHueQ?si=89VOdRp7XiE-O5kv' }),
      starterSong({ title: '小犬と蛇', suiteGenre: '混声合唱組曲', suiteTitle: '五月を送るうた', lyricist: '中井英夫', composer: '松下功', year: '1989', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語' }),
      starterSong({ title: '月との喧嘩', suiteGenre: '混声合唱組曲', suiteTitle: '五月を送るうた', lyricist: '中井英夫', composer: '松下功', year: '1989', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/0ipNFpjx_T4?si=EB5RMcMXtS9RI_EJ' }),
      starterSong({ title: 'くりや風物', suiteGenre: '混声合唱組曲', suiteTitle: '五月を送るうた', lyricist: '中井英夫', composer: '松下功', year: '1989', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語' }),
      starterSong({ title: '古い館の詩', suiteGenre: '混声合唱組曲', suiteTitle: '五月を送るうた', lyricist: '中井英夫', composer: '松下功', year: '1989', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/wesKIERtEFQ?si=NJd8GpamVfsT0I5J' }),
      starterSong({ title: '五月の入口', suiteGenre: '混声合唱組曲', suiteTitle: '五月を送るうた', lyricist: '中井英夫', composer: '松下功', year: '1989', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/Oqi6bZFvj0E?si=dEAYzvPFw3YxqIHq' }),
      starterSong({ title: '海と蝶', suiteGenre: '混声合唱組曲', suiteTitle: '海の構図', lyricist: '小林純一', composer: '中田喜直', year: '1964', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/9MX5E8KuSZA?si=9yEKOlu-cR1MTb7o' }),
      starterSong({ title: '海女礼讃', suiteGenre: '混声合唱組曲', suiteTitle: '海の構図', lyricist: '小林純一', composer: '中田喜直', year: '1964', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語' }),
      starterSong({ title: 'かもめの歌', suiteGenre: '混声合唱組曲', suiteTitle: '海の構図', lyricist: '小林純一', composer: '中田喜直', year: '1964', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語' }),
      starterSong({ title: '神話の巨人', suiteGenre: '混声合唱組曲', suiteTitle: '海の構図', lyricist: '小林純一', composer: '中田喜直', year: '1964', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語' }),
      starterSong({ title: '風が', suiteGenre: '混声合唱組曲', suiteTitle: '心の四季', lyricist: '吉野弘', composer: '高田三郎', year: '1967', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/TyRg445o1M0?si=jBr8_IoTnnZCz0gJ' }),
      starterSong({ title: 'みずすまし', suiteGenre: '混声合唱組曲', suiteTitle: '心の四季', lyricist: '吉野弘', composer: '高田三郎', year: '1967', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/NX3hyHmQ7lY?si=gGjMY88UZmAd5_Vn' }),
      starterSong({ title: '流れ', suiteGenre: '混声合唱組曲', suiteTitle: '心の四季', lyricist: '吉野弘', composer: '高田三郎', year: '1967', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/Y-YmCOsNA_E?si=UVsIrCkRX3DKJ0SN' }),
      starterSong({ title: '山が', suiteGenre: '混声合唱組曲', suiteTitle: '心の四季', lyricist: '吉野弘', composer: '高田三郎', year: '1967', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/fGmTmiJj4Zg?si=lQq7wsm93yUKXBE0' }),
      starterSong({ title: '愛そして風', suiteGenre: '混声合唱組曲', suiteTitle: '心の四季', lyricist: '吉野弘', composer: '高田三郎', year: '1967', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/MKLRv2Dk-kI?si=6xAWTQLDRhzuuyXM' }),
      starterSong({ title: '雪の日に', suiteGenre: '混声合唱組曲', suiteTitle: '心の四季', lyricist: '吉野弘', composer: '高田三郎', year: '1967', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/eNj-drdHP24?si=csdu7xqBY3D1O28Y' }),
      starterSong({ title: '真昼の星', suiteGenre: '混声合唱組曲', suiteTitle: '心の四季', lyricist: '吉野弘', composer: '高田三郎', year: '1967', formation: '混声四部', accompaniment: 'ピアノ', language: '日本語', videoUrl: 'https://youtu.be/BAKgzeCM_BQ?si=eIHG1LIKeiicryug' }),
    ],
  },
];

const SUNG_TAG_NAME = '歌ったことある';
function hasSungRecordContent(rec) {
  return !!rec && Object.values(rec).some((v) => (v || '').trim());
}

/* ---- 氏名の入力処理 ----
   姓・名をスペースで区別する仕組みは廃止。入力中の区切り用スペース(全角/半角)は
   保存時にすべて詰めて1つの表示名にする。アルファベットの場合、詰める際に単語の
   境目が分からなくならないよう、スペースの直後の文字がアルファベットなら大文字にする
   (例: "John smith" → "JohnSmith"、"谷川 俊太郎" → "谷川俊太郎")。 */
function mergeName(raw) {
  if (!raw) return '';
  const parts = raw.split(/[\u3000\s]+/).filter(Boolean);
  if (parts.length === 0) return '';
  return parts
    .map((part, i) => {
      if (i === 0) return part;
      const first = part.charAt(0);
      if (/[a-zA-Z]/.test(first)) return first.toUpperCase() + part.slice(1);
      return part;
    })
    .join('');
}

/* ---- クリップボードコピー(APIが使えない環境向けのフォールバック付き) ---- */

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext !== false) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    throw new Error('clipboard API unavailable');
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e2) {
      return false;
    }
  }
}

/* ---- モデレーション(通報・擁護・凍結・ブロック) ---- */

const REPORT_THRESHOLD = 10;
const REPORT_REASONS = ['内容と関係のない動画', 'スパム・宣伝', 'なりすまし', '不適切な内容', 'その他'];

function reportScore(user) {
  return Math.max(0, (user.reportedBy || []).length - (user.vouchedBy || []).length);
}

function isBlockedEitherWay(meUser, otherId, usersById) {
  const other = usersById[otherId];
  if (!other) return false;
  return (meUser.blockedIds || []).includes(otherId) || (other.blockedIds || []).includes(meUser.userId);
}

/* ---- 年齢表示 ---- */

function computeAge(birthDate) {
  if (!birthDate) return null;
  const b = new Date(birthDate);
  if (Number.isNaN(b.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
  return age >= 0 ? age : null;
}

function ageLabel(user) {
  if (!user || user.ageDisplay === 'hidden' || !user.ageDisplay) return null;
  const age = computeAge(user.birthDate);
  if (age === null) return null;
  if (user.ageDisplay === 'decade') return `${Math.floor(age / 10) * 10}代`;
  return `${age}歳`;
}

/* ---- プロフィール画像のリサイズ(容量を抑えるため正方形・縮小してJPEGに) ---- */

function resizeImageFile(file, maxSize = 200, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('読み込みに失敗しました'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('画像を読み込めませんでした'));
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        const canvas = document.createElement('canvas');
        canvas.width = maxSize;
        canvas.height = maxSize;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, sx, sy, side, side, 0, 0, maxSize, maxSize);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ---- プロフィールAI画像(プレースホルダー) ----
   実際の画像生成AIへの接続はまだ無いため、今は「テスト1」「テスト2」の
   仮アバターをcanvasでその場生成して候補として提示する。 */

const AVATAR_PALETTE = [
  { bg: '#7A2E2E', fg: '#F3EEE1' }, { bg: '#2B4C6F', fg: '#EFF1F0' },
  { bg: '#B95C6B', fg: '#FBF1F0' }, { bg: '#4F6B3A', fg: '#F1F3E9' },
  { bg: '#1F6E7A', fg: '#EAF1F2' }, { bg: '#6A3E7A', fg: '#F0EBF1' },
  { bg: '#A9722C', fg: '#F6EEDD' }, { bg: '#54595F', fg: '#F7F7F5' },
];

function randomPaletteColor() {
  return AVATAR_PALETTE[Math.floor(Math.random() * AVATAR_PALETTE.length)];
}

function renderPlaceholderAvatar(label, color) {
  const size = 200;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color.bg;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color.fg;
  ctx.font = '600 34px "Zen Kaku Gothic New", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, size / 2, size / 2 + 2);
  return canvas.toDataURL('image/png');
}

function Field({ label, required, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{
        display: 'flex', alignItems: 'center', gap: 6, fontSize: 13,
        color: 'var(--ink-soft)', marginBottom: 6, fontFamily: 'var(--font-body)',
      }}>
        {label}
        {required && (
          <span style={{
            fontSize: 10, background: 'var(--wine-soft)', color: 'var(--wine)',
            padding: '1px 6px', borderRadius: 3, fontWeight: 600,
          }}>必須</span>
        )}
      </label>
      {children}
    </div>
  );
}

const inputStyle = {
  width: '100%', boxSizing: 'border-box', padding: '9px 11px',
  border: '1px solid var(--line)', borderRadius: 'var(--radius-control, 6px)', fontSize: 14,
  fontFamily: 'var(--font-body)', color: 'var(--ink)', background: 'var(--surface, #fff)',
  outline: 'none',
};

const TextInput = React.forwardRef(function TextInput(props, ref) {
  return <input ref={ref} {...props} style={{ ...inputStyle, ...(props.style || {}) }} />;
});

function TextArea(props) {
  return <textarea {...props} style={{ ...inputStyle, resize: 'vertical', minHeight: 60, ...(props.style || {}) }} />;
}

const SEED_LYRICISTS = ['谷川俊太郎', '高野喜久雄', '大木惇夫', '三好達治', '萩原朔太郎', '宮沢賢治'];
const SEED_COMPOSERS = ['三善晃', '信長貴富', '木下牧子', '新実徳英', '荻久保和明', '鈴木輝昭', '千原英喜'];

// 作詩・作曲などの入力候補(プルダウン)を、優先順位1「最近使ったものが上位」→
// 優先順位2「登録件数が多いものが上位」の順に並べて返す。
// seedはデータが少ない最初のうちの候補で、実際に使われたことがなければ一覧の末尾に回る。
function buildNameSuggestions(songs, field, seed = []) {
  const stats = new Map(); // name -> { count, lastAt }
  songs.forEach((s) => {
    const name = (s[field] || '').trim();
    if (!name) return;
    const at = s.updatedAt || s.createdAt || 0;
    const cur = stats.get(name);
    if (cur) {
      cur.count += 1;
      if (at > cur.lastAt) cur.lastAt = at;
    } else {
      stats.set(name, { count: 1, lastAt: at });
    }
  });
  seed.forEach((name) => {
    if (!stats.has(name)) stats.set(name, { count: 0, lastAt: 0 });
  });
  return Array.from(stats.entries())
    .sort((a, b) => (b[1].lastAt - a[1].lastAt) || (b[1].count - a[1].count))
    .map(([name]) => name);
}
const SEED_ARRANGERS = ['信長貴富', '瑞木薫', '弓削田健介'];

function SuggestInput({ value, onChange, suggestions = [], placeholder, style }) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);

  const q = value.trim().toLowerCase();
  // 何も入力していない時は、候補(すでに「最近使った順→登録件数が多い順」に並んでいる)を
  // そのまま一覧表示できるようにする(入力せずにプルダウンから選べるようにしたいという要望のため)。
  // 入力中は絞り込んだ候補を表示する。
  const matches = q
    ? suggestions.filter((s) => s.toLowerCase().includes(q) && s !== value).slice(0, 6)
    : suggestions.slice(0, 12);

  const selectItem = (item) => {
    onChange(item);
    setOpen(false);
    setHighlight(-1);
  };

  return (
    <div style={{ position: 'relative' }}>
      <TextInput
        style={style}
        value={value}
        placeholder={placeholder}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setHighlight(-1); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (!open || matches.length === 0) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, matches.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
          else if (e.key === 'Enter' && highlight >= 0) { e.preventDefault(); selectItem(matches[highlight]); }
          else if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && matches.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 40, background: 'var(--surface, #fff)',
          border: '1px solid var(--line)', borderRadius: 8, marginTop: 4,
          boxShadow: '0 8px 20px rgba(0,0,0,.12)', overflow: 'hidden',
        }}>
          {matches.map((m, i) => (
            <div
              key={m}
              onMouseDown={(e) => { e.preventDefault(); selectItem(m); }}
              style={{
                padding: '8px 12px', fontSize: 13, cursor: 'pointer',
                background: i === highlight ? 'var(--paper)' : '#fff',
              }}
            >
              {m}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NameField({ label, required, value, onChange, placeholder, suggestions = [] }) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);

  const q = value.trim().toLowerCase();
  // 何も入力していない時は、候補(すでに「最近使った順→登録件数が多い順」に並んでいる)を
  // そのまま一覧表示できるようにする(入力せずにプルダウンから選べるようにしたいという要望のため)。
  // 入力中は絞り込んだ候補を表示する。
  const matches = q
    ? suggestions.filter((s) => s.toLowerCase().includes(q) && s !== value).slice(0, 6)
    : suggestions.slice(0, 12);

  const selectItem = (item) => {
    onChange(item);
    setOpen(false);
    setHighlight(-1);
  };

  return (
    <Field label={label} required={required}>
      <div style={{ position: 'relative' }}>
        <TextInput
          value={value}
          onChange={(e) => { onChange(e.target.value); setOpen(true); setHighlight(-1); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (!open || matches.length === 0) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, matches.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
            else if (e.key === 'Enter' && highlight >= 0) { e.preventDefault(); selectItem(matches[highlight]); }
            else if (e.key === 'Escape') setOpen(false);
          }}
          placeholder={placeholder}
        />
        {open && matches.length > 0 && (
          <div style={{
            position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 40, background: 'var(--surface, #fff)',
            border: '1px solid var(--line)', borderRadius: 8, marginTop: 4,
            boxShadow: '0 8px 20px rgba(0,0,0,.12)', overflow: 'hidden',
          }}>
            {matches.map((m, i) => (
              <div
                key={m}
                onMouseDown={(e) => { e.preventDefault(); selectItem(m); }}
                style={{
                  padding: '8px 12px', fontSize: 13, cursor: 'pointer',
                  background: i === highlight ? 'var(--paper)' : '#fff',
                }}
              >
                {m}
              </div>
            ))}
          </div>
        )}
      </div>
    </Field>
  );
}

function SelectWithOther({ value, other, onChange, onOtherChange, options, placeholder }) {
  return (
    <div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...inputStyle, appearance: 'none' }}
      >
        <option value="">{placeholder}</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      {value === 'その他' && (
        <TextInput
          style={{ marginTop: 8 }}
          placeholder="自由入力"
          value={other}
          onChange={(e) => onOtherChange(e.target.value)}
        />
      )}
    </div>
  );
}

function ToggleSwitch({ checked, onChange, leftLabel, rightLabel }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
      <span style={{ fontSize: 12.5, fontWeight: checked ? 400 : 700, color: checked ? 'var(--ink-soft)' : 'var(--ink)' }}>
        {leftLabel}
      </span>
      <span
        onClick={() => onChange(!checked)}
        style={{
          position: 'relative', width: 40, height: 22, borderRadius: 12,
          background: checked ? 'var(--wine)' : 'var(--line)', transition: 'background .15s ease', flexShrink: 0,
        }}
      >
        <span style={{
          position: 'absolute', top: 2, left: checked ? 20 : 2, width: 18, height: 18, borderRadius: '50%',
          background: 'var(--surface, #fff)', boxShadow: '0 1px 3px rgba(0,0,0,.3)', transition: 'left .15s ease',
        }} />
      </span>
      <span style={{ fontSize: 12.5, fontWeight: checked ? 700 : 400, color: checked ? 'var(--ink)' : 'var(--ink-soft)' }}>
        {rightLabel}
      </span>
    </label>
  );
}

function Button({ children, onClick, variant = 'default', style, disabled, title }) {
  const variants = {
    default: { background: 'var(--surface, #fff)', color: 'var(--ink)', border: '1px solid var(--line)' },
    primary: { background: 'var(--wine)', color: '#fff', border: '1px solid var(--wine)' },
    quiet: { background: 'transparent', color: 'var(--ink-soft)', border: '1px solid transparent' },
    danger: { background: 'transparent', color: 'var(--danger, #9C3B2E)', border: '1px solid #E8CFC8' },
    gold: { background: 'var(--gold)', color: '#fff', border: '1px solid var(--gold)' },
    sage: { background: 'var(--sage)', color: '#fff', border: '1px solid var(--sage)' },
  };
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, cursor: disabled ? 'default' : 'pointer',
        fontSize: 13.5, fontFamily: 'var(--font-body)', fontWeight: 600, padding: '8px 14px',
        borderRadius: 'var(--radius-control, 6px)', opacity: disabled ? 0.5 : 1, transition: 'transform .08s ease',
        ...variants[variant], ...style,
      }}
      onMouseDown={(e) => { if (!disabled) e.currentTarget.style.transform = 'scale(0.97)'; }}
      onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
    >
      {children}
    </button>
  );
}

function Avatar({ name, size = 40, src }) {
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  if (src) {
    return (
      <img
        src={src} alt={name || ''} width={size} height={size}
        style={{ width: size, height: size, maxWidth: 'none', maxHeight: 'none', borderRadius: '50%', objectFit: 'cover', flexShrink: 0, border: '1px solid var(--line)' }}
      />
    );
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', background: 'var(--sage-soft)',
      color: 'var(--sage)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: size * 0.42, flexShrink: 0,
    }}>
      {initial}
    </div>
  );
}

function StaffDivider() {
  return (
    <div style={{
      height: 10, margin: '6px 0 18px', backgroundImage:
        'repeating-linear-gradient(var(--line), var(--line) 1px, transparent 1px, transparent 3px)',
      opacity: 0.6,
    }} />
  );
}

function Toast({ text }) {
  if (!text) return null;
  return (
    <div style={{
      position: 'fixed', bottom: 22, left: '50%', transform: 'translateX(-50%)',
      // トーストは常に「暗い背景+明るい文字」の組み合わせで表示する(テーマの文字色を流用すると、
      // ダークテーマのように文字色自体が明るい場合に背景まで明るくなり、文字と同化してしまうため)。
      background: '#1C1C1E', color: '#F3EEE1', padding: '10px 18px', borderRadius: 8,
      fontSize: 13.5, fontFamily: 'var(--font-body)', zIndex: 200, boxShadow: '0 6px 18px rgba(0,0,0,.2)',
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      <Check size={15} /> {text}
    </div>
  );
}

/* ---- 広告ゲート ----
   実際のGoogle AdSense広告を、画面いっぱいに表示する。
   AdSenseは審査・広告ユニット作成が完了するまで広告を配信しないため、それまでは
   広告エリアが空欄のまま表示される(正常な状態)。
   広告ユニット作成後は、下のADSENSE_AD_SLOTを実際のスロットIDに置き換える(DEPLOY.md参照)。
   AdSense自体には「○秒見るまで閉じられない」機能は無いため、指定秒数が経過するまで
   「続ける」を押せなくする制御はこちら側のタイマーで行っている。 */
const ADSENSE_CLIENT = 'ca-pub-9457584922397090';
const ADSENSE_AD_SLOT = 'YOUR_AD_SLOT_ID'; // TODO: AdSenseで広告ユニットを作成後、そのスロットIDに置き換える
// プレイリスト再生画面の上部に出すバナー広告用のスロット(上のAD_SLOTとは別の広告ユニットとして
// AdSense管理画面で作成し、発行されたスロットIDに置き換える)。
const ADSENSE_BANNER_AD_SLOT = 'YOUR_BANNER_AD_SLOT_ID'; // TODO: 同上
let adSlotCounter = 0;
let bannerAdSlotCounter = 0;

/* ---- 再生画面用バナー広告 ----
   AdGateModalと違い、視聴を強制する全画面広告ではなく、画面上部に常時表示する細長いバナー。
   広告ユニット未設定の間は高さ0で何も表示しない(レイアウトが崩れないように)。 */
function AdBanner() {
  const [slotKey] = useState(() => ++bannerAdSlotCounter);
  const adConfigured = ADSENSE_BANNER_AD_SLOT && ADSENSE_BANNER_AD_SLOT !== 'YOUR_BANNER_AD_SLOT_ID';
  useEffect(() => {
    if (!adConfigured) return;
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch (e) { /* noop: 審査前・広告在庫が無い場合などは失敗することがある */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotKey]);
  if (!adConfigured) return null;
  return (
    <div style={{ width: '100%', flexShrink: 0, background: '#000', overflow: 'hidden' }}>
      <ins
        key={slotKey}
        className="adsbygoogle"
        style={{ display: 'block', width: '100%' }}
        data-ad-client={ADSENSE_CLIENT}
        data-ad-slot={ADSENSE_BANNER_AD_SLOT}
        data-ad-format="horizontal"
        data-full-width-responsive="true"
      />
    </div>
  );
}

function AdGateModal({ seconds, onComplete, onCancel, label }) {
  const [remaining, setRemaining] = useState(seconds);
  const [slotKey] = useState(() => ++adSlotCounter);
  const adConfigured = ADSENSE_AD_SLOT && ADSENSE_AD_SLOT !== 'YOUR_AD_SLOT_ID';

  useEffect(() => {
    if (remaining <= 0) return;
    const t = setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining]);

  useEffect(() => {
    if (!adConfigured) return;
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch (e) { /* noop: 審査前・広告在庫が無い場合などは失敗することがある */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotKey]);

  const done = remaining <= 0;
  return (
    <div style={{
      position: 'fixed', inset: 0, background: '#000', zIndex: 200,
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {adConfigured ? (
          <ins
            key={slotKey}
            className="adsbygoogle"
            style={{ display: 'block', width: '100%', height: '100%' }}
            data-ad-client={ADSENSE_CLIENT}
            data-ad-slot={ADSENSE_AD_SLOT}
            data-ad-format="auto"
            data-full-width-responsive="true"
          />
        ) : (
          <div style={{ color: '#9a9a9a', fontSize: 12.5, textAlign: 'center', padding: 20 }}>
            <Film size={26} style={{ marginBottom: 8 }} />
            <div>広告の審査・設定が完了すると、ここに表示されます</div>
          </div>
        )}
      </div>
      <div style={{ background: 'var(--surface, #fff)', padding: '16px 20px 20px', textAlign: 'center', flexShrink: 0 }}>
        <div style={{ fontSize: 11.5, color: 'var(--ink-soft)', marginBottom: 8 }}>{label || '広告'}</div>
        <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '0 0 12px' }}>
          {done ? '広告の表示が終わりました。' : `広告表示中です。あと${remaining}秒でスキップできます。`}
        </p>
        <Button variant="primary" disabled={!done} onClick={onComplete} style={{ width: '100%', justifyContent: 'center' }}>
          {done ? '続ける' : `${remaining}秒`}
        </Button>
        {onCancel && (
          <button
            onClick={onCancel}
            style={{
              display: 'block', width: '100%', textAlign: 'center', marginTop: 12,
              background: 'transparent', border: 'none', color: 'var(--ink-soft)',
              fontSize: 12, textDecoration: 'underline', cursor: 'pointer', padding: 4,
            }}
          >
            キャンセルする(この操作自体を取りやめます)
          </button>
        )}
      </div>
    </div>
  );
}

function DeleteAccountConfirmModal({ onClose, onConfirm, deleting, googleSignedIn }) {
  const [confirmText, setConfirmText] = useState('');
  const canConfirm = confirmText === '削除';
  return (
    <ModalShell onClose={onClose} width={400}>
      <h3 style={{ fontFamily: 'var(--font-display)', margin: '0 0 8px', color: 'var(--danger, #9C3B2E)' }}>
        本当にアカウントを削除しますか?
      </h3>
      <ul style={{ fontSize: 12.5, color: 'var(--ink-soft)', lineHeight: 1.8, paddingLeft: '1.2em', margin: '0 0 14px' }}>
        <li>登録したすべての曲データが削除されます</li>
        <li>プロフィール(表示名・写真)が削除されます</li>
        {googleSignedIn && <li>Googleドライブ上のバックアップデータも削除されます</li>}
        <li>この操作は取り消せません</li>
      </ul>
      <p style={{ fontSize: 12.5, margin: '0 0 8px' }}>
        続ける場合は、下の欄に「<strong>削除</strong>」と入力してください。
      </p>
      <TextInput
        value={confirmText}
        onChange={(e) => setConfirmText(e.target.value)}
        placeholder="削除"
        style={{ marginBottom: 18 }}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button variant="quiet" onClick={onClose}>キャンセル</Button>
        <Button
          variant="danger"
          onClick={onConfirm}
          disabled={!canConfirm || deleting}
        >
          {deleting ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />} 完全に削除する
        </Button>
      </div>
    </ModalShell>
  );
}

function ModalShell({ onClose, children, width = 480, background = 'var(--paper)' }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(36,31,27,0.45)', zIndex: 150,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '5vh 16px', overflowY: 'auto',
    }} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background, borderRadius: 'var(--radius-card, 12px)', width: '100%', maxWidth: width,
          padding: 24, position: 'relative', boxShadow: 'var(--shadow-modal, 0 20px 50px rgba(0,0,0,.25))',
        }}
      >
        <button onClick={onClose} style={{
          position: 'absolute', top: 16, right: 16, background: 'transparent', border: 'none',
          cursor: 'pointer', color: 'var(--ink-soft)',
        }}>
          <X size={20} />
        </button>
        {children}
      </div>
    </div>
  );
}

/* ---- お知らせ(更新履歴)モーダル ----
   sinceVersion指定時は、それより新しい項目だけを表示する(起動時の「前回からの変更点」用)。
   指定なしなら、全履歴を表示する(マイページの「お知らせ」から開く用)。 */
function WhatsNewModal({ onClose, sinceVersion }) {
  const entries = sinceVersion
    ? CHANGELOG.filter((c) => c.version > sinceVersion)
    : CHANGELOG;
  return (
    <ModalShell onClose={onClose} width={480}>
      <h2 style={{ fontFamily: 'var(--font-display)', margin: '0 0 4px' }}>
        {sinceVersion ? 'アップデートのお知らせ' : 'お知らせ'}
      </h2>
      <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '0 0 16px' }}>
        {sinceVersion ? '前回お使いいただいてから、以下の変更がありました。' : 'これまでの更新履歴です。'}
      </p>
      <div style={{ maxHeight: '55vh', overflowY: 'auto' }}>
        {entries.map((c) => (
          <div key={c.version} style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--wine)', marginBottom: 6 }}>{c.version}</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {c.items.map((it, i) => (
                <li key={i} style={{ fontSize: 13, lineHeight: 1.8, color: 'var(--ink)' }}>{it}</li>
              ))}
            </ul>
          </div>
        ))}
        {entries.length === 0 && (
          <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>お知らせはありません。</p>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <Button variant="primary" onClick={onClose}><Check size={13} /> 閉じる</Button>
      </div>
    </ModalShell>
  );
}

/* ------------------------------------------------------------------ */
/*  チケット風・曲カード                                                */
/* ------------------------------------------------------------------ */

function fieldOrOther(val, other) {
  return val === 'その他' ? (other || 'その他') : val;
}

/* ---- 再生リスト ----
   YouTubeの IFrame Player API(https://developers.google.com/youtube/iframe_api_reference)を使い、
   「1曲の再生が終わった」というイベント(onStateChange, ENDED)を検知して、自動的に次の曲へ進める。 */
function loadYouTubeIframeAPI() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (window.__ytApiLoadingPromise) return window.__ytApiLoadingPromise;
  window.__ytApiLoadingPromise = new Promise((resolve) => {
    const prevCb = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prevCb) prevCb(); resolve(); };
    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
    }
  });
  return window.__ytApiLoadingPromise;
}

/* ---- 車のBluetooth/CarPlay等の「次へ」「前へ」ボタン対応についての補足 ----
   再生している動画本体はYouTubeのiframe(youtube.comドメイン)の中にあり、このアプリのページ
   (クロスオリジンの外側)からは直接触れない。iOS Safariは、システムの「再生中」情報(ロック画面・
   コントロールセンター・車のBluetooth/CarPlayのボタン操作)を、"このページ自身が実際に音声を
   再生しているかどうか"で判定する傾向があり、iframeの奥で鳴っている音だけでは認識してくれない
   ことがある(Androidはこの点にわりと寛容だが、iOSは厳しい)。
   対策として、聞こえないごく短い無音ループの<audio>をこのページ自身で常時再生しておくことで、
   「このタブは音声再生中である」とOSに認識させ、MediaSessionの次へ/前へ/再生/一時停止が
   ロック画面やBluetooth/CarPlayのボタンからも効くようにする。実際の音声(YouTube側)とは別物。 */
const SILENT_AUDIO_DATA_URI = 'data:audio/wav;base64,UklGRqQ+AABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YYA+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function PlaylistPlayer({ songs, onClose }) {
  const [index, setIndex] = useState(0);
  const indexRef = useRef(0);
  indexRef.current = index;
  // 車のディスプレイ等に表示する曲情報(うたコレ側の登録内容)を適用する関数。
  // 曲切り替え直後の複数回の再適用と、YouTube側の再生開始タイミングでの再適用の両方から使う。
  // indexRef経由で常に最新のindexを参照するため、依存配列を空にでき、マウント時に1度だけ作られる
  // YouTubeプレイヤーのonStateChangeハンドラ(下記)から呼んでも、曲が切り替わった後の古い曲を
  // 参照してしまう(クロージャが古いままになる)ことがない。
  const applyMediaSessionMetadata = useCallback(() => {
    if (!('mediaSession' in navigator)) return;
    const latest = songsRef.current[indexRef.current];
    if (!latest) return;
    const vid = getYoutubeVideoId(latest.videoUrl);
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: latest.title || 'うたコレ',
      artist: [latest.lyricist, latest.composer].filter(Boolean).join(' / '),
      album: 'うたコレ',
      artwork: vid ? [
        { src: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`, sizes: '480x360', type: 'image/jpeg' },
      ] : [],
    });
  }, []);
  const [ready, setReady] = useState(false);
  const [muted, setMuted] = useState(true);
  const playerRef = useRef(null);
  const containerRef = useRef(null);
  const silentAudioRef = useRef(null);
  const songsRef = useRef(songs);
  songsRef.current = songs;

  const playAt = (i) => {
    const s = songsRef.current[i];
    const vid = s ? getYoutubeVideoId(s.videoUrl) : null;
    if (playerRef.current && playerRef.current.loadVideoById && vid) {
      playerRef.current.loadVideoById(vid);
    }
  };
  // useCallbackでラップ(refのみ参照し依存配列は空でよい)。
  // 車のBluetooth次へ/前へボタン(MediaSession API)からも同じ関数を呼び出すため。
  const goNext = useCallback(() => {
    setIndex((i) => {
      const next = (i + 1) % songsRef.current.length; // 最後まで行ったら最初に戻ってループ
      playAt(next);
      return next;
    });
  }, []);
  const goPrev = useCallback(() => {
    setIndex((i) => {
      const prev = (i - 1 + songsRef.current.length) % songsRef.current.length;
      playAt(prev);
      return prev;
    });
  }, []);

  useEffect(() => {
    let destroyed = false;
    // 再生画面が開いた直後(元をたどれば「再生」ボタンのタップ操作の延長)に、できるだけ早い
    // タイミングで無音オーディオの再生を試みる。1曲目のYouTube側の読み込みには少し時間がかかり、
    // その間に操作(タップ)からの猶予期間が切れてブラウザに自動再生をブロックされることがあり、
    // これが「1曲目だけ車のボタンが反応しない」原因になっていた。ここで早めに試すことで、
    // 1曲目の再生開始と同時に車のNow Playing連携が有効になるようにする。
    if (silentAudioRef.current) silentAudioRef.current.play().catch(() => {});
    const firstVideoId = getYoutubeVideoId(songsRef.current[0]?.videoUrl);
    loadYouTubeIframeAPI().then(() => {
      if (destroyed || !containerRef.current) return;
      playerRef.current = new window.YT.Player(containerRef.current, {
        videoId: firstVideoId,
        playerVars: { autoplay: 1, mute: 1, playsinline: 1, rel: 0 },
        events: {
          onReady: () => setReady(true),
          onStateChange: (e) => {
            if (e.data === window.YT.PlayerState.ENDED) goNext();
            if (e.data === window.YT.PlayerState.PLAYING) {
              if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
              if (silentAudioRef.current) silentAudioRef.current.play().catch(() => {});
            } else if (e.data === window.YT.PlayerState.PAUSED) {
              if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
              if (silentAudioRef.current) silentAudioRef.current.pause();
            }
          },
        },
      });
    });
    return () => {
      destroyed = true;
      if (playerRef.current && playerRef.current.destroy) {
        try { playerRef.current.destroy(); } catch (err) { /* noop */ }
      }
      if (silentAudioRef.current) silentAudioRef.current.pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- MediaSession連携(車のBluetooth/CarPlay/Android Auto等の「次へ」「前へ」ボタン対応) ----
     navigator.mediaSessionにアクションハンドラを登録しておくと、スマホと接続した車のハンドル/カーオーディオの
     次の曲・前の曲ボタン(AVRCP)や、スマホのロック画面・通知の再生コントロールから goNext/goPrev を呼び出せる。
     iOSでこれが機能するには、上で常時再生している無音の<audio>(silentAudioRef)がこのページ自身の
     "再生中の音声"としてOSに認識されている必要がある(YouTube iframeの中の音声だけでは認識されないため)。 */
  useEffect(() => {
    if (!('mediaSession' in navigator)) return undefined;
    navigator.mediaSession.setActionHandler('previoustrack', goPrev);
    navigator.mediaSession.setActionHandler('nexttrack', goNext);
    navigator.mediaSession.setActionHandler('play', () => {
      if (playerRef.current && playerRef.current.playVideo) playerRef.current.playVideo();
      if (silentAudioRef.current) silentAudioRef.current.play().catch(() => {});
      navigator.mediaSession.playbackState = 'playing';
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      if (playerRef.current && playerRef.current.pauseVideo) playerRef.current.pauseVideo();
      if (silentAudioRef.current) silentAudioRef.current.pause();
      navigator.mediaSession.playbackState = 'paused';
    });
    return () => {
      navigator.mediaSession.setActionHandler('previoustrack', null);
      navigator.mediaSession.setActionHandler('nexttrack', null);
      navigator.mediaSession.setActionHandler('play', null);
      navigator.mediaSession.setActionHandler('pause', null);
    };
  }, [goNext, goPrev]);

  // 曲が変わるたびに、車のディスプレイやスマホのロック画面に表示される曲名・アーティスト・サムネイルを更新。
  useEffect(() => {
    if (!('mediaSession' in navigator)) return undefined;
    const current = songsRef.current[index];
    if (!current) return undefined;
    applyMediaSessionMetadata();
    return undefined;
  }, [index, songs, applyMediaSessionMetadata]);
  const unmute = () => {
    if (playerRef.current) {
      playerRef.current.unMute();
      playerRef.current.playVideo();
    }
    // ユーザー操作(タップ)のタイミングで無音の同期用<audio>も再生開始する。
    // ブラウザの自動再生制限は「ユーザー操作直後」なら音声ありの再生を許可するため、ここで行う。
    if (silentAudioRef.current) silentAudioRef.current.play().catch(() => {});
    setMuted(false);
  };

  const current = songs[index];

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', zIndex: 150, display: 'flex', flexDirection: 'column' }}>
      <AdBanner />
      {/* 車のBluetooth/CarPlayのボタン操作をこのページ自身の「再生中」として認識させるための無音オーディオ。
          画面には表示されず、聞こえる音もない(無音波形)。 */}
      <audio ref={silentAudioRef} src={SILENT_AUDIO_DATA_URI} loop preload="auto" style={{ display: 'none' }} />
      <div style={{ flex: 1, position: 'relative' }}>
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
        {!ready && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#9a9a9a', fontSize: 13,
          }}>
            <Loader2 size={20} className="spin" />
          </div>
        )}
        {ready && muted && (
          <button
            onClick={unmute}
            style={{
              position: 'absolute', bottom: 12, right: 12, display: 'flex', alignItems: 'center', gap: 5,
              padding: '7px 12px', borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.7)', color: '#fff',
              border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
            }}
          >
            <VolumeX size={13} /> 音声オン
          </button>
        )}
        <button
          onClick={onClose}
          aria-label="閉じる"
          style={{
            position: 'absolute', top: 12, right: 12, width: 30, height: 30, borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
            backgroundColor: 'rgba(0,0,0,0.6)', border: 'none', cursor: 'pointer',
          }}
        >
          <X size={16} />
        </button>
      </div>
      <div style={{ background: 'var(--surface, #fff)', padding: '14px 18px 18px', flexShrink: 0 }}>
        <div style={{ fontSize: 11, color: 'var(--ink-soft)', marginBottom: 2 }}>{index + 1} / {songs.length}曲 再生中</div>
        <div style={{ fontWeight: 700, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {current?.title}
        </div>
        <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginBottom: 12 }}>
          {[current?.lyricist, current?.composer].filter(Boolean).join(' / ')}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          <Button variant="quiet" onClick={goPrev}><ChevronLeft size={14} /> 前へ</Button>
          <Button variant="quiet" onClick={goNext}>次へ <ChevronRight size={14} /></Button>
        </div>
      </div>
    </div>
  );
}

let activeVideoStop = null; // 同時に複数の動画が再生されないよう、現在再生中のものだけを覚えておく

function VideoThumb({ url }) {
  const videoId = getYoutubeVideoId(url);
  const THUMB_LEVELS = ['maxresdefault', 'hqdefault', 'mqdefault'];
  const EMBED_TIMEOUT_MS = 3500;
  const THUMB_TIMEOUT_MS = 4000;

  const [thumbLevel, setThumbLevel] = useState(0);
  const [thumbLoaded, setThumbLoaded] = useState(false);
  const [mode, setMode] = useState('thumb'); // 'thumb' | 'embedding' | 'playing' | 'embed-failed'
  const [muted, setMuted] = useState(true);
  const timerRef = useRef(null);
  const iframeRef = useRef(null);
  const stopRef = useRef(null);
  stopRef.current = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setMode('thumb');
  };

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (activeVideoStop === stopRef.current) activeVideoStop = null;
  }, []);

  const thumbExhausted = thumbLevel >= THUMB_LEVELS.length;
  const thumbSrc = videoId && !thumbExhausted ? `https://i.ytimg.com/vi/${videoId}/${THUMB_LEVELS[thumbLevel]}.jpg` : null;

  // onLoad/onErrorがどちらも発火せず固まるケース(CSP等でリクエストがブロックされている場合など)への
  // 対策として、一定時間で強制的に次の候補へ進める
  useEffect(() => {
    if (!videoId || thumbExhausted || thumbLoaded) return undefined;
    const t = setTimeout(() => {
      console.warn(`[VideoThumb] サムネイル読み込みがタイムアウトしました (level=${THUMB_LEVELS[thumbLevel]})。次の候補へ切り替えます。`);
      setThumbLevel((l) => l + 1);
    }, THUMB_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [videoId, thumbLevel, thumbExhausted, thumbLoaded]);

  if (!videoId) return null;

  const handleThumbLoad = (e) => {
    // maxresdefault等が存在しない動画では、YouTubeは120x90の代替プレースホルダー画像を返す(エラーにはならない)ため、
    // サイズを見て「本物のサムネイルではない」場合は次の解像度にフォールバックする
    if (e.target.naturalWidth === 120 && e.target.naturalHeight === 90 && thumbLevel < THUMB_LEVELS.length - 1) {
      setThumbLevel((l) => l + 1);
    } else {
      setThumbLoaded(true);
    }
  };
  const handleThumbError = () => {
    console.warn(`[VideoThumb] サムネイル読み込みエラー (level=${THUMB_LEVELS[thumbLevel]})`);
    setThumbLevel((l) => l + 1);
  };

  const startEmbed = (e) => {
    e.stopPropagation();
    if (activeVideoStop && activeVideoStop !== stopRef.current) {
      activeVideoStop();
    }
    activeVideoStop = stopRef.current;
    setMuted(true);
    setMode('embedding');
    timerRef.current = setTimeout(() => {
      setMode((m) => (m === 'embedding' ? 'embed-failed' : m));
    }, EMBED_TIMEOUT_MS);
  };
  const handleIframeLoad = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setMode('playing');
  };
  const backToThumb = (e) => {
    e.stopPropagation();
    if (timerRef.current) clearTimeout(timerRef.current);
    setMode('thumb');
    if (activeVideoStop === stopRef.current) activeVideoStop = null;
  };
  const unmute = (e) => {
    e.stopPropagation();
    // モバイルではスクリプトからの自動再生(音声あり)がブロックされるため、
    // まず無音で自動再生し、ユーザーがこのボタンを押した時だけYouTube公式のpostMessage APIで
    // ミュート解除する(こちらは自動再生ポリシーの対象外なので確実に動く)
    try {
      iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'unMute', args: [] }), 'https://www.youtube.com');
      iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'playVideo', args: [] }), 'https://www.youtube.com');
    } catch (err) { /* noop */ }
    setMuted(false);
  };

  return (
    <div style={{ width: '100%' }} onClick={(e) => e.stopPropagation()}>
      <style>{`
        .vt-playbtn:hover { transform: scale(1.1); }
        .vt-playbtn:active { transform: scale(0.95); }
        @keyframes vt-pulse { 0%,100% { opacity: 1; } 50% { opacity: .5; } }
        .vt-pulse { animation: vt-pulse 1.5s ease-in-out infinite; }
      `}</style>
      <div style={{ position: 'relative', width: '100%', paddingTop: '56.25%', borderRadius: 10, overflow: 'hidden', background: '#d1d5db' }}>

        {mode === 'embed-failed' ? (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 30, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 8, padding: 12, textAlign: 'center', background: '#1f2937',
          }}>
            <svg viewBox="0 0 24 24" style={{ width: 24, height: 24, color: '#d1d5db' }} fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="6" width="14" height="12" rx="1.5" />
              <path d="M16 10.5l5.1-3a1 1 0 0 1 1.5.87v9.26a1 1 0 0 1-1.5.87L16 15.5" />
            </svg>
            <p style={{ fontSize: 12, lineHeight: 1.4, color: '#e5e7eb', margin: 0 }}>この動画は埋め込み再生できません</p>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600,
                padding: '6px 12px', borderRadius: 999, background: '#fff', color: '#111827', textDecoration: 'none',
              }}
            >
              YouTubeで見る
            </a>
          </div>
        ) : (
          <>
            {/* サムネイル層 */}
            {!thumbExhausted ? (
              <img
                key={thumbLevel}
                src={thumbSrc}
                alt="動画サムネイル"
                onLoad={handleThumbLoad}
                onError={handleThumbError}
                style={{
                  position: 'absolute', inset: 0, zIndex: 0, width: '100%', height: '100%',
                  objectFit: 'cover', transition: 'opacity .3s', opacity: thumbLoaded ? 1 : 0,
                }}
              />
            ) : (
              <div style={{ position: 'absolute', inset: 0, zIndex: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#d1d5db' }}>
                <Music2 size={24} color="#9ca3af" />
              </div>
            )}
            {!thumbLoaded && !thumbExhausted && (
              <div className="vt-pulse" style={{ position: 'absolute', inset: 0, zIndex: 0, background: '#d1d5db' }} />
            )}

            {/* 埋め込みiframe層(読み込み中・再生中で共通、透明度で切替) */}
            {(mode === 'embedding' || mode === 'playing') && (
              <iframe
                ref={iframeRef}
                src={`https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&playsinline=1&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`}
                title="動画プレイヤー"
                allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                onLoad={handleIframeLoad}
                style={{
                  position: 'absolute', inset: 0, zIndex: 10, width: '100%', height: '100%', border: 0,
                  opacity: mode === 'playing' ? 1 : 0,
                }}
              />
            )}

            {/* 音声オンボタン(スマホでは音声ありの自動再生がブロックされるため、まず無音で再生し
                タップで音声を有効にする) */}
            {mode === 'playing' && muted && (
              <button
                type="button"
                onClick={unmute}
                aria-label="音声をオンにする"
                style={{
                  position: 'absolute', bottom: 6, right: 6, zIndex: 20, display: 'flex', alignItems: 'center', gap: 5,
                  padding: '6px 10px', borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.7)', color: '#fff',
                  border: 'none', cursor: 'pointer', fontSize: 11.5, fontWeight: 600,
                }}
              >
                <VolumeX size={13} /> 音声オン
              </button>
            )}

            {/* 再生ボタン(サムネイル状態のみ、タップ範囲は全体) */}
            {mode === 'thumb' && (
              <button
                type="button"
                onClick={startEmbed}
                aria-label="動画を再生"
                style={{
                  position: 'absolute', inset: 0, zIndex: 20, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', width: '100%', height: '100%', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0,
                }}
              >
                <span
                  className="vt-playbtn"
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%',
                    width: 52, height: 52, backgroundColor: 'rgba(0,0,0,0.65)', transition: 'transform .15s',
                  }}
                >
                  <svg viewBox="0 0 24 24" style={{ width: 22, height: 22, marginLeft: 2 }} fill="#fff">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </span>
              </button>
            )}

            {/* 読み込み中オーバーレイ */}
            {mode === 'embedding' && (
              <div style={{
                position: 'absolute', inset: 0, zIndex: 20, display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: 'rgba(0,0,0,0.55)',
              }}>
                <Loader2 size={24} color="#fff" className="spin" />
                <span style={{ color: '#fff', fontSize: 12 }}>読み込み中...</span>
              </div>
            )}

            {/* 再生中: 閉じるボタン */}
            {mode === 'playing' && (
              <button
                type="button"
                onClick={backToThumb}
                aria-label="閉じる"
                style={{
                  position: 'absolute', top: 4, right: 4, zIndex: 20, width: 24, height: 24, borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
                  backgroundColor: 'rgba(0,0,0,0.6)', border: 'none', cursor: 'pointer', padding: 0,
                }}
              >
                <svg viewBox="0 0 24 24" style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SuiteGroupCard({ suiteTitle, suiteGenre, songs, renderSong, onReorder }) {
  const [open, setOpen] = useState(true);
  const [editingOrder, setEditingOrder] = useState(false);
  const [orderIds, setOrderIds] = useState(() => songs.map((s) => s.id));
  const dragIndex = useRef(null);
  const songById = new Map(songs.map((s) => [s.id, s]));

  const startEditingOrder = () => {
    setOrderIds(songs.map((s) => s.id));
    setEditingOrder(true);
  };
  const handleDrop = (index) => {
    if (dragIndex.current === null || dragIndex.current === index) return;
    setOrderIds((prev) => {
      const next = [...prev];
      const [moved] = next.splice(dragIndex.current, 1);
      next.splice(index, 0, moved);
      return next;
    });
    dragIndex.current = null;
  };
  const saveOrder = () => {
    if (onReorder) onReorder(orderIds);
    setEditingOrder(false);
  };

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 10, marginBottom: 10, overflow: 'hidden', background: 'var(--surface, #fff)' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 14px',
          background: 'var(--paper)', border: 'none', cursor: 'pointer', textAlign: 'left',
        }}
      >
        <BookOpen size={15} color="var(--wine)" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{suiteTitle}</div>
          {suiteGenre && <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>{suiteGenre}</div>}
        </div>
        <span style={{ fontSize: 11.5, color: 'var(--ink-soft)', flexShrink: 0 }}>{songs.length}曲</span>
        {open ? <ChevronUp size={15} color="var(--ink-soft)" /> : <ChevronDown size={15} color="var(--ink-soft)" />}
      </button>
      {open && !editingOrder && (
        <div style={{ padding: '10px 12px' }}>
          {onReorder && songs.length > 1 && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
              <Button variant="quiet" onClick={startEditingOrder}><Pencil size={12} /> 並び順を編集</Button>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {songs.map((s) => renderSong(s))}
          </div>
        </div>
      )}
      {open && editingOrder && (
        <div style={{ padding: '10px 12px' }}>
          <p style={{ fontSize: 11.5, color: 'var(--ink-soft)', margin: '0 0 8px' }}>ドラッグして曲の順番を並び替えてください。</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {orderIds.map((id, i) => {
              const s = songById.get(id);
              if (!s) return null;
              return (
                <div
                  key={id}
                  draggable
                  onDragStart={() => { dragIndex.current = i; }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => handleDrop(i)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px',
                    background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 6,
                    cursor: 'grab', fontSize: 12.5,
                  }}
                >
                  <GripVertical size={14} color="var(--ink-soft)" />
                  <span style={{ width: 18, textAlign: 'center', color: 'var(--ink-soft)', fontSize: 11, flexShrink: 0 }}>{i + 1}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
            <Button variant="quiet" onClick={() => setEditingOrder(false)}>キャンセル</Button>
            <Button variant="primary" onClick={saveOrder}><Check size={13} /> 保存</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function SongCard({ song, ownerName, isMine, onEdit, onDelete, onShare, onCopy, onOpen, alreadyCopied, compact, selectable, selected, onToggleSelect, onViewDetail }) {
  const suiteLabel = song.suiteTitle
    ? `${song.suiteGenre ? song.suiteGenre + ' ' : ''}『${song.suiteTitle}』より`
    : (song.suiteGenre || ''); // 組曲名が空でも、組曲の種類だけ入力されていれば「より」を付けずそのまま表示する
  const visibleTags = isMine
    ? (song.tags || [])
    : (song.tags || []).filter((t) => t.visibility === 'public');

  if (compact) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, background: 'var(--surface, #fff)',
        border: '1px solid var(--line)', borderRadius: 'var(--radius-control, 8px)', padding: '10px 14px', marginBottom: 8,
        cursor: onOpen ? 'pointer' : 'default',
      }} onClick={onOpen}>
        {selectable && (
          <input
            type="checkbox" checked={!!selected}
            onClick={(e) => e.stopPropagation()}
            onChange={() => onToggleSelect && onToggleSelect(song.id)}
            style={{ width: 15, height: 15, flexShrink: 0 }}
          />
        )}
        {song.videoUrl && <Film size={13} color="var(--ink-soft)" style={{ flexShrink: 0 }} />}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {song.title}
            {isMine && song.isPrivate && <Lock size={10} style={{ marginLeft: 6, verticalAlign: -1 }} color="var(--ink-soft)" />}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--ink-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {song.composer}{suiteLabel && ` ・ ${suiteLabel}`}
          </div>
        </div>
        {isMine && (
          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
            {selectable && onViewDetail && (
              <IconBtn title="詳細を見る" onClick={() => onViewDetail(song)}><Eye size={14} /></IconBtn>
            )}
            <IconBtn title="編集" onClick={onEdit}><Pencil size={14} /></IconBtn>
            <IconBtn title="削除" danger onClick={onDelete}><Trash2 size={14} /></IconBtn>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{
      position: 'relative', display: 'flex', flexDirection: 'column', background: 'var(--surface, #fff)',
      border: '1px solid var(--line)', borderRadius: 'var(--radius-card, 8px)', overflow: 'hidden', marginBottom: 14,
      boxShadow: 'var(--shadow-card, none)',
    }}>
      <div
        style={{ padding: '16px 18px 0', cursor: onOpen ? 'pointer' : 'default' }}
        onClick={onOpen}
      >
        <VideoThumb url={song.videoUrl} />
        <div style={{ minWidth: 0, marginTop: song.videoUrl ? 14 : 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <BookOpen size={15} style={{ color: 'var(--wine)', flexShrink: 0 }} />
          <h3 style={{
            margin: 0, fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 17,
            color: 'var(--ink)',
          }}>{song.title}</h3>
          {suiteLabel && (
            <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{suiteLabel}</span>
          )}
          {isMine && song.isPrivate && (
            <span style={{
              display: 'flex', alignItems: 'center', gap: 3, fontSize: 10.5, color: 'var(--ink-soft)',
              border: '1px solid var(--line)', borderRadius: 'var(--radius-pill, 20px)', padding: '1px 8px',
            }}>
              <Lock size={10} /> 非公開
            </span>
          )}
        </div>
        <div style={{
          marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontSize: 12.5,
          color: 'var(--ink-soft)', fontFamily: 'var(--font-body)',
        }}>
          <span>作詩: {song.lyricist}</span>
          <span>作曲: {song.composer}</span>
          {song.arranger && <span>編曲: {song.arranger}</span>}
          {song.year && <span>{song.year}年</span>}
        </div>
        <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <Tag color="wine">{fieldOrOther(song.formation, song.formationOther)}</Tag>
          {song.accompaniment && <Tag color="sage">{fieldOrOther(song.accompaniment, song.accompanimentOther)}</Tag>}
          {song.language && <Tag color="gold">{fieldOrOther(song.language, song.languageOther)}</Tag>}
        </div>
        {(song.videoUrl || song.scoreSource) && (
          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            {/* 動画への直接リンクは、自分の曲(isMine)の時だけ表示する。共有・限定公開の動画で、
                視聴者が直接YouTube側のURLへ抜けられないようにし、埋め込み再生(VideoThumb)や
                プレイリスト再生の中だけで観てもらう形にするため。 */}
            {song.videoUrl && isMine && (
              <a
                href={song.videoUrl} target="_blank" rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                title="演奏動画を開く"
                aria-label="演奏動画を開く"
                style={iconLinkStyle}
              >
                <Film size={16} />
              </a>
            )}
            {song.scoreSource && (
              <a
                href={song.scoreSource} target="_blank" rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                title="楽譜入手先を開く"
                aria-label="楽譜入手先を開く"
                style={iconLinkStyle}
              >
                <FileText size={16} />
              </a>
            )}
          </div>
        )}
        {!isMine && ownerName && (
          <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--sage)' }}>
            {ownerName} さんの登録曲
          </div>
        )}
        {song.sourceUserName && (
          <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--gold)' }}>
            ✦ {song.sourceUserName} さんから収集
          </div>
        )}
        {visibleTags.length > 0 && (
          <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            {visibleTags.map((t) => (
              <span key={t.name} style={{
                fontSize: 11, color: t.visibility === 'private' ? 'var(--sage)' : 'var(--ink-soft)',
                border: `1px dashed ${t.visibility === 'private' ? 'var(--sage)' : 'var(--line)'}`,
                borderRadius: 'var(--radius-pill, 20px)', padding: '2px 9px', display: 'inline-flex', alignItems: 'center', gap: 3,
              }}>
                {isMine && t.visibility === 'private' && <EyeOff size={10} />}
                #{t.name}
              </span>
            ))}
          </div>
        )}
        {isMine && hasSungRecordContent(song.sungRecord) && (
          <div style={{
            marginTop: 10, fontSize: 11.5, color: 'var(--sage)', background: 'var(--sage-soft)',
            borderRadius: 8, padding: '8px 10px', lineHeight: 1.7,
          }}>
            <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
              <EyeOff size={10} /> 歌った記録(自分だけ)
            </div>
            {song.sungRecord.date && <div>日付: {song.sungRecord.date}</div>}
            {song.sungRecord.concertName && <div>演奏会: {song.sungRecord.concertName}</div>}
            {song.sungRecord.place && <div>場所: {song.sungRecord.place}</div>}
            {song.sungRecord.choir && <div>合唱団: {song.sungRecord.choir}</div>}
            {song.sungRecord.conductor && <div>指揮者: {song.sungRecord.conductor}</div>}
            {song.sungRecord.memo && <div>メモ: {song.sungRecord.memo}</div>}
          </div>
        )}
        </div>
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, padding: '10px 18px',
        borderTop: '2px dashed var(--line)',
      }} onClick={(e) => e.stopPropagation()}>
        {isMine ? (
          <>
            <IconBtn title="編集" onClick={onEdit}><Pencil size={16} /></IconBtn>
            <IconBtn
              title={song.isPrivate ? '非公開の曲は共有できません' : '共有URLを発行'}
              disabled={song.isPrivate}
              onClick={onShare}
            ><Share2 size={16} /></IconBtn>
            <IconBtn title="削除" danger onClick={onDelete}><Trash2 size={16} /></IconBtn>
          </>
        ) : (
          <IconBtn title={alreadyCopied ? '追加済み' : '自分のDBに追加'} disabled={alreadyCopied} onClick={onCopy}>
            {alreadyCopied ? <Check size={16} /> : <Plus size={16} />}
          </IconBtn>
        )}
      </div>
    </div>
  );
}

const linkStyle = {
  fontSize: 12, color: 'var(--wine)', textDecoration: 'none', display: 'flex',
  alignItems: 'center', gap: 4, fontFamily: 'var(--font-body)',
};

const iconLinkStyle = {
  width: 34, height: 34, borderRadius: '50%', border: '1px solid var(--line)',
  background: 'var(--surface, #fff)', display: 'flex', alignItems: 'center', justifyContent: 'center',
  color: 'var(--wine)', flexShrink: 0,
};

function IconBtn({ children, onClick, danger, disabled, title }) {
  return (
    <button title={title} disabled={disabled} onClick={onClick} style={{
      width: 32, height: 32, borderRadius: '50%', border: '1px solid var(--line)',
      background: 'var(--surface, #fff)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: disabled ? 'var(--ink-soft)' : (danger ? 'var(--danger, #9C3B2E)' : 'var(--ink)'),
      cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
    }}>
      {children}
    </button>
  );
}

function Tag({ children, color }) {
  const map = {
    wine: { bg: 'var(--wine-soft)', fg: 'var(--wine)' },
    sage: { bg: 'var(--sage-soft)', fg: 'var(--sage)' },
    gold: { bg: 'var(--gold-soft)', fg: 'var(--gold-text, #8a6a34)' },
  };
  const c = map[color] || map.wine;
  return (
    <span style={{
      fontSize: 11.5, background: c.bg, color: c.fg, padding: '3px 9px',
      borderRadius: 'var(--radius-pill, 20px)', fontFamily: 'var(--font-body)', fontWeight: 600,
    }}>{children}</span>
  );
}

function TagCycleChip({ name, state, onClick }) {
  // state: 'none' | 'public' | 'private'
  const styles = {
    none: { border: '1px solid var(--line)', background: 'var(--surface, #fff)', color: 'var(--ink-soft)' },
    public: { border: '1px solid var(--wine)', background: 'var(--wine-soft)', color: 'var(--wine)' },
    private: { border: '1px solid var(--sage)', background: 'var(--sage-soft)', color: 'var(--sage)' },
  };
  const s = styles[state] || styles.none;
  const label = state === 'private' ? '自分だけ' : state === 'public' ? '公開' : null;
  return (
    <button
      type="button"
      onClick={onClick}
      title={
        state === 'none' ? `${name}: タップで公開に設定`
          : state === 'public' ? `${name}: タップで自分だけに変更`
            : `${name}: タップで未選択に戻す`
      }
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '5px 12px',
        borderRadius: 'var(--radius-pill, 20px)', cursor: 'pointer', fontWeight: 600, ...s,
      }}
    >
      {state === 'public' && <Eye size={11} />}
      {state === 'private' && <EyeOff size={11} />}
      {name}
      {label && <span style={{ fontSize: 10, opacity: 0.8 }}>({label})</span>}
    </button>
  );
}

function SongFilterBar({ filters, setFilters, sort, setSort, songs = [], onShuffle }) {
  const [expanded, setExpanded] = useState(false);
  const setField = (k) => (v) => setFilters((prev) => ({ ...prev, [k]: v }));
  const active = isSongFilterActive(filters);

  const availableTags = useMemo(() => {
    const names = new Set();
    songs.forEach((s) => (s.tags || []).forEach((t) => names.add(t.name)));
    return Array.from(names).sort((a, b) => a.localeCompare(b, 'ja'));
  }, [songs]);
  // 詳細フィルタの作詩・作曲欄用のプルダウン候補。「最近使った順→登録件数が多い順」に並べる。
  const lyricistFilterSuggestions = useMemo(() => buildNameSuggestions(songs, 'lyricist'), [songs]);
  const composerFilterSuggestions = useMemo(() => buildNameSuggestions(songs, 'composer'), [songs]);

  const toggleTag = (name) => {
    setFilters((prev) => {
      const tags = prev.tags || [];
      const next = tags.includes(name) ? tags.filter((t) => t !== name) : [...tags, name];
      return { ...prev, tags: next };
    });
  };

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 180 }}>
          <Search size={15} style={{ position: 'absolute', left: 11, top: 10, color: 'var(--ink-soft)' }} />
          <TextInput
            style={{ paddingLeft: 34 }}
            placeholder="曲名・組曲名で絞り込み"
            value={filters.keyword}
            onChange={(e) => setField('keyword')(e.target.value)}
          />
        </div>
        {sort !== undefined && (
          <select value={sort} onChange={(e) => setSort(e.target.value)} style={{ ...inputStyle, width: 150 }}>
            <option value="random">ランダム</option>
            <option value="title-asc">曲名順(組曲優先)・昇順</option>
            <option value="title-desc">曲名順(組曲優先)・降順</option>
            <option value="newest">追加日が新しい順</option>
            <option value="oldest">追加日が古い順</option>
            <option value="updated">更新日が新しい順</option>
            <option value="sungDate-desc">歌った日が新しい順</option>
            <option value="sungDate-asc">歌った日が古い順</option>
          </select>
        )}
        {sort === 'random' && onShuffle && (
          <Button variant="quiet" onClick={onShuffle}>
            <Shuffle size={13} /> シャッフル
          </Button>
        )}
        <Button variant={expanded ? 'default' : 'quiet'} onClick={() => setExpanded((v) => !v)}>
          詳細フィルタ {active && <span style={{
            width: 6, height: 6, borderRadius: '50%', background: 'var(--wine)', display: 'inline-block',
          }} />}
        </Button>
      </div>

      {expanded && (
        <div style={{
          display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10, background: 'var(--surface, #fff)',
          border: '1px solid var(--line)', borderRadius: 10, padding: 14,
        }}>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label style={{ fontSize: 11.5, color: 'var(--ink-soft)', display: 'block', marginBottom: 4 }}>作詩</label>
            <SuggestInput value={filters.lyricist} onChange={setField('lyricist')} suggestions={lyricistFilterSuggestions} placeholder="例: 谷川" />
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label style={{ fontSize: 11.5, color: 'var(--ink-soft)', display: 'block', marginBottom: 4 }}>作曲</label>
            <SuggestInput value={filters.composer} onChange={setField('composer')} suggestions={composerFilterSuggestions} placeholder="例: 三善" />
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label style={{ fontSize: 11.5, color: 'var(--ink-soft)', display: 'block', marginBottom: 4 }}>編成</label>
            <select value={filters.formation} onChange={(e) => setField('formation')(e.target.value)} style={inputStyle}>
              <option value="">すべて</option>
              {FORMATIONS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label style={{ fontSize: 11.5, color: 'var(--ink-soft)', display: 'block', marginBottom: 4 }}>言語</label>
            <select value={filters.language} onChange={(e) => setField('language')(e.target.value)} style={inputStyle}>
              <option value="">すべて</option>
              {LANGUAGES.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
          {availableTags.length > 0 && (
            <div style={{ flexBasis: '100%' }}>
              <label style={{ fontSize: 11.5, color: 'var(--ink-soft)', display: 'block', marginBottom: 6 }}>
                タグ(複数選択すると、すべて含む曲だけを表示します)
              </label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {availableTags.map((name) => {
                  const on = (filters.tags || []).includes(name);
                  return (
                    <button
                      key={name}
                      type="button"
                      onClick={() => toggleTag(name)}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, padding: '5px 12px',
                        borderRadius: 'var(--radius-pill, 20px)', cursor: 'pointer', fontWeight: 600,
                        border: on ? '1px solid var(--wine)' : '1px solid var(--line)',
                        background: on ? 'var(--wine-soft)' : '#fff',
                        color: on ? 'var(--wine)' : 'var(--ink-soft)',
                      }}
                    >
                      {on && <Check size={11} />} {name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {active && (
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <Button variant="quiet" onClick={() => setFilters(emptySongFilters())}>
                <X size={13} /> クリア
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  プロフィール作成フォーム                                            */
/* ------------------------------------------------------------------ */

function ImageCropModal({ file, onCancel, onConfirm }) {
  const VIEW = 220;
  const NUDGE_STEP = 16;
  const [imgUrl, setImgUrl] = useState('');
  const [loadError, setLoadError] = useState('');
  const [natural, setNatural] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const imgElRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoadError('');
    setImgUrl('');
    const reader = new FileReader();
    reader.onload = () => { if (!cancelled) setImgUrl(reader.result); };
    reader.onerror = () => { if (!cancelled) setLoadError('画像の読み込みに失敗しました。別の写真をお試しください。'); };
    reader.readAsDataURL(file);
    return () => { cancelled = true; };
  }, [file]);

  const onImgLoad = (e) => {
    setNatural({ w: e.target.naturalWidth, h: e.target.naturalHeight });
    setZoom(1);
    setPos({ x: 0, y: 0 });
  };
  const onImgError = () => setLoadError('画像の読み込みに失敗しました。別の写真をお試しください。');

  const baseScale = natural ? Math.max(VIEW / natural.w, VIEW / natural.h) : 1;
  const scale = baseScale * zoom;
  const dispW = natural ? natural.w * scale : 0;
  const dispH = natural ? natural.h * scale : 0;
  const maxOffsetX = Math.max(0, (dispW - VIEW) / 2);
  const maxOffsetY = Math.max(0, (dispH - VIEW) / 2);

  const clamp = (p) => ({
    x: Math.min(maxOffsetX, Math.max(-maxOffsetX, p.x)),
    y: Math.min(maxOffsetY, Math.max(-maxOffsetY, p.y)),
  });

  const nudge = (dx, dy) => setPos((p) => clamp({ x: p.x + dx, y: p.y + dy }));

  useEffect(() => {
    setPos((p) => clamp(p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxOffsetX, maxOffsetY]);

  const confirm = () => {
    const canvas = document.createElement('canvas');
    canvas.width = VIEW;
    canvas.height = VIEW;
    const ctx = canvas.getContext('2d');
    const dx = VIEW / 2 + pos.x - dispW / 2;
    const dy = VIEW / 2 + pos.y - dispH / 2;
    ctx.drawImage(imgElRef.current, dx, dy, dispW, dispH);
    onConfirm(canvas.toDataURL('image/jpeg', 0.85));
  };

  const DPadBtn = ({ onClick, label, children, disabled }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      style={{
        width: 38, height: 38, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface, #fff)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: disabled ? 'default' : 'pointer',
        color: disabled ? 'var(--line)' : 'var(--ink)',
      }}
    >
      {children}
    </button>
  );

  return (
    <ModalShell onClose={onCancel} width={340}>
      <h3 style={{ fontFamily: 'var(--font-display)', margin: '0 0 4px' }}>画像の位置を調整</h3>
      <p style={{ fontSize: 12, color: 'var(--ink-soft)', margin: '0 0 16px' }}>
        矢印ボタンで位置を、スライダーで拡大率を調整して、顔がちょうどいい大きさになるようにしてください。
      </p>
      {loadError && (
        <p style={{ fontSize: 12.5, color: 'var(--danger, #9C3B2E)', margin: '0 0 14px' }}>{loadError}</p>
      )}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
        <div
          style={{
            width: VIEW, height: VIEW, borderRadius: '50%', overflow: 'hidden', position: 'relative',
            background: '#e5e0d3', border: '1px solid var(--line)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}
        >
          {!imgUrl && !loadError && (
            <Loader2 size={20} color="var(--ink-soft)" className="spin" />
          )}
          {imgUrl && (
            <img
              ref={imgElRef}
              src={imgUrl}
              alt=""
              onLoad={onImgLoad}
              onError={onImgError}
              draggable={false}
              style={{
                position: 'absolute', left: '50%', top: '50%', width: dispW, height: dispH,
                maxWidth: 'none', maxHeight: 'none',
                transform: `translate(-50%, -50%) translate(${pos.x}px, ${pos.y}px)`,
                userSelect: 'none', pointerEvents: 'none',
              }}
            />
          )}
        </div>
      </div>

      {natural && (
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 38px)', gridTemplateRows: 'repeat(3, 38px)', gap: 4 }}>
            <div />
            <DPadBtn label="上に動かす" disabled={pos.y <= -maxOffsetY} onClick={() => nudge(0, -NUDGE_STEP)}><ChevronUp size={17} /></DPadBtn>
            <div />
            <DPadBtn label="左に動かす" disabled={pos.x <= -maxOffsetX} onClick={() => nudge(-NUDGE_STEP, 0)}><ChevronLeft size={17} /></DPadBtn>
            <div />
            <DPadBtn label="右に動かす" disabled={pos.x >= maxOffsetX} onClick={() => nudge(NUDGE_STEP, 0)}><ChevronRight size={17} /></DPadBtn>
            <div />
            <DPadBtn label="下に動かす" disabled={pos.y >= maxOffsetY} onClick={() => nudge(0, NUDGE_STEP)}><ChevronDown size={17} /></DPadBtn>
            <div />
          </div>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        <span style={{ fontSize: 11, color: 'var(--ink-soft)' }}>縮小</span>
        <input
          type="range" min="1" max="3" step="0.01" value={zoom}
          onChange={(e) => setZoom(parseFloat(e.target.value))}
          style={{ flex: 1 }}
        />
        <span style={{ fontSize: 11, color: 'var(--ink-soft)' }}>拡大</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button variant="quiet" onClick={onCancel}>キャンセル</Button>
        <Button variant="primary" onClick={confirm} disabled={!natural}><Check size={14} /> この位置で決定</Button>
      </div>
    </ModalShell>
  );
}

function ProfileForm({ initial, existingIds, onSave, onCancel, isNew, disabled }) {
  const [id] = useState(() => initial?.userId || genUserId(existingIds));
  const [name, setName] = useState(initial?.displayName || '');
  const [avatarDataUrl, setAvatarDataUrl] = useState(initial?.avatarDataUrl || '');
  const [error, setError] = useState('');
  const [imgError, setImgError] = useState('');
  const [cropFile, setCropFile] = useState(null);

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setImgError('画像ファイルを選んでください。');
      return;
    }
    setImgError('');
    setCropFile(file);
  };

  const submit = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('表示名は必須です。');
      return;
    }
    onSave({
      userId: id,
      displayName: trimmedName,
      avatarDataUrl,
      // 以下はVer.1では非表示の項目(ソーシャル機能凍結中)。既存値があれば保持し、Ver.2で復活しやすくする
      bio: initial?.bio || '',
      birthDate: initial?.birthDate || '',
      ageDisplay: initial?.ageDisplay || 'hidden',
    });
  };

  return (
    <div>
      <h2 style={{ fontFamily: 'var(--font-display)', margin: '0 0 4px' }}>
        {isNew ? 'プロフィールを作成' : 'プロフィールを編集'}
      </h2>
      <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '0 0 18px' }}>
        {isNew ? '曲データの持ち主として使う名前です。Googleドライブでの保存・共有時にも使われます。' : '表示名・画像を更新できます。'}
      </p>

      <Field label="プロフィール画像">
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Avatar name={name} size={56} src={avatarDataUrl} />
          <div>
            <div style={{ position: 'relative', display: 'inline-block' }}>
              <Button variant="quiet" style={{ pointerEvents: 'none' }}>
                <Plus size={13} /> 画像をアップロード
              </Button>
              <input
                type="file"
                accept="image/*"
                onChange={handleFile}
                style={{
                  position: 'absolute', inset: 0, width: '100%', height: '100%',
                  opacity: 0, cursor: 'pointer',
                }}
              />
            </div>
            {avatarDataUrl && (
              <Button variant="quiet" onClick={() => setAvatarDataUrl('')} style={{ marginLeft: 6 }}>
                <X size={13} /> 削除
              </Button>
            )}
            {imgError && <p style={{ color: 'var(--danger, #9C3B2E)', fontSize: 11.5, margin: '6px 0 0' }}>{imgError}</p>}
          </div>
        </div>
      </Field>

      <Field label="表示名" required>
        <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="例: とある合唱人" />
        <p style={{ fontSize: 11, color: 'var(--ink-soft)', margin: '5px 2px 0' }}>
          曲リストを共有した際、共有相手にこの表示名が見えます。本名を避け、ニックネーム等の利用をおすすめします。
        </p>
      </Field>

      {error && <p style={{ color: 'var(--danger, #9C3B2E)', fontSize: 12.5, margin: '0 0 12px' }}>{error}</p>}
      {disabled && (
        <p style={{ color: 'var(--danger, #9C3B2E)', fontSize: 12, margin: '0 0 12px' }}>
          利用規約とプライバシーポリシーへの同意が必要です。
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
        {onCancel && <Button variant="quiet" onClick={onCancel}>キャンセル</Button>}
        <Button variant="primary" onClick={submit} disabled={disabled}>
          <Check size={14} /> 保存する
        </Button>
      </div>

      {cropFile && (
        <ImageCropModal
          file={cropFile}
          onCancel={() => setCropFile(null)}
          onConfirm={(dataUrl) => { setAvatarDataUrl(dataUrl); setCropFile(null); }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  曲登録・編集フォーム                                                */
/* ------------------------------------------------------------------ */

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function SongForm({ initial, onSave, onCancel, onDuplicate, allSongs = [] }) {
  const [d, setD] = useState(() => ({ ...emptySongDraft(), ...(initial || {}) }));
  const [customTag, setCustomTag] = useState('');
  const [error, setError] = useState('');
  const set = (k) => (v) => setD((prev) => ({ ...prev, [k]: v }));
  const setSungRecord = (k) => (v) => setD((prev) => ({ ...prev, sungRecord: { ...(prev.sungRecord || {}), [k]: v } }));

  // 「歌った記録」欄が表示されていて、まだ日付が未入力の場合は当日の日付を初期値として入れておく
  // (何を入力すればいいか分かりにくい、という声への対応。もちろん後から自由に変更できる)。
  useEffect(() => {
    const hasSungTag = (d.tags || []).some((t) => t.name === SUNG_TAG_NAME);
    if (hasSungTag && !d.sungRecord?.date) {
      setSungRecord('date')(todayISO());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.tags]);

  const uniq = (arr) => Array.from(new Set(arr.filter(Boolean)));
  const titleSuggestions = useMemo(() => uniq(allSongs.map((s) => s.title)), [allSongs]);
  const suiteGenreSuggestions = useMemo(() => uniq(allSongs.map((s) => s.suiteGenre)), [allSongs]);
  const suiteTitleSuggestions = useMemo(() => uniq(allSongs.map((s) => s.suiteTitle)), [allSongs]);
  const lyricistSuggestions = useMemo(() => buildNameSuggestions(allSongs, 'lyricist', SEED_LYRICISTS), [allSongs]);
  const composerSuggestions = useMemo(() => buildNameSuggestions(allSongs, 'composer', SEED_COMPOSERS), [allSongs]);
  const arrangerSuggestions = useMemo(() => uniq([...allSongs.map((s) => s.arranger), ...SEED_ARRANGERS]), [allSongs]);

  const getTagState = (name) => {
    const found = (d.tags || []).find((t) => t.name === name);
    return found ? found.visibility : 'none';
  };

  const cycleTag = (name) => {
    setD((prev) => {
      const tags = prev.tags || [];
      const idx = tags.findIndex((t) => t.name === name);
      if (idx === -1) return { ...prev, tags: [...tags, { name, visibility: 'public' }] };
      if (tags[idx].visibility === 'public') {
        const next = [...tags];
        next[idx] = { name, visibility: 'private' };
        return { ...prev, tags: next };
      }
      return { ...prev, tags: tags.filter((t) => t.name !== name) };
    });
  };

  const addCustomTag = () => {
    const t = customTag.trim();
    if (!t || (d.tags || []).some((x) => x.name === t)) return;
    setD((prev) => ({ ...prev, tags: [...(prev.tags || []), { name: t, visibility: 'public' }] }));
    setCustomTag('');
  };

  const buildValidatedDraft = () => {
    if (!d.title.trim() || !d.formation) {
      setError('曲名・編成は必須です。');
      return null;
    }
    const lyricist = mergeName(d.lyricist);
    const composer = mergeName(d.composer);
    const arranger = mergeName(d.arranger);
    if (!lyricist || !composer) {
      setError('作詩・作曲は必須です。');
      return null;
    }
    return { ...d, lyricist, composer, arranger };
  };

  const submit = () => {
    const draft = buildValidatedDraft();
    if (draft) onSave(draft);
  };

  const startDuplicate = () => {
    onDuplicate({ ...d, id: undefined, sourceSongId: undefined, sourceUserName: undefined });
  };

  const customTags = (d.tags || []).filter((t) => !TAG_PRESETS.includes(t.name));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <h2 style={{ fontFamily: 'var(--font-display)', margin: '0 0 18px' }}>
          {initial?.id ? '曲を編集' : '曲を登録'}
        </h2>
        {initial?.id && (
          <Button variant="quiet" onClick={startDuplicate} title="今の内容をコピーして、別の新しい曲として入力を始めます">
            <Copy size={13} /> 複製して新規登録
          </Button>
        )}
      </div>
      <Field label="曲名" required>
        <SuggestInput value={d.title} onChange={set('title')} suggestions={titleSuggestions} placeholder="例: 大地讃頌" />
      </Field>
      <Field label="よみがな(任意・曲名順での並び替え精度が上がります)">
        <TextInput value={d.titleKana} onChange={(e) => set('titleKana')(e.target.value)} placeholder="例: だいちさんしょう" />
      </Field>

      <Field label="組曲">
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <SuggestInput
              value={d.suiteGenre}
              onChange={set('suiteGenre')}
              suggestions={suiteGenreSuggestions}
              placeholder="例: 混声合唱のためのカンタータ"
            />
          </div>
          <div style={{ flex: 1 }}>
            <SuggestInput
              value={d.suiteTitle}
              onChange={set('suiteTitle')}
              suggestions={suiteTitleSuggestions}
              placeholder="例: 土の歌"
            />
          </div>
        </div>
        {d.suiteTitle && (
          <div style={{ marginTop: 8 }}>
            <label style={{ fontSize: 12, color: 'var(--ink-soft)' }}>組曲タイトルのよみがな(任意・組曲名順での並び替え精度が上がります)</label>
            <TextInput
              value={d.suiteTitleKana}
              onChange={(e) => set('suiteTitleKana')(e.target.value)}
              placeholder="例: つちのうた"
            />
          </div>
        )}
        {d.suiteTitle && (
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 12, color: 'var(--ink-soft)' }}>組曲内での順番</label>
            <TextInput
              type="number"
              min="1"
              step="1"
              value={d.suiteOrder ?? ''}
              onChange={(e) => {
                const n = e.target.value === '' ? '' : Math.max(1, Math.round(Number(e.target.value)));
                set('suiteOrder')(n);
              }}
              placeholder="例: 1"
              style={{ width: 90 }}
            />
            <span style={{ fontSize: 11, color: 'var(--ink-soft)' }}>1番目、2番目...と入力(未入力なら曲名順)</span>
          </div>
        )}
      </Field>

      <NameField
        label="作詩" required
        value={d.lyricist} onChange={set('lyricist')}
        suggestions={lyricistSuggestions}
        placeholder="例: 大木惇夫"
      />
      <NameField
        label="作曲" required
        value={d.composer} onChange={set('composer')}
        suggestions={composerSuggestions}
        placeholder="例: 佐藤眞"
      />
      <NameField
        label="編曲"
        value={d.arranger} onChange={set('arranger')}
        suggestions={arrangerSuggestions}
      />

      <Field label="発表年">
        <TextInput style={{ width: 120 }} value={d.year} onChange={(e) => set('year')(e.target.value.replace(/[^0-9]/g, ''))} placeholder="1962" />
      </Field>
      <Field label="編成" required>
        <SelectWithOther
          value={d.formation} other={d.formationOther}
          onChange={set('formation')} onOtherChange={set('formationOther')}
          options={FORMATIONS} placeholder="選択してください"
        />
      </Field>
      <Field label="伴奏">
        <SelectWithOther
          value={d.accompaniment} other={d.accompanimentOther}
          onChange={set('accompaniment')} onOtherChange={set('accompanimentOther')}
          options={ACCOMPANIMENTS} placeholder="選択してください"
        />
      </Field>
      <Field label="言語">
        <SelectWithOther
          value={d.language} other={d.languageOther}
          onChange={set('language')} onOtherChange={set('languageOther')}
          options={LANGUAGES} placeholder="選択してください"
        />
      </Field>
      <Field label="お気に入り演奏動画URL">
        <TextInput value={d.videoUrl} onChange={(e) => set('videoUrl')(e.target.value)} placeholder="https://..." />
      </Field>
      <Field label="楽譜入手先">
        <TextInput value={d.scoreSource} onChange={(e) => set('scoreSource')(e.target.value)} placeholder="出版社・URLなど" />
      </Field>

      <Field label="タグ">
        <p style={{ fontSize: 11, color: 'var(--ink-soft)', margin: '0 0 8px' }}>
          タップするたびに切り替わります: 未選択 → 公開 → 自分だけ → 未選択
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {TAG_PRESETS.map((tag) => (
            <TagCycleChip key={tag} name={tag} state={getTagState(tag)} onClick={() => cycleTag(tag)} />
          ))}
        </div>
        {customTags.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
            {customTags.map((t) => (
              <TagCycleChip key={t.name} name={t.name} state={t.visibility} onClick={() => cycleTag(t.name)} />
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <TextInput
            value={customTag}
            onChange={(e) => setCustomTag(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomTag(); } }}
            placeholder="自由なタグを追加(公開で追加されます)"
          />
          <Button onClick={addCustomTag}><Plus size={13} /> 追加</Button>
        </div>
      </Field>

      {getTagState(SUNG_TAG_NAME) !== 'none' && (
        <Field label="歌った記録">
          <p style={{ fontSize: 11, color: 'var(--ink-soft)', margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: 4 }}>
            <EyeOff size={11} /> ここに入力する内容は、公開・非公開の設定に関わらず自分にしか表示されません。
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <TextInput
              value={d.sungRecord?.concertName || ''}
              onChange={(e) => setSungRecord('concertName')(e.target.value)}
              placeholder="演奏会名"
            />
            <div style={{ display: 'flex', gap: 10 }}>
              <TextInput
                type="date" style={{ flex: 1 }}
                value={d.sungRecord?.date || ''}
                onChange={(e) => setSungRecord('date')(e.target.value)}
              />
              <TextInput
                style={{ flex: 1 }}
                value={d.sungRecord?.place || ''}
                onChange={(e) => setSungRecord('place')(e.target.value)}
                placeholder="場所"
              />
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <TextInput
                style={{ flex: 1 }}
                value={d.sungRecord?.choir || ''}
                onChange={(e) => setSungRecord('choir')(e.target.value)}
                placeholder="歌った合唱団"
              />
              <TextInput
                style={{ flex: 1 }}
                value={d.sungRecord?.conductor || ''}
                onChange={(e) => setSungRecord('conductor')(e.target.value)}
                placeholder="指揮者"
              />
            </div>
            <TextArea
              value={d.sungRecord?.memo || ''}
              onChange={(e) => setSungRecord('memo')(e.target.value)}
              placeholder="メモ"
            />
          </div>
        </Field>
      )}

      {SOCIAL_FEATURES_ENABLED && (
        <Field label="公開設定">
          <label style={{
            display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5,
            color: 'var(--ink-soft)', cursor: 'pointer',
          }}>
            <input
              type="checkbox"
              checked={!!d.isPrivate}
              onChange={(e) => set('isPrivate')(e.target.checked)}
              style={{ width: 15, height: 15, marginTop: 1 }}
            />
            <span>
              {d.isPrivate ? <Lock size={13} style={{ verticalAlign: -2, marginRight: 4 }} /> : <Eye size={13} style={{ verticalAlign: -2, marginRight: 4 }} />}
              この曲を非公開にする(自分だけのリストに入れる)
              <br />
              <span style={{ fontSize: 11, color: 'var(--ink-soft)' }}>
                オンにすると、フォロワーや検索から見つけた人からは見えなくなります。
              </span>
            </span>
          </label>
        </Field>
      )}

      {error && <p style={{ color: 'var(--danger, #9C3B2E)', fontSize: 12.5, margin: '0 0 12px' }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4, flexWrap: 'wrap' }}>
        <Button variant="quiet" onClick={onCancel}>キャンセル</Button>
        <Button variant="primary" onClick={submit}><Check size={14} /> 保存する</Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  メインアプリ                                                        */
/* ------------------------------------------------------------------ */

export default function App() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(emptyData());
  const [meId, setMeId] = useState(null);
  const [view, setView] = useState('mypage');
  const [viewedUserId, setViewedUserId] = useState(null);
  const [showProfileForm, setShowProfileForm] = useState(false);
  const [profileFormMode, setProfileFormMode] = useState('new');
  const [showSwitcher, setShowSwitcher] = useState(false);
  const switcherRef = useRef(null);
  useEffect(() => {
    if (!showSwitcher) return;
    const handleOutside = (e) => {
      if (switcherRef.current && !switcherRef.current.contains(e.target)) {
        setShowSwitcher(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('touchstart', handleOutside);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('touchstart', handleOutside);
    };
  }, [showSwitcher]);
  const [skipGoogleChoice, setSkipGoogleChoice] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [googleSignedIn, setGoogleSignedIn] = useState(false);
  const googleSignedInRef = useRef(false); // イベントリスナー内から常に最新値を参照するため
  googleSignedInRef.current = googleSignedIn;
  const [googleAccount, setGoogleAccount] = useState(null); // {name, email, picture}
  const [driveSyncStatus, setDriveSyncStatus] = useState('idle'); // idle | syncing | error
  // Googleログイン直後、Drive上に既にプロフィールが見つかった場合、自動でどちらか決めず
  // ユーザーに選んでもらうための候補一覧。null = 選択待ちなし。
  const [driveAccountCandidates, setDriveAccountCandidates] = useState(null);
  const [driveError, setDriveError] = useState('');
  const driveTokenRef = useRef(null);
  const driveFileIdRef = useRef(null);
  // Googleログイン直後、Driveからのダウンロード・反映(reconcile)が終わるまでの間、
  // syncToDriveによるアップロードを止めておくためのフラグ。これが無いと、ダウンロードが
  // 完了する前に端末側の(まだ同期前の)ローカルデータでDrive上の正しいデータを
  // 上書きしてしまい、別端末で同じGoogleアカウントにログインした時に「別ユーザーとして
  // 登録されてしまう」不具合の原因になっていた。
  const driveReconcilingRef = useRef(false);
  const googleTokenClientRef = useRef(null);
  const [themePanelOpen, setThemePanelOpen] = useState(false);
  const [songModal, setSongModal] = useState(null);
  const [sharedIncoming, setSharedIncoming] = useState(null); // { url, field } | null
  const [songFormKey, setSongFormKey] = useState(0);
  const songWindowRef = useRef(null);
  const openSongForm = (draft) => {
    // スマホ・タブレットでは、ホーム画面への追加状況に関わらず常に画面内モーダルで開く
    // (別ウィンドウのポップアップだと、毎回ブラウザに許可を聞かれてしまうため)。
    if (!isStandaloneApp() && !isMobileDevice()) {
      if (songWindowRef.current && !songWindowRef.current.closed) {
        songWindowRef.current.focus();
        return;
      }
      const params = new URLSearchParams();
      params.set('popup', 'songform');
      if (draft && draft.id) {
        params.set('id', draft.id);
      } else if (draft) {
        // 新規作成時のみ、簡単な事前入力値をURLに乗せてポップアップ側へ引き継ぐ
        if (draft.videoUrl) params.set('prefillVideoUrl', draft.videoUrl);
        if (draft.scoreSource) params.set('prefillScoreSource', draft.scoreSource);
      }
      const url = `${window.location.pathname}?${params.toString()}`;
      const w = window.open(url, 'chorusdb-song-form', 'width=560,height=820,noopener=false');
      if (w) {
        songWindowRef.current = w;
        w.focus();
        return;
      }
      // ポップアップがブロックされた場合は、この画面内で開く形にフォールバックする
    }
    setSongFormKey((k) => k + 1);
    setSongModal(draft);
  };
  const [adGate, setAdGate] = useState(null); // { seconds, label, onDone, onCancel } | null
  const runWithAdGate = (seconds, label, action, countsTowardDailyCap = true) => {
    setAdGate({
      seconds, label,
      onDone: async () => { setAdGate(null); if (countsTowardDailyCap) await bumpTodayAdViewCount(); action(); },
      onCancel: () => setAdGate(null),
    });
  };
  const startNewSongRegistration = async () => {
    const count = await bumpSongRegistrationCount();
    const accountAgeMs = Date.now() - (me?.createdAt || Date.now());
    const pastFreePeriod = accountAgeMs >= AD_FREE_DAYS * 24 * 60 * 60 * 1000;
    const todayViews = await getTodayAdViewCount();
    const underDailyCap = todayViews < AD_DAILY_CAP;
    if (pastFreePeriod && isAdDueForCount(count) && underDailyCap) {
      runWithAdGate(15, '曲の登録を続ける前に', () => openSongForm({}));
    } else {
      openSongForm({});
    }
  };
  const [showCsvImport, setShowCsvImport] = useState(false);
  const [openingStarterPack, setOpeningStarterPack] = useState(null); // 開封中のスターターパック
  const [, forceCooldownRefresh] = useState(0);
  useEffect(() => {
    // スターターパックのクールダウン表示を定期的に更新する(厳密なリアルタイムでなくてよいので1分間隔)
    if (view !== 'starterpack') return undefined;
    const t = setInterval(() => forceCooldownRefresh((n) => n + 1), 60000);
    return () => clearInterval(t);
  }, [view]);
  const [showShareList, setShowShareList] = useState(false);
  const [showImportList, setShowImportList] = useState(false);
  const [importListInitialCode, setImportListInitialCode] = useState('');
  const [showEventCreate, setShowEventCreate] = useState(false);
  const [showProfileShare, setShowProfileShare] = useState(false);
  const [restorePending, setRestorePending] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [search, setSearch] = useState('');
  const [discoverIds, setDiscoverIds] = useState([]);
  const [dbFilters, setDbFilters] = useState(emptySongFilters());
  const [dbSort, setDbSort] = useState('random');
  const [groupBySuite, setGroupBySuite] = useState(false);
  const [showPlaylist, setShowPlaylist] = useState(false);
  const [showScrollTop, setShowScrollTop] = useState(false);
  useEffect(() => {
    const onScroll = () => setShowScrollTop(window.scrollY > 600);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  const [detailMode, setDetailMode] = useState('simple'); // 'simple' | 'detail'
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const toggleSelectId = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const [visibleCount, setVisibleCount] = useState(10);
  const loadMoreRef = useRef(null);
  const hasMoreMySongsRef = useRef(false); // IntersectionObserverのコールバックから常に最新値を参照するため
  const [viewFilters, setViewFilters] = useState(emptySongFilters());
  const [viewSort, setViewSort] = useState('random');
  const [randomSeed, setRandomSeed] = useState(() => Math.random().toString(36).slice(2));
  const shuffleSongs = () => setRandomSeed(Math.random().toString(36).slice(2));
  const [motionPermissionNeeded, setMotionPermissionNeeded] = useState(false);
  const [motionEnabled, setMotionEnabled] = useState(false);
  const [shakePref, setShakePref] = useState(true); // 「スマホを振ってシャッフル」機能のオン/オフ(マイページで設定)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.DeviceMotionEvent) return;
    setMotionPermissionNeeded(typeof window.DeviceMotionEvent.requestPermission === 'function');
    if (typeof window.DeviceMotionEvent.requestPermission !== 'function') setMotionEnabled(true);
  }, []);
  /* ---- 「スマホを振ってシャッフル」のオン/オフ切り替え(マイページの設定から呼ばれる) ----
     オンにする際、iOSなど許可が必要な端末ではここでモーションの許可をリクエストする
     (ユーザー操作の直後でないと許可ダイアログが出せないため、トグル操作そのものをトリガーにする)。
     許可が下りなければオンにはせず、そのままオフの状態を保つ。 */
  const setShakeToShuffleEnabled = async (nextEnabled) => {
    if (nextEnabled && motionPermissionNeeded && !motionEnabled) {
      try {
        const result = await window.DeviceMotionEvent.requestPermission();
        if (result !== 'granted') {
          showToast('端末の設定でモーションの許可が必要です');
          return;
        }
        setMotionEnabled(true);
      } catch (e) {
        showToast('モーションの許可を取得できませんでした');
        return;
      }
    }
    setShakePref(nextEnabled);
    saveShakePref(nextEnabled);
    showToast(nextEnabled ? 'スマホを振ってシャッフルする機能をオンにしました' : 'スマホを振ってシャッフルする機能をオフにしました');
  };

  /* ---- スマホを振ってシャッフル(対応端末のみ。非対応でも問題なく無視される) ----
     マイページの設定(shakePref)がオン、かつ端末の許可(motionEnabled)が下りている場合のみ動作する。
     動画のプレイリスト再生中(showPlaylist)は、シェイク操作が再生の妨げになるため一時的に無効化する。
     showPlaylistがfalseに戻ればこの条件を再び満たすので、閉じると自動的に元の設定へ戻る。 */
  useEffect(() => {
    if (typeof window === 'undefined' || !window.DeviceMotionEvent) return;
    if (view !== 'mydb' || dbSort !== 'random' || !motionEnabled || !shakePref || showPlaylist) return;
    let lastShake = 0;
    let lastAccel = null;
    const SHAKE_THRESHOLD = 18; // m/s^2 の変化量(体感で調整済み)
    const onMotion = (e) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null) return;
      if (lastAccel) {
        const delta = Math.abs(a.x - lastAccel.x) + Math.abs(a.y - lastAccel.y) + Math.abs(a.z - lastAccel.z);
        const now = Date.now();
        if (delta > SHAKE_THRESHOLD && now - lastShake > 1200) {
          lastShake = now;
          shuffleSongs();
          showToast('シャッフルしました');
        }
      }
      lastAccel = { x: a.x, y: a.y, z: a.z };
    };
    window.addEventListener('devicemotion', onMotion);
    return () => window.removeEventListener('devicemotion', onMotion);
  }, [view, dbSort, motionEnabled, shakePref, showPlaylist]);
  useEffect(() => {
    setVisibleCount(10);
  }, [dbFilters, dbSort, groupBySuite, randomSeed]);
  useEffect(() => {
    if (view !== 'mydb') return;
    const el = loadMoreRef.current;
    if (!el) return;
    // 依存配列にvisibleCountを含めない: 曲を読み込むたびに監視をいったん切って作り直すと、
    // タイミングによっては次の検知が働かなくなることがあった(下までスクロールしても
    // 読み込みが進まなくなる不具合の原因)。監視自体はこの画面にいる間ずっと同じものを使い続け、
    // hasMoreMySongsRefで「まだ続きがあるか」を常に最新の状態で判定するようにする。
    const obs = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && hasMoreMySongsRef.current) {
        setVisibleCount((v) => v + 10);
      }
    }, { rootMargin: '300px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [view, groupBySuite]);
  const [songDetail, setSongDetail] = useState(null);
  const [followListMode, setFollowListMode] = useState(null);
  const [unfollowConfirm, setUnfollowConfirm] = useState(null);
  const [reportTarget, setReportTarget] = useState(null);
  const [encounterUser, setEncounterUser] = useState(null);
  const [encounterAutoScan, setEncounterAutoScan] = useState(false);
  const [themeId, setThemeId] = useState('wine');
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);
  const currentTheme = getTheme(themeId);
  const [showWhatsNew, setShowWhatsNew] = useState(false); // 起動時の「アップデートのお知らせ」自動表示用
  const [showWhatsNewHistory, setShowWhatsNewHistory] = useState(false); // マイページの「お知らせ」から開く全履歴用

  const showToast = (msg) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2200);
  };

  useEffect(() => {
    (async () => {
      const [d, s, t, shk] = await Promise.all([loadData(), loadSession(), loadThemeId(), loadShakePref()]);
      setData(d);
      setThemeId(t);
      setShakePref(shk);
      if (s?.currentUserId && d.users[s.currentUserId]) {
        setMeId(s.currentUserId);
      } else {
        setShowProfileForm(true);
        setProfileFormMode('new');
      }
      // 「前回見た時より新しいお知らせ」があれば自動表示する。
      // ただし、この端末で一度もアプリを開いたことが無い(=最後に見たバージョンの記録が無い)場合は、
      // 初回起動時に大量のお知らせをいきなり見せても意味が無いので、黙って「今の最新版」を
      // 見た事にしておくだけにする(次にアップデートがあった時から通知が始まる)。
      const lastSeen = loadLastSeenChangelogVersion();
      const latest = getLatestChangelogVersion();
      if (!lastSeen) {
        saveLastSeenChangelogVersion(latest);
      } else if (latest > lastSeen) {
        setShowWhatsNew(true);
      }
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (!meId) return;
    const hash = window.location.hash?.slice(1);
    if (hash) {
      setImportListInitialCode(hash);
      setShowImportList(true);
    }
    const params = new URLSearchParams(window.location.search);
    if (params.has('shared_url') || params.has('shared_text') || params.has('shared_title')) {
      const url = extractUrlFromShareParams(params);
      if (url) {
        setSharedIncoming({ url, field: guessSharedLinkField(url) });
      }
      // 共有パラメータをURLから消しておく(再読み込み時に何度も反応しないように)
      window.history.replaceState({}, '', window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meId]);

  const changeTheme = async (id) => {
    const applyChange = () => { setThemeId(id); saveThemeId(id); };
    try {
      const count = await bumpThemeChangeCount();
      if (count >= 2) {
        runWithAdGate(10, 'テーマを変更する前に', applyChange, false);
        return;
      }
    } catch (e) {
      console.warn('テーマ変更回数の記録に失敗しました。広告表示なしでテーマを適用します', e);
    }
    applyChange();
  };

  /* ---- Drive同期 ----
     ログインしていない間は何もしない(従来通りIndexedDBのみ)。
     ログイン中は、ローカル保存に加えてDrive上のJSONファイルも更新する。 */
  const syncToDrive = useCallback(async (next) => {
    const token = driveTokenRef.current;
    if (!token) return;
    if (driveReconcilingRef.current) {
      // Driveからの初回ダウンロード・反映が終わるまではアップロードしない(上記の理由を参照)。
      // このタイミングの変更はreconcile完了後に改めてsetDataされるため、失われることはない。
      return;
    }
    setDriveSyncStatus('syncing');
    try {
      const result = await driveUpload(token, driveFileIdRef.current, next);
      if (result?.id) driveFileIdRef.current = result.id;
      setDriveSyncStatus('idle');
      setDriveError('');
    } catch (e) {
      console.warn('Driveへの同期に失敗しました', e);
      setDriveSyncStatus('error');
      setDriveError(e.message || 'Driveへの同期に失敗しました');
    }
  }, []);

  const persist = useCallback((updater) => {
    setData((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      saveData(next);
      syncToDrive(next);
      return next;
    });
  }, [syncToDrive]);

  /* ---- 別ウィンドウで開いた「曲を登録」フォームからの保存通知を受け取る ---- */
  useEffect(() => {
    const handler = (event) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== 'chorusdb:song-saved') return;
      loadData().then((fresh) => {
        setData(fresh);
        syncToDrive(fresh);
        showToast('曲を登録しました');
      });
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [syncToDrive]);

  /* ---- 保険: タブにフォーカスが戻った時にもデータを読み直す ----
     別ウィンドウからの保存通知(postMessage)がブラウザによっては届かない/タイミングが
     ずれることがあるため、フォーカス復帰時に必ず最新のIndexedDBの内容を読み直して補完する。 */
  useEffect(() => {
    let last = Date.now();
    const refresh = () => {
      const now = Date.now();
      if (now - last < 500) return; // 短時間の連続発火を間引く
      last = now;
      loadData().then((fresh) => setData(fresh));
    };
    const onVisibility = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  /* ---- Googleログイン(任意) ----
     GOOGLE_CLIENT_IDが未設定のままの場合はログインボタン自体を出さない(空実装で壊れないように)。 */
  const googleConfigured = GOOGLE_CLIENT_ID && !GOOGLE_CLIENT_ID.startsWith('YOUR_GOOGLE_OAUTH_CLIENT_ID');
  const driveShareConfigured = GOOGLE_API_KEY && !GOOGLE_API_KEY.startsWith('YOUR_GOOGLE_API_KEY');

  const shareSongsViaDrive = useCallback(async (songs, fromName) => {
    const token = driveTokenRef.current;
    if (!token) throw new Error('Googleにログインしていません');
    const filename = `うたコレ_共有_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const payload = { v: 1, from: fromName || '', songs: songs.map(songToShareEntry) };
    const fileId = await driveCreatePublicJsonFile(token, filename, payload);
    return encodeDriveSharePayload(fromName, fileId);
  }, []);

  const applyDriveDataAfterSignIn = useCallback(async (token) => {
    driveReconcilingRef.current = true;
    setDriveSyncStatus('syncing');
    let awaitingChoice = false;
    try {
      let fileId = await driveFindFileId(token);
      if (fileId) {
        driveFileIdRef.current = fileId;
        const remote = await driveDownload(token, fileId);
        if (remote && remote.users && remote.songs && Object.keys(remote.users).length > 0) {
          // Drive上に既存のプロフィールが見つかった。ここで自動的にどちらかへ決め打ちせず、
          // 「このアカウントでログインする」か「別のプロフィールとして新規作成する」かを
          // ユーザーに選んでもらう(下のdriveAccountCandidatesの分岐UIを参照)。
          // データ自体はこの時点で読み込んでおく(新規作成を選んだ場合も、既存プロフィールを
          // 消さずに追加する形にするため)。
          setData(remote);
          await saveData(remote);
          // Object.values(remote.users)だと、古い形式のデータでプロフィール側にuserIdが
          // 正しく入っていない場合に選択できなくなるため、users(マップ)のキーを確実にuserIdとして使う。
          setDriveAccountCandidates(Object.entries(remote.users).map(([uid, u]) => ({ ...u, userId: uid })));
          awaitingChoice = true;
        }
      } else {
        // Drive側にまだファイルが無い場合、現在ローカルにあるデータを初期データとしてアップロード
        const current = await loadData();
        const result = await driveUpload(token, null, current);
        driveFileIdRef.current = result.id;
      }
      setDriveSyncStatus('idle');
      setDriveError('');
    } catch (e) {
      console.warn('Driveからの読み込みに失敗しました', e);
      setDriveSyncStatus('error');
      setDriveError(e.message || 'Driveからの読み込みに失敗しました');
    } finally {
      // ユーザーの選択待ちの場合は、選択されるまでsyncToDriveでのアップロードを止めておく
      // (下のchooseExistingDriveAccount/chooseNewProfileOnThisDriveで解除する)。
      if (!awaitingChoice) driveReconcilingRef.current = false;
    }
  }, []);

  // Drive上の既存プロフィールをそのまま使う場合
  const chooseExistingDriveAccount = (userId) => {
    setMeId(userId);
    saveSession({ currentUserId: userId });
    setDriveAccountCandidates(null);
    driveReconcilingRef.current = false;
    setView('mydb');
    // アプリ起動直後(まだGoogleログイン前)、ローカルにプロフィールが無い端末では
    // 「新規プロフィール作成」の別モーダル(showProfileForm)を開く予約が入ってしまっている。
    // Driveから既存プロフィールを読み込めた今、その予約は不要になったので必ず閉じておく。
    // これを消さないと、正しいアカウントが読み込まれた裏で、この編集モーダルが
    // 覆いかぶさって表示されてしまう(キャンセルすると正しい画面が見える、という症状の原因)。
    setShowProfileForm(false);
  };
  // Drive上に既存プロフィールがあっても、この端末では別の新しいプロフィールを作る場合
  // (例: 同じGoogleアカウントを家族で共有しているなど)。既存のプロフィールは消さず、
  // 新しいプロフィールを追加する形になる(createProfileがusersをマージするため)。
  const chooseNewProfileOnThisDrive = () => {
    setDriveAccountCandidates(null);
    driveReconcilingRef.current = false;
  };

  const handleGoogleToken = useCallback((tokenResponse) => {
    if (tokenResponse?.error) {
      showToast('Googleログインに失敗しました');
      return;
    }
    driveTokenRef.current = tokenResponse.access_token;
    setGoogleSignedIn(true);
    try { localStorage.setItem(GOOGLE_SIGNED_IN_FLAG, '1'); } catch (e) { /* noop */ }
    fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: driveAuthHeader(tokenResponse.access_token) })
      .then((r) => (r.ok ? r.json() : null))
      .then((info) => { if (info) setGoogleAccount({ name: info.name, email: info.email, picture: info.picture }); })
      .catch(() => {});
    applyDriveDataAfterSignIn(tokenResponse.access_token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyDriveDataAfterSignIn]);

  useEffect(() => {
    if (!googleConfigured) return undefined;
    let cancelled = false;

    let wasSignedIn = false;
    try { wasSignedIn = localStorage.getItem(GOOGLE_SIGNED_IN_FLAG) === '1'; } catch (e) { /* noop */ }

    // 「以前ログインしたことがある場合、裏で自動的に再ログインを試みる」処理は、ユーザー操作
    // (タップ・クリック)を伴わずにブラウザのAPI(ポップアップの仕組み)を呼び出すことになるため、
    // スマホのブラウザでは毎回「ポップアップウィンドウが開きます」という警告が表示されてしまう。
    // これを避けるため、アプリを開いた直後には自動実行せず、ユーザーが画面に最初に触れた
    // (タップ・クリックした)その瞬間に1度だけ試みるようにする。
    // トークンクライアントの準備ができる前にタップされても取りこぼさないよう、フラグで管理する。
    let tapped = false;
    const tryAutoReconnect = () => {
      document.removeEventListener('pointerdown', onFirstTap);
      if (cancelled || googleSignedInRef.current || !googleTokenClientRef.current) return;
      googleTokenClientRef.current.requestAccessToken({ prompt: '' });
    };
    const onFirstTap = () => {
      tapped = true;
      tryAutoReconnect();
    };
    if (wasSignedIn) {
      document.addEventListener('pointerdown', onFirstTap, { once: true });
    }

    const trySetup = () => {
      if (cancelled) return;
      if (!window.google?.accounts?.oauth2) { setTimeout(trySetup, 300); return; }
      googleTokenClientRef.current = window.google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: DRIVE_SCOPE,
        callback: handleGoogleToken,
      });
      // 準備ができるより前にすでにタップされていた場合は、ここで取りこぼさず実行する
      if (wasSignedIn && tapped) tryAutoReconnect();
    };
    trySetup();

    return () => {
      cancelled = true;
      document.removeEventListener('pointerdown', onFirstTap);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleConfigured, handleGoogleToken]);

  const signInWithGoogle = () => {
    if (!googleTokenClientRef.current) { showToast('Googleログインの準備中です。少し待ってから再度お試しください'); return; }
    googleTokenClientRef.current.requestAccessToken({ prompt: 'consent' });
  };

  const signOutFromGoogle = () => {
    const token = driveTokenRef.current;
    if (token && window.google?.accounts?.oauth2) {
      window.google.accounts.oauth2.revoke(token, () => {});
    }
    driveTokenRef.current = null;
    driveFileIdRef.current = null;
    setGoogleSignedIn(false);
    setGoogleAccount(null);
    setDriveSyncStatus('idle');
    setDriveError('');
    try { localStorage.removeItem(GOOGLE_SIGNED_IN_FLAG); } catch (e) { /* noop */ }
    showToast('Googleからログアウトしました(データは端末に残っています)');
  };

  const [deletingDriveData, setDeletingDriveData] = useState(false);
  const [installPromptEvent, setInstallPromptEvent] = useState(null);
  useEffect(() => {
    if (isStandaloneApp()) return;
    const handler = (e) => { e.preventDefault(); setInstallPromptEvent(e); };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);
  const promptInstall = async () => {
    if (!installPromptEvent) return;
    installPromptEvent.prompt();
    await installPromptEvent.userChoice;
    setInstallPromptEvent(null);
  };
  const isIos = typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent);
  const [showIosInstallHint, setShowIosInstallHint] = useState(false);
  const shareAppLink = async () => {
    const url = 'https://sunplusnetwork-del.github.io/Utacolle/';
    const shareData = { title: 'うたコレ', text: '合唱曲コレクションアプリ「うたコレ」', url };
    if (navigator.share) {
      try { await navigator.share(shareData); return; } catch (e) { /* ユーザーがキャンセルした場合など、何もしない */ }
    } else {
      const ok = await copyToClipboard(url);
      showToast(ok ? 'リンクをコピーしました' : 'コピーできませんでした');
    }
  };
  const [showDriveDeleteConfirm, setShowDriveDeleteConfirm] = useState(false);
  const deleteDriveBackup = async () => {
    const token = driveTokenRef.current;
    if (!token) { showToast('Googleにログインしていません'); return; }
    setDeletingDriveData(true);
    try {
      const fileId = driveFileIdRef.current || (await driveFindFileId(token));
      if (fileId) {
        await driveDeleteFile(token, fileId);
        driveFileIdRef.current = null;
      }
      showToast('Googleドライブ上のバックアップデータを削除しました');
    } catch (e) {
      showToast('削除に失敗しました: ' + (e.message || ''));
    } finally {
      setDeletingDriveData(false);
    }
  };

  const [deletingAccount, setDeletingAccount] = useState(false);
  const [showDeleteAccountConfirm, setShowDeleteAccountConfirm] = useState(false);
  const deleteAccount = async () => {
    setDeletingAccount(true);
    try {
      const token = driveTokenRef.current;
      if (token) {
        try {
          const fileId = driveFileIdRef.current || (await driveFindFileId(token));
          if (fileId) await driveDeleteFile(token, fileId);
        } catch (e) { /* ベストエフォート。失敗しても端末内データの削除は続行する */ }
        if (window.google?.accounts?.oauth2) {
          window.google.accounts.oauth2.revoke(token, () => {});
        }
      }
      driveTokenRef.current = null;
      driveFileIdRef.current = null;
      try { localStorage.removeItem(GOOGLE_SIGNED_IN_FLAG); } catch (e) { /* noop */ }

      await saveData(emptyData());
      await saveSession({});

      setData(emptyData());
      setMeId(null);
      setGoogleSignedIn(false);
      setGoogleAccount(null);
      setSkipGoogleChoice(false);
      setAgreedToTerms(false);
      setShowDeleteAccountConfirm(false);
      showToast('アカウントを削除しました');
    } catch (e) {
      showToast('削除に失敗しました: ' + (e.message || ''));
    } finally {
      setDeletingAccount(false);
    }
  };

  const me = meId ? data.users[meId] : null;
  const allUserIds = Object.keys(data.users);
  const mySongsRaw = useMemo(
    () => Object.values(data.songs).filter((s) => s.ownerId === meId),
    [data.songs, meId]
  );
  const mySongsAll = useMemo(
    () => sortSongs(filterSongs(mySongsRaw, dbFilters), dbSort, randomSeed),
    [mySongsRaw, dbFilters, dbSort, randomSeed]
  );
  const mySongs = mySongsAll.slice(0, visibleCount);
  const hasMoreMySongs = mySongsAll.length > visibleCount;
  hasMoreMySongsRef.current = hasMoreMySongs;
  const suiteGroups = useMemo(() => {
    if (!groupBySuite) return null;
    const groups = [];
    const indexOf = new Map();
    const ungrouped = [];
    // 組曲でまとめる時は、検索・絞り込みや表示件数の制限を受けず、コレクション内の全曲を対象に
    // 組曲を組み立てる。そうしないと、絞り込みやページネーションの都合で組曲の一部の曲だけ
    // 表示されてしまうことがあったため。
    const source = sortSongs(mySongsRaw, dbSort, randomSeed);
    source.forEach((s) => {
      const key = (s.suiteTitle || '').trim();
      if (!key) { ungrouped.push(s); return; }
      if (!indexOf.has(key)) {
        indexOf.set(key, groups.length);
        groups.push({ suiteTitle: key, suiteGenre: s.suiteGenre || '', songs: [] });
      }
      groups[indexOf.get(key)].songs.push(s);
    });
    groups.forEach((g) => {
      g.songs.sort((a, b) => {
        const ao = a.suiteOrder === '' || a.suiteOrder == null ? null : Number(a.suiteOrder);
        const bo = b.suiteOrder === '' || b.suiteOrder == null ? null : Number(b.suiteOrder);
        if (ao != null && bo != null) return ao - bo;
        if (ao != null) return -1;
        if (bo != null) return 1;
        return a.title.localeCompare(b.title, 'ja');
      });
    });
    return { groups, ungrouped };
  }, [groupBySuite, mySongsRaw, dbSort, randomSeed]);

  const followerIds = allUserIds.filter((uid) => (data.users[uid].followees || []).includes(meId));
  const followerCount = followerIds.length;
  const followingIds = me?.followees || [];

  /* ---- プロフィール ---- */

  const createProfile = ({ userId, displayName, bio, avatarDataUrl, birthDate, ageDisplay }) => {
    persist((prev) => ({
      ...prev,
      users: {
        ...prev.users,
        [userId]: {
          userId, displayName, bio, avatarDataUrl, birthDate, ageDisplay,
          followees: [], createdAt: Date.now(),
          reportedBy: [], vouchedBy: [], frozen: false, blockedIds: [], autoFollow: false,
          eventFlags: [],
        },
      },
    }));
    setMeId(userId);
    saveSession({ currentUserId: userId });
    setShowProfileForm(false);
    setView('mypage');
    showToast('プロフィールを作成しました');
  };

  const updateProfile = ({ displayName, bio, avatarDataUrl, birthDate, ageDisplay }) => {
    persist((prev) => ({
      ...prev,
      users: { ...prev.users, [meId]: { ...prev.users[meId], displayName, bio, avatarDataUrl, birthDate, ageDisplay } },
    }));
    setShowProfileForm(false);
    showToast('プロフィールを更新しました');
  };

  const switchTo = (uid) => {
    setMeId(uid);
    saveSession({ currentUserId: uid });
    setShowSwitcher(false);
    setView('mypage');
  };

  /* ---- 曲 CRUD ---- */

  const saveSong = (draft) => {
    persist((prev) => {
      const songs = { ...prev.songs };
      if (draft.id) {
        songs[draft.id] = { ...songs[draft.id], ...draft, updatedAt: Date.now() };
      } else {
        const id = genId('song');
        songs[id] = { ...draft, id, ownerId: meId, createdAt: Date.now(), updatedAt: Date.now() };
      }
      return { ...prev, songs };
    });
    setSongModal(null);
    showToast(draft.id ? '曲を更新しました' : '曲を登録しました');
  };

  const bulkImportSongs = (items) => {
    let added = 0, skipped = 0, updated = 0;
    persist((prev) => {
      const nextSongs = { ...prev.songs };
      items.forEach(({ song: s, action, existingId, mergeFields }) => {
        if (action === 'skip') { skipped++; return; }
        if (action === 'overwrite' && existingId && nextSongs[existingId]) {
          nextSongs[existingId] = overwriteSongInfo(nextSongs[existingId], s);
          updated++;
          return;
        }
        if (action === 'merge' && existingId && nextSongs[existingId]) {
          nextSongs[existingId] = mergeSongInfo(nextSongs[existingId], s, mergeFields);
          updated++;
          return;
        }
        const id = genId('song');
        nextSongs[id] = { ...s, id, ownerId: meId, createdAt: Date.now(), updatedAt: Date.now() };
        added++;
      });
      return { ...prev, songs: nextSongs };
    });
    const parts = [];
    if (added) parts.push(`${added}件を追加`);
    if (updated) parts.push(`${updated}件を更新`);
    if (skipped) parts.push(`${skipped}件をスキップ`);
    showToast(parts.length ? parts.join('、') + 'しました' : '変更はありませんでした');
  };

  const applySharedLinkToSong = (songId, field, url) => {
    persist((prev) => ({
      ...prev,
      songs: { ...prev.songs, [songId]: { ...prev.songs[songId], [field]: url, updatedAt: Date.now() } },
    }));
    setSharedIncoming(null);
    showToast('リンクを登録しました');
  };

  const importSharedSongs = (items, fromName) => {
    let added = 0, skipped = 0, updated = 0;
    persist((prev) => {
      const nextSongs = { ...prev.songs };
      items.forEach(({ song: s, action, existingId, mergeFields }) => {
        if (action === 'skip') { skipped++; return; }
        if (action === 'overwrite' && existingId && nextSongs[existingId]) {
          nextSongs[existingId] = overwriteSongInfo(nextSongs[existingId], s);
          updated++;
          return;
        }
        if (action === 'merge' && existingId && nextSongs[existingId]) {
          nextSongs[existingId] = mergeSongInfo(nextSongs[existingId], s, mergeFields);
          updated++;
          return;
        }
        const id = genId('song');
        nextSongs[id] = { ...s, id, ownerId: meId, createdAt: Date.now(), updatedAt: Date.now(), sourceUserName: fromName || '共有リンク' };
        added++;
      });
      return { ...prev, songs: nextSongs };
    });
    const parts = [];
    if (added) parts.push(`${added}件を追加`);
    if (updated) parts.push(`${updated}件を更新`);
    if (skipped) parts.push(`${skipped}件をスキップ`);
    showToast(parts.length ? parts.join('、') + 'しました' : '変更はありませんでした');
  };

  const joinEvent = (evt) => {
    persist((prev) => {
      const meUser = prev.users[meId];
      const already = (meUser.eventFlags || []).some((f) => f.id === evt.id);
      if (already) return prev;
      const flag = { id: evt.id, name: evt.name, date: evt.date, host: evt.from, joinedAt: Date.now() };
      return { ...prev, users: { ...prev.users, [meId]: { ...meUser, eventFlags: [...(meUser.eventFlags || []), flag] } } };
    });
    showToast(`「${evt.name}」に参加しました`);
  };

  const saveScannedProfile = (p) => {
    if (p.userId === meId) { showToast('自分自身のプロフィールです'); return; }
    persist((prev) => {
      const existing = prev.users[p.userId];
      const merged = {
        ...(existing || {
          followees: [], createdAt: Date.now(), reportedBy: [], vouchedBy: [],
          frozen: false, blockedIds: [], autoFollow: false, eventFlags: [],
        }),
        userId: p.userId, displayName: p.displayName, bio: p.bio,
        metInPerson: true,
      };
      return { ...prev, users: { ...prev.users, [p.userId]: merged } };
    });
    showToast(`${p.displayName} さんのプロフィールを保存しました`);
  };

  const handleBackupFile = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!isValidBackupShape(parsed)) {
          showToast('このファイルはバックアップの形式と異なるようです');
          return;
        }
        setRestorePending(parsed);
      } catch (err) {
        showToast('ファイルを読み込めませんでした。JSON形式のバックアップファイルを選んでください');
      }
    };
    reader.onerror = () => showToast('ファイルの読み込みに失敗しました');
    reader.readAsText(file);
  };

  const confirmRestore = () => {
    if (!restorePending) return;
    persist(() => restorePending);
    const restoredUserIds = Object.keys(restorePending.users || {});
    const nextMeId = restoredUserIds.includes(meId) ? meId : restoredUserIds[0] || null;
    if (nextMeId) {
      setMeId(nextMeId);
      saveSession({ currentUserId: nextMeId });
    }
    setRestorePending(null);
    showToast('バックアップから復元しました');
  };

  const deleteSong = (id) => {
    persist((prev) => {
      const songs = { ...prev.songs };
      delete songs[id];
      return { ...prev, songs };
    });
    setDeleteConfirm(null);
    showToast('曲を削除しました');
  };
  const reorderSuiteGroup = (orderedIds) => {
    persist((prev) => {
      const songs = { ...prev.songs };
      orderedIds.forEach((id, i) => {
        if (songs[id]) songs[id] = { ...songs[id], suiteOrder: i + 1, updatedAt: Date.now() };
      });
      return { ...prev, songs };
    });
    showToast('並び順を保存しました');
  };

  const bulkDeleteSongs = (ids) => {
    persist((prev) => {
      const songs = { ...prev.songs };
      ids.forEach((id) => { delete songs[id]; });
      return { ...prev, songs };
    });
    setSelectedIds(new Set());
    setSelectMode(false);
    showToast(`${ids.length}件の曲を削除しました`);
  };

  const copySong = (song) => {
    const alreadyHas = Object.values(data.songs).some(
      (s) => s.ownerId === meId && s.sourceSongId === (song.sourceSongId || song.id)
    );
    if (alreadyHas) return;
    const newId = genId('song');
    const { id, ownerId, createdAt, sourceUserName, tags, sungRecord, ...rest } = song;
    persist((prev) => ({
      ...prev,
      songs: {
        ...prev.songs,
        [newId]: {
          ...rest, id: newId, ownerId: meId, createdAt: Date.now(), tags: [],
          sungRecord: { concertName: '', date: '', place: '', choir: '', conductor: '', memo: '' },
          sourceSongId: song.sourceSongId || song.id,
          sourceUserName: data.users[song.ownerId]?.displayName || '不明',
        },
      },
    }));
    showToast('自分のDBに追加しました');
  };

  /* ---- フォロー ---- */

  const toggleFollow = (uid) => {
    persist((prev) => {
      const meUser = prev.users[meId];
      const followees = meUser.followees || [];
      const next = followees.includes(uid) ? followees.filter((x) => x !== uid) : [...followees, uid];
      return { ...prev, users: { ...prev.users, [meId]: { ...meUser, followees: next } } };
    });
  };

  const requestFollowToggle = (uid) => {
    if ((me.followees || []).includes(uid)) {
      setUnfollowConfirm(uid);
    } else {
      toggleFollow(uid);
      showToast(`${data.users[uid]?.displayName || ''}さんをフォローしました`);
    }
  };

  const confirmUnfollow = () => {
    const uid = unfollowConfirm;
    toggleFollow(uid);
    setUnfollowConfirm(null);
    showToast(`${data.users[uid]?.displayName || ''}さんのフォローを外しました`);
  };

  /* ---- 通報・擁護・凍結・ブロック ---- */

  const reportUser = (uid, reason) => {
    persist((prev) => {
      const target = prev.users[uid];
      if ((target.reportedBy || []).includes(meId)) return prev;
      const reportedBy = [...(target.reportedBy || []), meId];
      const frozen = target.frozen || reportScore({ ...target, reportedBy }) >= REPORT_THRESHOLD;
      return {
        ...prev,
        users: { ...prev.users, [uid]: { ...target, reportedBy, frozen, lastReportReason: reason } },
      };
    });
    setReportTarget(null);
    showToast('通報しました');
  };

  const vouchUser = (uid) => {
    persist((prev) => {
      const target = prev.users[uid];
      if ((target.vouchedBy || []).includes(meId)) return prev;
      const vouchedBy = [...(target.vouchedBy || []), meId];
      return { ...prev, users: { ...prev.users, [uid]: { ...target, vouchedBy } } };
    });
    showToast('擁護しました。通報のストックが1つ減りました');
  };

  const toggleBlock = (uid) => {
    persist((prev) => {
      const meUser = prev.users[meId];
      const blockedIds = meUser.blockedIds || [];
      const nowBlocking = !blockedIds.includes(uid);
      const nextBlocked = nowBlocking ? [...blockedIds, uid] : blockedIds.filter((x) => x !== uid);
      const nextFollowees = nowBlocking ? (meUser.followees || []).filter((x) => x !== uid) : (meUser.followees || []);
      return {
        ...prev,
        users: { ...prev.users, [meId]: { ...meUser, blockedIds: nextBlocked, followees: nextFollowees } },
      };
    });
    const nowBlocking = !(me.blockedIds || []).includes(uid);
    showToast(nowBlocking ? 'ブロックしました' : 'ブロックを解除しました');
  };

  const demoUnfreeze = (uid) => {
    persist((prev) => ({
      ...prev,
      users: { ...prev.users, [uid]: { ...prev.users[uid], frozen: false, reportedBy: [], vouchedBy: [] } },
    }));
    showToast('(デモ)凍結を解除しました');
  };

  /* ---- すれ違い(デモ)シミュレーター ---- */
  /* 実機のBluetooth/位置情報を使った本物のすれ違い通信は、
     ブラウザのプロトタイプでは実現できないため、ここでは
     「近くに利用者がいたら知らせる」体験だけを模擬しています。 */

  const simulateEncounter = useCallback((isManual) => {
    const meUserNow = data.users[meId];
    const candidates = allUserIds.filter((uid) => (
      uid !== meId &&
      !isBlockedEitherWay(meUserNow, uid, data.users) &&
      !(meUserNow?.followees || []).includes(uid)
    ));
    if (candidates.length === 0) {
      if (isManual) showToast('他の利用者がまだいません(プロフィール切替から増やせます)');
      return;
    }
    const uid = candidates[Math.floor(Math.random() * candidates.length)];
    setEncounterUser(uid);
    setData((prevData) => {
      const meUser = prevData.users[meId];
      if (meUser?.autoFollow && !(meUser.followees || []).includes(uid)) {
        const next = { ...prevData, users: { ...prevData.users, [meId]: { ...meUser, followees: [...(meUser.followees || []), uid] } } };
        saveData(next);
        showToast(`${prevData.users[uid]?.displayName || ''}さんを自動でフォローしました`);
        return next;
      }
      return prevData;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allUserIds, meId, data]);

  useEffect(() => {
    if (!encounterUser) return;
    const t = setTimeout(() => setEncounterUser(null), 8000);
    return () => clearTimeout(t);
  }, [encounterUser]);

  useEffect(() => {
    if (!encounterAutoScan) return;
    const t = setInterval(() => simulateEncounter(false), 60000);
    return () => clearInterval(t);
  }, [encounterAutoScan, simulateEncounter]);

  /* ---- 検索・おすすめ ---- */

  const searchResults = search.trim()
    ? allUserIds.filter((uid) => uid !== meId && !isBlockedEitherWay(me, uid, data.users) && (
        uid.toLowerCase().includes(search.trim().toLowerCase()) ||
        (data.users[uid].displayName || '').toLowerCase().includes(search.trim().toLowerCase())
      ))
    : [];

  const shuffleDiscover = () => {
    const candidates = allUserIds.filter((uid) => uid !== meId && !isBlockedEitherWay(me, uid, data.users));
    const shuffled = [...candidates].sort(() => Math.random() - 0.5);
    setDiscoverIds(shuffled.slice(0, 3));
  };

  useEffect(() => {
    if (view === 'discover' && discoverIds.length === 0) shuffleDiscover();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, allUserIds.length]);

  useEffect(() => {
    setViewFilters(emptySongFilters());
    setViewSort('newest');
  }, [viewedUserId]);

  /* ---------------------------------------------------------------- */

  if (loading) {
    return (
      <Wrap theme={currentTheme}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 40, color: 'var(--ink-soft)' }}>
          <Loader2 size={18} className="spin" /> 読み込み中...
          <style>{`.spin{animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        </div>
      </Wrap>
    );
  }

  if (!me) {
    const showGoogleChoice = googleConfigured && !googleSignedIn && !skipGoogleChoice;

    if (driveAccountCandidates) {
      return (
        <Wrap theme={currentTheme}>
          <div style={{ maxWidth: 440, margin: '40px auto', background: 'var(--surface, #fff)', borderRadius: 12, padding: 26, border: '1px solid var(--line)' }}>
            <img src={bannerUrl} alt="うたコレ" style={{ width: '100%', maxWidth: 280, display: 'block', margin: '0 auto 18px' }} />
            <h2 style={{ fontFamily: 'var(--font-display)', margin: '0 0 6px', fontSize: 19 }}>Googleドライブに既存のデータがあります</h2>
            <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', lineHeight: 1.7, margin: '0 0 18px' }}>
              このGoogleアカウントのドライブには、以前に作成したプロフィールが見つかりました。
              続けるか、この端末用に新しいプロフィールを作るか選んでください。
            </p>
            {driveAccountCandidates.map((u) => (
              <button key={u.userId} onClick={() => chooseExistingDriveAccount(u.userId)} style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '12px 14px',
                background: 'var(--wine)', color: '#fff', border: 'none', borderRadius: 10,
                cursor: 'pointer', fontSize: 14, fontWeight: 700, marginBottom: 10, textAlign: 'left',
              }}>
                <Avatar name={u.displayName} src={u.avatarDataUrl} size={30} />
                <span>
                  「{u.displayName}」として続ける
                  <div style={{ fontSize: 11, fontWeight: 400, opacity: 0.9, marginTop: 2 }}>
                    このプロフィールの曲データを、この端末に読み込みます
                  </div>
                </span>
              </button>
            ))}
            <button onClick={chooseNewProfileOnThisDrive} style={{
              display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '12px 14px',
              background: 'var(--surface, #fff)', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 10,
              cursor: 'pointer', fontSize: 14, fontWeight: 600,
            }}>
              <UserPlus size={18} />
              <span style={{ textAlign: 'left' }}>
                この端末用に新しいプロフィールを作る
                <div style={{ fontSize: 11, fontWeight: 400, color: 'var(--ink-soft)', marginTop: 2 }}>
                  同じGoogleドライブの中に、別のプロフィールとして追加されます(既存のプロフィールは消えません)
                </div>
              </span>
            </button>
          </div>
        </Wrap>
      );
    }

    return (
      <Wrap theme={currentTheme}>
        <div style={{ maxWidth: 440, margin: '40px auto', background: 'var(--surface, #fff)', borderRadius: 12, padding: 26, border: '1px solid var(--line)' }}>
          <img src={bannerUrl} alt="うたコレ" style={{ width: '100%', maxWidth: 280, display: 'block', margin: '0 auto 18px' }} />

          <label style={{
            display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, color: 'var(--ink-soft)',
            lineHeight: 1.6, marginBottom: 18, cursor: 'pointer', background: 'var(--paper)',
            padding: '10px 12px', borderRadius: 8,
          }}>
            <input
              type="checkbox"
              checked={agreedToTerms}
              onChange={(e) => setAgreedToTerms(e.target.checked)}
              style={{ width: 15, height: 15, marginTop: 1, flexShrink: 0 }}
            />
            <span>
              <a href="./terms.html" target="_blank" rel="noreferrer">利用規約</a>と
              <a href="./privacy.html" target="_blank" rel="noreferrer">プライバシーポリシー</a>
              を読み、内容に同意します
            </span>
          </label>

          {showGoogleChoice ? (
            <>
              <h2 style={{ fontFamily: 'var(--font-display)', margin: '0 0 6px', fontSize: 19 }}>はじめに</h2>
              <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', lineHeight: 1.7, margin: '0 0 20px' }}>
                曲データの保存方法を選んでください。あとから設定を変えることもできます。
              </p>
              <button onClick={signInWithGoogle} disabled={!agreedToTerms} style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '14px 16px',
                background: agreedToTerms ? 'var(--wine)' : '#c7bdb4', color: '#fff', border: 'none', borderRadius: 10,
                cursor: agreedToTerms ? 'pointer' : 'not-allowed', fontSize: 14, fontWeight: 700, marginBottom: 10,
              }}>
                <UserPlus size={18} />
                <span style={{ textAlign: 'left' }}>
                  Googleでログインする
                  <div style={{ fontSize: 11, fontWeight: 400, opacity: 0.9, marginTop: 2 }}>
                    自分のGoogleドライブ(アプリ専用の非公開領域)にも自動保存され、他の端末からも同じデータを使えます
                  </div>
                </span>
              </button>
              <button onClick={() => setSkipGoogleChoice(true)} disabled={!agreedToTerms} style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '14px 16px',
                background: 'var(--surface, #fff)', color: agreedToTerms ? 'var(--ink)' : '#b8b0a8', border: '1px solid var(--line)', borderRadius: 10,
                cursor: agreedToTerms ? 'pointer' : 'not-allowed', fontSize: 14, fontWeight: 600,
              }}>
                <Music2 size={18} />
                <span style={{ textAlign: 'left' }}>
                  この端末だけで使う
                  <div style={{ fontSize: 11, fontWeight: 400, color: 'var(--ink-soft)', marginTop: 2 }}>
                    ログインなし。データはこの端末のブラウザ内だけに保存されます(あとからログインも可能)
                  </div>
                </span>
              </button>
              <p style={{ fontSize: 10.5, color: 'var(--ink-soft)', lineHeight: 1.6, margin: '16px 0 0' }}>
                いずれの場合も、曲やプロフィールを他の人と共有する際はQRコード/URLのみを使い、
                Googleドライブの共有設定が使われることはありません。
              </p>
            </>
          ) : googleSignedIn && driveSyncStatus === 'syncing' ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '20px 0', color: 'var(--ink-soft)' }}>
              <Loader2 size={18} className="spin" /> ドライブのデータを確認しています...
              <style>{`.spin{animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}`}</style>
            </div>
          ) : (
            <ProfileForm isNew existingIds={allUserIds} onSave={createProfile} disabled={!agreedToTerms} />
          )}
        </div>
        <div style={{ textAlign: 'center', marginTop: 14, display: 'flex', gap: 14, justifyContent: 'center' }}>
          <a href="./about.html" style={{ fontSize: 11.5, color: 'var(--ink-soft)', textDecoration: 'underline' }}>うたコレとは</a>
          <a href="./terms.html" style={{ fontSize: 11.5, color: 'var(--ink-soft)', textDecoration: 'underline' }}>利用規約</a>
          <a href="./privacy.html" style={{ fontSize: 11.5, color: 'var(--ink-soft)', textDecoration: 'underline' }}>プライバシーポリシー</a>
        </div>
      </Wrap>
    );
  }

  if (me.frozen) {
    return (
      <Wrap theme={currentTheme}>
        <div style={{ maxWidth: 460, margin: '30px auto', background: 'var(--surface, #fff)', borderRadius: 12, padding: 26, border: '1px solid var(--line)', textAlign: 'center' }}>
          <div style={{
            width: 52, height: 52, borderRadius: '50%', background: 'var(--wine-soft)', color: 'var(--wine)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px',
          }}>
            <Lock size={24} />
          </div>
          <h2 style={{ fontFamily: 'var(--font-display)', margin: '0 0 8px' }}>アカウントが凍結されています</h2>
          <p style={{ fontSize: 13, color: 'var(--ink-soft)', lineHeight: 1.7, margin: '0 0 18px' }}>
            通報が一定数に達したため、このアカウントは一時的に利用できません。
            凍結を解除するには、下記のユーザーIDを開発者にご連絡ください。
          </p>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, background: 'var(--paper)', border: '1px solid var(--line)',
            borderRadius: 8, padding: '10px 14px', marginBottom: 20, justifyContent: 'center',
          }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14 }}>@{me.userId}</span>
            <Button onClick={async () => {
              const ok = await copyToClipboard(me.userId);
              showToast(ok ? 'IDをコピーしました' : `コピーできませんでした。手動で「${me.userId}」をお伝えください`);
            }}>
              <Copy size={13} /> コピー
            </Button>
          </div>
          <div style={{ borderTop: '1px dashed var(--line)', paddingTop: 16 }}>
            <p style={{ fontSize: 11.5, color: 'var(--ink-soft)', margin: '0 0 10px' }}>
              (プロトタイプ確認用: 本番では上記の連絡を受けてから解除しますが、ここではその場で解除できます)
            </p>
            <Button variant="quiet" onClick={() => demoUnfreeze(meId)}>
              <ShieldCheck size={13} /> (デモ)凍結を解除する
            </Button>
          </div>
        </div>
      </Wrap>
    );
  }

  const viewedUser = viewedUserId ? data.users[viewedUserId] : null;
  const viewedSongsRaw = viewedUserId
    ? Object.values(data.songs).filter((s) => s.ownerId === viewedUserId && !s.isPrivate)
    : [];
  const viewedSongs = sortSongs(filterSongs(viewedSongsRaw, viewFilters), viewSort, randomSeed);
  const iFollowViewed = viewedUserId && (me.followees || []).includes(viewedUserId);
  const viewedBlocked = viewedUserId ? isBlockedEitherWay(me, viewedUserId, data.users) : false;
  const iAlreadyReported = viewedUserId ? (viewedUser?.reportedBy || []).includes(meId) : false;
  const iAlreadyVouched = viewedUserId ? (viewedUser?.vouchedBy || []).includes(meId) : false;
  const mySourceIds = new Set(mySongsRaw.map((s) => s.sourceSongId).filter(Boolean));

  return (
    <Wrap theme={currentTheme}>
      {/* ヘッダー */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px 6px 6px',
          background: '#E5E5E5', borderRadius: 'var(--radius-pill, 999px)',
        }}>
          <img src={appIconUrl} alt="うたコレ" style={{ width: 38, height: 38, borderRadius: 9, objectFit: 'cover' }} />
          <img src={wordmarkUrl} alt="うたコレ UTA-COLLE" style={{ height: 32, width: 'auto', display: 'block' }} />
        </div>
        <div style={{ position: 'relative' }} ref={switcherRef}>
          <button onClick={() => setShowSwitcher((v) => !v)} style={{
            display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface, #fff)', border: '1px solid var(--line)',
            borderRadius: 'var(--radius-pill, 20px)', padding: '4px 10px 4px 4px', cursor: 'pointer',
          }}>
            <Avatar name={me.displayName} size={26} src={me.avatarDataUrl} />
            <span style={{ fontSize: 13, fontWeight: 600 }}>{me.displayName}</span>
            <ChevronDown size={14} color="var(--ink-soft)" />
          </button>
          {showSwitcher && (
            <div style={{
              position: 'absolute', right: 0, top: 42, background: 'var(--surface, #fff)', border: '1px solid var(--line)',
              borderRadius: 10, width: 250, boxShadow: '0 10px 30px rgba(0,0,0,.12)', zIndex: 50, overflow: 'hidden',
            }}>
              <button onClick={() => { setShowSwitcher(false); setView('mypage'); }} style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 12px',
                background: view === 'mypage' ? 'var(--paper)' : 'transparent', border: 'none',
                borderBottom: '1px solid var(--line)', cursor: 'pointer', textAlign: 'left', fontSize: 13, fontWeight: 600,
              }}>
                <User size={14} /> マイページ
              </button>
              {googleConfigured && (
                <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--line)' }}>
                  {googleSignedIn ? (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        {googleAccount?.picture
                          ? <img src={googleAccount.picture} alt="" style={{ width: 22, height: 22, borderRadius: '50%' }} />
                          : <Avatar name={googleAccount?.name || 'G'} size={22} />}
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {googleAccount?.name || 'Googleでログイン中'}
                          </div>
                          <div style={{ fontSize: 10.5, color: 'var(--ink-soft)' }}>
                            {driveSyncStatus === 'syncing' ? 'ドライブと同期中…' : driveSyncStatus === 'error' ? `同期エラー: ${driveError}` : 'ドライブと同期済み'}
                          </div>
                        </div>
                      </div>
                      <button onClick={() => { setShowSwitcher(false); signOutFromGoogle(); }} style={{
                        display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '7px 8px',
                        background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 6, cursor: 'pointer', fontSize: 12.5,
                      }}>
                        <UserMinus size={13} /> ログアウト
                      </button>
                    </>
                  ) : (
                    <button onClick={() => { setShowSwitcher(false); signInWithGoogle(); }} style={{
                      display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '8px 10px',
                      background: 'var(--wine)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12.5, fontWeight: 600,
                    }}>
                      <UserPlus size={13} /> Googleでログインしてドライブに保存
                    </button>
                  )}
                  <div style={{ fontSize: 10.5, color: 'var(--ink-soft)', marginTop: 6, lineHeight: 1.5 }}>
                    ログインすると曲データが自分のGoogleドライブ(アプリ専用領域)にも保存されます。共有はこれまで通りQR/URLのみで、ドライブの共有設定は使いません。
                  </div>
                </div>
              )}
              {!googleSignedIn && (
                <>
                  <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--ink-soft)', borderBottom: '1px solid var(--line)' }}>
                    テスト用プロフィール切替(このドライブ未連携の端末のみ)
                  </div>
                  {allUserIds.map((uid) => (
                    <button key={uid} onClick={() => switchTo(uid)} style={{
                      display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '9px 12px',
                      background: uid === meId ? 'var(--paper)' : 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left',
                    }}>
                      <Avatar name={data.users[uid].displayName} size={22} src={data.users[uid].avatarDataUrl} />
                      <span style={{ fontSize: 13 }}>{data.users[uid].displayName}</span>
                      {uid === meId && <Check size={13} style={{ marginLeft: 'auto' }} color="var(--wine)" />}
                    </button>
                  ))}
                  <button onClick={() => { setShowSwitcher(false); setProfileFormMode('new'); setShowProfileForm(true); }} style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 12px',
                    background: 'transparent', border: 'none', borderTop: '1px solid var(--line)', cursor: 'pointer',
                    color: 'var(--wine)', fontSize: 13, fontWeight: 600,
                  }}>
                    <Plus size={14} /> 新規プロフィール作成
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      <StaffDivider />

      {/* ナビ */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 22, borderBottom: '1px solid var(--line)', paddingTop: 4 }}>
        <NavTab active={view === 'mydb'} onClick={() => setView('mydb')} icon={<Ticket size={15} />} label="コレクション" color="var(--wine)" />
        <NavTab active={view === 'starterpack'} onClick={() => setView('starterpack')} icon={<Gift size={15} />} label="スターターパック" color="var(--sage)" />
        {SOCIAL_FEATURES_ENABLED && (
          <NavTab active={view === 'discover'} onClick={() => { setView('discover'); setViewedUserId(null); }} icon={<Users size={15} />} label="さがす" color="var(--gold)" />
        )}
      </div>

      {/* ---- マイページ ---- */}
      {view === 'mypage' && (
        <div style={{ background: 'var(--surface, #fff)', border: '1px solid var(--line)', borderRadius: 12, padding: 22 }}>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <Avatar name={me.displayName} size={58} src={me.avatarDataUrl} />
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 20 }}>{me.displayName}</div>
                {SOCIAL_FEATURES_ENABLED && ageLabel(me) && (
                  <span style={{ fontSize: 11.5, color: 'var(--ink-soft)', border: '1px solid var(--line)', borderRadius: 'var(--radius-pill, 20px)', padding: '1px 8px' }}>
                    {ageLabel(me)}
                  </span>
                )}
              </div>
              {SOCIAL_FEATURES_ENABLED && (
                <div style={{ fontSize: 12.5, color: 'var(--ink-soft)', fontFamily: 'var(--font-mono)' }}>@{me.userId}</div>
              )}
            </div>
            {SOCIAL_FEATURES_ENABLED && (
              <Button variant="quiet" onClick={() => setShowProfileShare(true)}>
                <QrCode size={14} /> 共有
              </Button>
            )}
            <Button onClick={() => { setProfileFormMode('edit'); setShowProfileForm(true); }}>
              <Pencil size={14} /> 編集
            </Button>
          </div>
          {SOCIAL_FEATURES_ENABLED && me.bio && <p style={{ fontSize: 13.5, color: 'var(--ink)', marginTop: 14, lineHeight: 1.7 }}>{me.bio}</p>}
          <div style={{ display: 'flex', gap: 28, marginTop: 18, paddingTop: 18, borderTop: '1px solid var(--line)' }}>
            <Stat label="登録曲" value={mySongsRaw.length} onClick={() => setView('mydb')} />
            {SOCIAL_FEATURES_ENABLED && <Stat label="フォロー中" value={(me.followees || []).length} onClick={() => setFollowListMode('following')} />}
            {SOCIAL_FEATURES_ENABLED && <Stat label="フォロワー" value={followerCount} onClick={() => setFollowListMode('followers')} />}
          </div>
          {SOCIAL_FEATURES_ENABLED && reportScore(me) > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, padding: '10px 14px',
              background: 'var(--wine-soft)', color: 'var(--wine)', borderRadius: 8, fontSize: 12,
            }}>
              <Flag size={13} /> 現在 {reportScore(me)}/{REPORT_THRESHOLD} 件の通報を受けています。
              {REPORT_THRESHOLD}件に達するとアカウントが凍結されます。
            </div>
          )}
        </div>
      )}

      {view === 'mypage' && (
        <div style={{
          background: 'var(--surface, #fff)', border: '1px solid var(--line)', borderRadius: 12, padding: '16px 22px',
          marginTop: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        }}>
          <Share2 size={18} color="var(--wine)" style={{ flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 160 }}>
            <div style={{ fontWeight: 700, fontSize: 13.5 }}>うたコレを紹介する</div>
            <div style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>友人にアプリのリンクをすぐ送れます</div>
          </div>
          <Button variant="primary" onClick={shareAppLink}>
            <Share2 size={13} /> リンクを共有
          </Button>
        </div>
      )}

      {view === 'mypage' && !isStandaloneApp() && (
        <div style={{
          background: 'var(--surface, #fff)', border: '1px solid var(--line)', borderRadius: 12, padding: '16px 22px',
          marginTop: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        }}>
          <Ticket size={18} color="var(--wine)" style={{ flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 160 }}>
            <div style={{ fontWeight: 700, fontSize: 13.5 }}>ホーム画面に追加する</div>
            <div style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>アプリのように起動できるようになります</div>
          </div>
          {installPromptEvent ? (
            <Button variant="primary" onClick={promptInstall}>
              <Plus size={13} /> 追加する
            </Button>
          ) : (
            <Button variant="primary" onClick={() => setShowIosInstallHint(true)}>
              <Plus size={13} /> 追加方法を見る
            </Button>
          )}
        </div>
      )}

      {SOCIAL_FEATURES_ENABLED && view === 'mypage' && (
        <div style={{ background: 'var(--surface, #fff)', border: '1px solid var(--line)', borderRadius: 12, padding: 22, marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Ticket size={16} color="var(--wine)" />
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15 }}>参加したイベント</div>
            </div>
            <Button onClick={() => setShowEventCreate(true)}><QrCode size={13} /> イベントQRを作る</Button>
          </div>
          {(me.eventFlags || []).length === 0 ? (
            <p style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>
              まだ参加記録はありません。会場でイベントQRを読み取ると、ここに記録されます(自分だけに表示されます)。
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[...me.eventFlags].sort((a, b) => b.joinedAt - a.joinedAt).map((f) => (
                <div key={f.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                  background: 'var(--paper)', borderRadius: 8, fontSize: 12.5,
                }}>
                  <Ticket size={14} color="var(--ink-soft)" />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{f.name}</div>
                    <div style={{ color: 'var(--ink-soft)', fontSize: 11 }}>
                      {f.date && <>{f.date}・</>}{f.host && <>主催: {f.host}・</>}
                      参加: {new Date(f.joinedAt).toLocaleDateString('ja-JP')}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {SOCIAL_FEATURES_ENABLED && view === 'mypage' && (
        <div style={{ background: 'var(--surface, #fff)', border: '1px solid var(--line)', borderRadius: 12, padding: 22, marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Radar size={16} color="var(--wine)" />
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15 }}>すれ違い機能(デモ)</div>
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', lineHeight: 1.7, margin: '0 0 16px' }}>
            ブラウザのプロトタイプでは、実際のBluetooth等で近くの端末を検知することはできません。
            ここではアプリ版の体験を先取りするためのデモとして、登録済みユーザーの中から
            「近くにいる」相手をランダムに模擬しています。実機アプリ化の際にNearby Connections API
            (Android)やMultipeer Connectivity(iOS)などに置き換える想定です。
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 14 }}>
            <Button variant="primary" onClick={() => simulateEncounter(true)}>
              <Radar size={14} /> 今すぐすれ違いを試す
            </Button>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--ink-soft)', cursor: 'pointer' }}>
              <input type="checkbox" checked={encounterAutoScan} onChange={(e) => setEncounterAutoScan(e.target.checked)} style={{ width: 15, height: 15 }} />
              自動でチェックする
            </label>
          </div>
          <label style={{
            display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--ink-soft)',
            cursor: 'pointer', paddingTop: 14, borderTop: '1px solid var(--line)',
          }}>
            <input
              type="checkbox"
              checked={!!me.autoFollow}
              onChange={(e) => persist((prev) => ({ ...prev, users: { ...prev.users, [meId]: { ...prev.users[meId], autoFollow: e.target.checked } } }))}
              style={{ width: 15, height: 15 }}
            />
            <Bell size={13} />
            すれ違った相手を自動でフォローする
          </label>
        </div>
      )}

      {view === 'mypage' && (
        <div style={{ background: 'var(--surface, #fff)', border: '1px solid var(--line)', borderRadius: 12, padding: 22, marginTop: 16 }}>
          <button
            onClick={() => setThemePanelOpen((v) => !v)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'transparent',
              border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left',
            }}
          >
            <Sparkles size={16} color="var(--wine)" />
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, flex: 1 }}>画面のテーマ</div>
            <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{currentTheme.name}</span>
            {themePanelOpen ? <ChevronUp size={16} color="var(--ink-soft)" /> : <ChevronDown size={16} color="var(--ink-soft)" />}
          </button>
          {themePanelOpen && (
            <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 20 }}>
              {THEME_CATEGORIES.map((cat) => (
                <div key={cat.id}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-soft)', marginBottom: 8 }}>{cat.label}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: 10 }}>
                    {THEMES.filter((t) => t.category === cat.id).map((t) => (
                      <button
                        key={t.id}
                        onClick={() => changeTheme(t.id)}
                        title={t.name}
                        style={{
                          cursor: 'pointer', borderRadius: 10, padding: '10px 6px 8px',
                          border: themeId === t.id ? `2px solid ${t.wine}` : '1px solid var(--line)',
                          background: t.paper, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                        }}
                      >
                        <div style={{ display: 'flex', gap: 3 }}>
                          <span style={{ width: 14, height: 14, borderRadius: '50%', background: t.wine, display: 'inline-block' }} />
                          <span style={{ width: 14, height: 14, borderRadius: '50%', background: t.gold, display: 'inline-block' }} />
                          <span style={{ width: 14, height: 14, borderRadius: '50%', background: t.sage, display: 'inline-block' }} />
                        </div>
                        <span style={{ fontSize: 11, color: t.ink, fontWeight: themeId === t.id ? 700 : 500 }}>{t.name}</span>
                        {themeId === t.id && <Check size={12} color={t.wine} />}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {view === 'mypage' && (
        <div style={{ background: 'var(--surface, #fff)', border: '1px solid var(--line)', borderRadius: 12, padding: 22, marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <Shuffle size={16} color="var(--wine)" />
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15 }}>スマホを振ってシャッフル</div>
          </div>
          <p style={{ fontSize: 11.5, color: 'var(--ink-soft)', margin: '0 0 14px', lineHeight: 1.7 }}>
            コレクションを「ランダム」で並べているとき、スマホを振ると曲順をシャッフルできる機能です。
            不要な場合はオフにしてください。
          </p>
          <ToggleSwitch
            checked={shakePref && (!motionPermissionNeeded || motionEnabled)}
            onChange={(v) => setShakeToShuffleEnabled(v)}
            leftLabel="オフ"
            rightLabel="オン"
          />
          {motionPermissionNeeded && !motionEnabled && (
            <p style={{ fontSize: 11, color: 'var(--ink-soft)', margin: '10px 0 0', lineHeight: 1.7 }}>
              この端末ではモーションの許可が必要です。スイッチをオンにすると許可を確認するダイアログが表示されます。
            </p>
          )}
        </div>
      )}

      {view === 'mypage' && (
        <div style={{ background: 'var(--surface, #fff)', border: '1px solid var(--line)', borderRadius: 12, padding: 22, marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <Bell size={16} color="var(--wine)" />
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15 }}>お知らせ</div>
          </div>
          <p style={{ fontSize: 11.5, color: 'var(--ink-soft)', margin: '0 0 14px', lineHeight: 1.7 }}>
            うたコレの更新履歴を確認できます。
          </p>
          <Button variant="quiet" onClick={() => setShowWhatsNewHistory(true)}>
            <Bell size={13} /> 更新履歴を見る
          </Button>
        </div>
      )}

      {view === 'mypage' && (
        <div style={{ background: 'var(--surface, #fff)', border: '1px solid var(--line)', borderRadius: 12, padding: 22, marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <FileText size={16} color="var(--wine)" />
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15 }}>バックアップ</div>
          </div>
          <p style={{ fontSize: 11.5, color: 'var(--ink-soft)', margin: '0 0 14px', lineHeight: 1.7 }}>
            この端末のブラウザに保存されているデータです。機種変更やブラウザのデータ消去に備えて、
            ときどきバックアップを取っておくことをおすすめします。
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <a
              href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(data, null, 2))}`}
              download={`chorusdb_backup_${new Date().toISOString().slice(0, 10)}.json`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                fontSize: 13.5, fontFamily: 'var(--font-body)', fontWeight: 600, padding: '8px 14px',
                borderRadius: 6, background: 'var(--surface, #fff)', color: 'var(--ink)', border: '1px solid var(--line)',
                textDecoration: 'none',
              }}
            >
              <Copy size={13} /> 全データをバックアップ(JSON)
            </a>

            <div style={{ position: 'relative', display: 'inline-block' }}>
              <Button variant="quiet" style={{ pointerEvents: 'none' }}>
                <Plus size={13} /> バックアップから復元
              </Button>
              <input
                type="file"
                accept=".json,application/json"
                onChange={handleBackupFile}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer' }}
              />
            </div>

            <a
              href={csvDownloadHref(songsToCsv(mySongsRaw))}
              download={`chorusdb_songs_${new Date().toISOString().slice(0, 10)}.csv`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                fontSize: 13.5, fontFamily: 'var(--font-body)', fontWeight: 600, padding: '8px 14px',
                borderRadius: 6, background: 'var(--surface, #fff)', color: 'var(--ink)', border: '1px solid var(--line)',
                textDecoration: 'none',
              }}
            >
              <FileText size={13} /> コレクションをCSVで書き出す
            </a>
          </div>

          {googleSignedIn && (
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px dashed var(--line)' }}>
              <Button
                variant="quiet"
                onClick={() => setShowDriveDeleteConfirm(true)}
                disabled={deletingDriveData}
                style={{ color: 'var(--danger, #9C3B2E)' }}
              >
                {deletingDriveData ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />}
                Googleドライブ上のバックアップデータを削除
              </Button>
              <p style={{ fontSize: 11, color: 'var(--ink-soft)', margin: '6px 0 0' }}>
                この端末のデータは残したまま、Googleドライブの非公開領域(アプリ専用フォルダ)に
                保存されているバックアップだけを削除します。
              </p>
            </div>
          )}
        </div>
      )}

      {view === 'mypage' && (
        <div style={{ background: 'var(--surface, #fff)', border: '1px solid #E8B4AC', borderRadius: 12, padding: 22, marginTop: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--danger, #9C3B2E)', marginBottom: 6 }}>アカウントを削除</div>
          <p style={{ fontSize: 12, color: 'var(--ink-soft)', margin: '0 0 12px', lineHeight: 1.7 }}>
            プロフィールと登録した曲データを、この端末およびGoogleドライブ(ログイン中の場合)から
            すべて削除します。この操作は取り消せません。
          </p>
          <Button
            onClick={() => setShowDeleteAccountConfirm(true)}
            disabled={deletingAccount}
            style={{ background: 'var(--danger, #9C3B2E)', color: '#fff', border: '1px solid var(--danger, #9C3B2E)' }}
          >
            {deletingAccount ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />}
            アカウントを削除する
          </Button>
        </div>
      )}

      {view === 'mypage' && (
        <div style={{ textAlign: 'center', marginTop: 18, marginBottom: 6 }}>
          <div style={{ display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
            <a href="./guide.html" target="_blank" rel="noreferrer" style={{ fontSize: 11.5, color: 'var(--ink-soft)', textDecoration: 'underline' }}>
              使い方
            </a>
            <a href="./about.html" target="_blank" rel="noreferrer" style={{ fontSize: 11.5, color: 'var(--ink-soft)', textDecoration: 'underline' }}>
              うたコレとは
            </a>
            <a href="./terms.html" target="_blank" rel="noreferrer" style={{ fontSize: 11.5, color: 'var(--ink-soft)', textDecoration: 'underline' }}>
              利用規約
            </a>
            <a
              href="./privacy.html"
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 11.5, color: 'var(--ink-soft)', textDecoration: 'underline' }}
            >
              プライバシーポリシー
            </a>
            <a href="mailto:sunplus.network@gmail.com" style={{ fontSize: 11.5, color: 'var(--ink-soft)', textDecoration: 'underline' }}>
              お問い合わせ・ご要望
            </a>
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--ink-soft)' }}>© 2026 うたコレ</div>
        </div>
      )}

      {/* ---- スターターパック ---- */}
      {view === 'starterpack' && (
        <div>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 17, marginBottom: 4 }}>
              <Gift size={16} color="var(--sage)" style={{ verticalAlign: -2, marginRight: 4 }} />
              スターターパック
            </div>
            <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', lineHeight: 1.7, margin: 0 }}>
              あらかじめ用意された曲セットの中から、ランダムで{STARTER_PACK_DRAW_COUNT}曲がコレクションに追加できます。
              1つのパックを開封すると、そのパックは24時間再度開封できません。
            </p>
          </div>
          {STARTER_PACKS.length === 0 && (
            <EmptyState title="開封できるパックがありません" body="また今度のぞいてみてください。" />
          )}
          {STARTER_PACKS.map((pack) => {
            const cooldown = getStarterPackCooldownRemaining(pack.id);
            return (
              <div key={pack.id} style={{
                background: 'var(--surface, #fff)', border: '1px solid var(--line)', borderRadius: 12,
                padding: 18, marginBottom: 14, display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center', justifyContent: 'space-between',
              }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14.5, marginBottom: 4 }}>{pack.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--ink-soft)', lineHeight: 1.6 }}>{pack.description}</div>
                  <div style={{ fontSize: 11, color: 'var(--ink-soft)', marginTop: 4 }}>収録曲数: {pack.songs.length}曲</div>
                </div>
                {cooldown > 0 ? (
                  <Button variant="quiet" disabled>
                    <Lock size={13} /> {formatCooldown(cooldown)}
                  </Button>
                ) : (
                  <Button variant="sage" onClick={() => setOpeningStarterPack(pack)}>
                    <Gift size={14} /> 開封する(広告30秒)
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ---- マイDB ---- */}
      {view === 'mydb' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
            <div style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
              自分が歌った・聴いた曲を集めましょう
              {mySongsRaw.length > 0 && <span style={{ marginLeft: 8, fontWeight: 600, color: 'var(--ink)' }}>登録曲数: {mySongsRaw.length}曲</span>}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button variant="sage" onClick={() => setShowImportList(true)}><QrCode size={13} /> 読込</Button>
              <Button variant="gold" onClick={() => { setSelectedIds(new Set()); setShowShareList(true); }}><Share2 size={13} /> 共有</Button>
              <Button style={{ background: '#4A7A9C', color: '#fff', border: '1px solid #4A7A9C' }} onClick={() => setShowCsvImport(true)}><FileText size={13} /> CSV</Button>
              <Button
                style={{ background: '#8156A0', color: '#fff', border: '1px solid #8156A0' }}
                onClick={() => setShowPlaylist(true)}
                disabled={mySongsAll.filter((s) => s.videoUrl).length === 0}
              >
                <Film size={13} /> 再生
              </Button>
              <Button variant="primary" onClick={startNewSongRegistration}><Plus size={14} /> 登録</Button>
            </div>
          </div>

          {mySongsRaw.length > 0 && (
            <>
              <SongFilterBar filters={dbFilters} setFilters={setDbFilters} sort={dbSort} setSort={setDbSort} songs={mySongsRaw} onShuffle={shuffleSongs} />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center', marginBottom: 14 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--ink-soft)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={groupBySuite} onChange={(e) => setGroupBySuite(e.target.checked)} style={{ width: 14, height: 14 }} />
                  <BookOpen size={13} /> 組曲でまとめて表示する
                </label>
                <ToggleSwitch
                  checked={detailMode === 'detail'}
                  onChange={(isDetail) => {
                    setDetailMode(isDetail ? 'detail' : 'simple');
                    if (isDetail) { setSelectMode(false); setSelectedIds(new Set()); }
                  }}
                  leftLabel="簡易表示"
                  rightLabel="詳細表示"
                />
                {detailMode === 'simple' && (
                  <Button
                    variant={selectMode ? 'default' : 'quiet'}
                    onClick={() => { setSelectMode((v) => !v); setSelectedIds(new Set()); }}
                  >
                    {selectMode ? <X size={13} /> : <Check size={13} />} {selectMode ? '選択をやめる' : '複数選択'}
                  </Button>
                )}
              </div>
              {selectMode && (
                <div style={{
                  display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 14,
                  background: 'var(--gold-soft)', borderRadius: 8, padding: '8px 12px',
                }}>
                  <span style={{ fontSize: 12.5 }}>{selectedIds.size}曲を選択中</span>
                  <Button variant="quiet" onClick={() => setSelectedIds(new Set(mySongs.map((s) => s.id)))}>表示中を全選択</Button>
                  <Button variant="quiet" onClick={() => setSelectedIds(new Set())}>選択解除</Button>
                  <Button onClick={() => setShowShareList(true)} disabled={selectedIds.size === 0}><Share2 size={13} /> 選択した曲を共有</Button>
                  <Button
                    onClick={() => setDeleteConfirm({ bulk: true, ids: Array.from(selectedIds) })}
                    disabled={selectedIds.size === 0}
                    style={{ color: 'var(--danger, #9C3B2E)' }}
                  >
                    <Trash2 size={13} /> 選択した曲を削除
                  </Button>
                </div>
              )}
            </>
          )}

          {mySongsRaw.length === 0 ? (
            <EmptyState
              title="まだ曲が登録されていません"
              body="歌ったことのある曲、聴いたことのある曲を自由に登録できます。"
              actionLabel="最初の曲を登録する"
              onAction={startNewSongRegistration}
            />
          ) : mySongs.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>条件に一致する曲が見つかりません。</p>
          ) : groupBySuite && suiteGroups ? (
            <>
              {suiteGroups.groups.map((g) => (
                <SuiteGroupCard
                  key={g.suiteTitle}
                  suiteTitle={g.suiteTitle}
                  suiteGenre={g.suiteGenre}
                  songs={g.songs}
                  onReorder={reorderSuiteGroup}
                  renderSong={(s) => (
                    <SongCard
                      key={s.id} song={s} isMine
                      compact={detailMode === 'simple'}
                      selectable={selectMode} selected={selectedIds.has(s.id)} onToggleSelect={toggleSelectId}
                      onViewDetail={setSongDetail}
                      onOpen={() => (selectMode ? toggleSelectId(s.id) : setSongDetail(s))}
                      onEdit={() => openSongForm(s)}
                      onDelete={() => setDeleteConfirm(s)}
                      onShare={() => { setSelectedIds(new Set([s.id])); setShowShareList(true); }}
                    />
                  )}
                />
              ))}
              {suiteGroups.ungrouped.map((s) => (
                <SongCard
                  key={s.id} song={s} isMine
                  compact={detailMode === 'simple'}
                  selectable={selectMode} selected={selectedIds.has(s.id)} onToggleSelect={toggleSelectId}
                      onViewDetail={setSongDetail}
                  onOpen={() => (selectMode ? toggleSelectId(s.id) : setSongDetail(s))}
                  onEdit={() => openSongForm(s)}
                  onDelete={() => setDeleteConfirm(s)}
                  onShare={() => { setSelectedIds(new Set([s.id])); setShowShareList(true); }}
                />
              ))}
            </>
          ) : (
            mySongs.map((s) => (
              <SongCard
                key={s.id} song={s} isMine
                compact={detailMode === 'simple'}
                selectable={selectMode} selected={selectedIds.has(s.id)} onToggleSelect={toggleSelectId}
                      onViewDetail={setSongDetail}
                onOpen={() => (selectMode ? toggleSelectId(s.id) : setSongDetail(s))}
                onEdit={() => openSongForm(s)}
                onDelete={() => setDeleteConfirm(s)}
                onShare={() => { setSelectedIds(new Set([s.id])); setShowShareList(true); }}
              />
            ))
          )}

          {mySongs.length > 0 && !(groupBySuite && suiteGroups) && (
            <div ref={loadMoreRef} style={{ display: 'flex', justifyContent: 'center', padding: '14px 0' }}>
              {hasMoreMySongs && <Loader2 size={16} className="spin" color="var(--ink-soft)" />}
            </div>
          )}
        </div>
      )}

      {/* ---- さがす ---- */}
      {view === 'discover' && !viewedUserId && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 22 }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <Search size={15} style={{ position: 'absolute', left: 11, top: 10, color: 'var(--ink-soft)' }} />
              <TextInput
                style={{ paddingLeft: 34 }}
                placeholder="IDまたは表示名で検索"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          {search.trim() ? (
            <div style={{ marginBottom: 26 }}>
              <SectionLabel>検索結果</SectionLabel>
              {searchResults.length === 0 ? (
                <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>該当するユーザーが見つかりません。</p>
              ) : (
                searchResults.map((uid) => (
                  <UserRow
                    key={uid} user={data.users[uid]}
                    following={(me.followees || []).includes(uid)}
                    onFollow={() => requestFollowToggle(uid)}
                    onOpen={() => setViewedUserId(uid)}
                  />
                ))
              )}
            </div>
          ) : (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <SectionLabel><Sparkles size={13} /> おすすめユーザー</SectionLabel>
                <Button variant="quiet" onClick={shuffleDiscover}><Shuffle size={13} /> 入れ替える</Button>
              </div>
              {allUserIds.length <= 1 ? (
                <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
                  他のユーザーがまだいません。右上のプロフィール切替から新しいプロフィールを作って試してみましょう。
                </p>
              ) : (
                discoverIds.map((uid) => (
                  <UserRow
                    key={uid} user={data.users[uid]}
                    following={(me.followees || []).includes(uid)}
                    onFollow={() => requestFollowToggle(uid)}
                    onOpen={() => setViewedUserId(uid)}
                  />
                ))
              )}
            </div>
          )}
        </div>
      )}

      {/* ---- ユーザー詳細 ---- */}
      {view === 'discover' && viewedUserId && viewedUser && (
        <div>
          <Button variant="quiet" onClick={() => setViewedUserId(null)} style={{ marginBottom: 14 }}>
            <ChevronLeft size={15} /> 一覧に戻る
          </Button>
          <div style={{ background: 'var(--surface, #fff)', border: '1px solid var(--line)', borderRadius: 12, padding: 20, marginBottom: 20 }}>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
              <Avatar name={viewedUser.displayName} size={50} src={viewedUser.avatarDataUrl} />
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 18 }}>{viewedUser.displayName}</div>
                  {ageLabel(viewedUser) && (
                    <span style={{ fontSize: 11.5, color: 'var(--ink-soft)', border: '1px solid var(--line)', borderRadius: 'var(--radius-pill, 20px)', padding: '1px 8px' }}>
                      {ageLabel(viewedUser)}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)', fontFamily: 'var(--font-mono)' }}>@{viewedUser.userId}</div>
              </div>
              {!viewedUser.frozen && !viewedBlocked && (
                <Button
                  variant={iFollowViewed ? 'default' : 'primary'}
                  onClick={() => requestFollowToggle(viewedUserId)}
                >
                  {iFollowViewed ? <><UserMinus size={14} /> フォロー中</> : <><UserPlus size={14} /> フォローする</>}
                </Button>
              )}
            </div>
            {viewedUser.bio && !viewedBlocked && <p style={{ fontSize: 13, marginTop: 12, color: 'var(--ink)' }}>{viewedUser.bio}</p>}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
              <Button
                variant={viewedBlocked ? 'default' : 'quiet'}
                onClick={() => toggleBlock(viewedUserId)}
              >
                {viewedBlocked ? <><UserPlus size={13} /> ブロック解除</> : <><Ban size={13} /> ブロックする</>}
              </Button>
              {!viewedBlocked && !viewedUser.frozen && (
                iAlreadyReported ? (
                  <Button variant="quiet" disabled><Flag size={13} /> 通報済み</Button>
                ) : (
                  <Button variant="quiet" onClick={() => setReportTarget(viewedUserId)}><Flag size={13} /> 通報する</Button>
                )
              )}
            </div>
          </div>

          {viewedBlocked ? (
            <EmptyState title="ブロック中のユーザーです" body="このユーザーの投稿は表示されません。上のボタンからブロックを解除できます。" />
          ) : viewedUser.frozen ? (
            <EmptyState
              title="このアカウントは凍結されています"
              body="通報が一定数に達したため、投稿は表示できません。"
            />
          ) : (
            <>
              {reportScore(viewedUser) > 0 && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10, background: 'var(--wine-soft)', color: 'var(--wine)',
                  borderRadius: 10, padding: '10px 14px', marginBottom: 16, fontSize: 12.5,
                }}>
                  <Flag size={14} style={{ flexShrink: 0 }} />
                  <span style={{ flex: 1 }}>このユーザーは通報を受けています。問題がないと思ったら擁護できます。</span>
                  {iAlreadyVouched ? (
                    <Button variant="default" disabled><ShieldCheck size={13} /> 擁護済み</Button>
                  ) : (
                    <Button variant="default" onClick={() => vouchUser(viewedUserId)}><ShieldCheck size={13} /> 擁護する</Button>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <SectionLabel>登録曲 ({viewedSongsRaw.length})</SectionLabel>
              </div>
              {viewedSongsRaw.length > 0 && (
                <SongFilterBar filters={viewFilters} setFilters={setViewFilters} sort={viewSort} setSort={setViewSort} songs={viewedSongsRaw} />
              )}
              {viewedSongsRaw.length === 0 ? (
                <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>このユーザーはまだ曲を登録していません。</p>
              ) : viewedSongs.length === 0 ? (
                <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>条件に一致する曲が見つかりません。</p>
              ) : (
                viewedSongs.map((s) => (
                  <SongCard
                    key={s.id} song={s} ownerName={viewedUser.displayName}
                    onOpen={() => setSongDetail(s)}
                    alreadyCopied={mySourceIds.has(s.sourceSongId || s.id)}
                    onCopy={() => copySong(s)}
                  />
                ))
              )}
            </>
          )}
        </div>
      )}

      {/* ---- モーダル各種 ---- */}
      {showProfileForm && (
        <ModalShell onClose={() => setShowProfileForm(false)}>
          <ProfileForm
            isNew={profileFormMode === 'new'}
            initial={profileFormMode === 'edit' ? me : null}
            existingIds={allUserIds}
            onSave={profileFormMode === 'new' ? createProfile : updateProfile}
            onCancel={() => setShowProfileForm(false)}
          />
        </ModalShell>
      )}

      {songModal && (
        <ModalShell
          onClose={() => setSongModal(null)}
          width={560}
          background={songModal.id ? 'var(--gold-soft)' : 'var(--wine-soft)'}
        >
          <SongForm
            key={songFormKey}
            initial={Object.keys(songModal).length > 0 ? songModal : null}
            onSave={saveSong}
            onCancel={() => setSongModal(null)}
            onDuplicate={(draft) => {
              openSongForm(draft);
              showToast('複製しました。内容を確認して保存してください');
            }}
            allSongs={Object.values(data.songs)}
          />
        </ModalShell>
      )}

      {showCsvImport && (
        <CSVImportModal onClose={() => setShowCsvImport(false)} onImport={bulkImportSongs} mySongs={mySongsRaw} />
      )}

      {openingStarterPack && (
        <StarterPackGachaModal
          pack={openingStarterPack}
          mySongs={mySongsRaw}
          onClose={() => setOpeningStarterPack(null)}
          onImport={bulkImportSongs}
        />
      )}

      {showWhatsNew && (
        <WhatsNewModal
          sinceVersion={loadLastSeenChangelogVersion()}
          onClose={() => {
            saveLastSeenChangelogVersion(getLatestChangelogVersion());
            setShowWhatsNew(false);
          }}
        />
      )}

      {showWhatsNewHistory && (
        <WhatsNewModal onClose={() => setShowWhatsNewHistory(false)} />
      )}

      {showShareList && (
        <ShareListModal
          mySongs={mySongsRaw.filter((s) => !s.isPrivate)}
          myName={me.displayName}
          onClose={() => setShowShareList(false)}
          onToast={showToast}
          googleSignedIn={googleSignedIn}
          driveShareConfigured={driveShareConfigured}
          onShareViaDrive={shareSongsViaDrive}
          initialSelectedIds={selectedIds.size > 0 ? selectedIds : null}
        />
      )}

      {showImportList && (
        <ImportListModal
          initialCode={importListInitialCode}
          onClose={() => { setShowImportList(false); setImportListInitialCode(''); }}
          onImportSongs={importSharedSongs}
          onJoinEvent={joinEvent}
          onSaveProfile={saveScannedProfile}
          myUserId={meId}
          mySongs={mySongsRaw}
        />
      )}

      {view === 'mydb' && showScrollTop && (
        <button
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          aria-label="トップへ戻る"
          style={{
            position: 'fixed', bottom: 20, right: 20, width: 44, height: 44, borderRadius: '50%',
            background: 'var(--wine)', color: '#fff', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 4px 14px rgba(0,0,0,.25)', zIndex: 60,
          }}
        >
          <ChevronUp size={20} />
        </button>
      )}

      {showPlaylist && (
        <PlaylistPlayer
          songs={mySongsAll.filter((s) => s.videoUrl)}
          onClose={() => setShowPlaylist(false)}
        />
      )}

      {adGate && (
        <AdGateModal seconds={adGate.seconds} label={adGate.label} onComplete={adGate.onDone} onCancel={adGate.onCancel} />
      )}

      {sharedIncoming && (
        <SharedLinkImportModal
          url={sharedIncoming.url}
          initialField={sharedIncoming.field}
          mySongs={mySongsRaw}
          onClose={() => setSharedIncoming(null)}
          onOverwrite={applySharedLinkToSong}
          onRegisterNew={(field, url) => {
            setSharedIncoming(null);
            openSongForm({ [field]: url });
          }}
        />
      )}

      {showEventCreate && (
        <EventShareModal onClose={() => setShowEventCreate(false)} hostName={me.displayName} onToast={showToast} />
      )}

      {showProfileShare && (
        <ProfileShareModal me={me} onClose={() => setShowProfileShare(false)} onToast={showToast} />
      )}

      {showIosInstallHint && (
        <ModalShell onClose={() => setShowIosInstallHint(false)} width={380}>
          <h3 style={{ fontFamily: 'var(--font-display)', margin: '0 0 8px' }}>ホーム画面に追加する方法</h3>
          <p style={{ fontSize: 13, color: 'var(--ink-soft)', lineHeight: 1.8, margin: '0 0 8px' }}>
            お使いのブラウザのメニュー(共有アイコン <Share2 size={12} style={{ verticalAlign: -1 }} /> や「⋮」など)を開き、
            「ホーム画面に追加」または「アプリをインストール」を選んでください。
          </p>
          <p style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>
            ※表示やメニューの場所は、お使いの機種・ブラウザ・バージョンによって異なります。
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="quiet" onClick={() => setShowIosInstallHint(false)}>閉じる</Button>
          </div>
        </ModalShell>
      )}

      {showDriveDeleteConfirm && (
        <ModalShell onClose={() => setShowDriveDeleteConfirm(false)} width={380}>
          <h3 style={{ fontFamily: 'var(--font-display)', margin: '0 0 8px' }}>ドライブのバックアップを削除しますか?</h3>
          <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '0 0 18px' }}>
            Googleドライブの非公開領域に保存されているバックアップデータを削除します。
            この端末のデータはそのまま残りますが、次回ログイン同期時に改めてアップロードされます。
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="quiet" onClick={() => setShowDriveDeleteConfirm(false)}>キャンセル</Button>
            <Button variant="danger" onClick={() => { setShowDriveDeleteConfirm(false); deleteDriveBackup(); }}>
              <Trash2 size={14} /> 削除する
            </Button>
          </div>
        </ModalShell>
      )}

      {showDeleteAccountConfirm && (
        <DeleteAccountConfirmModal
          onClose={() => setShowDeleteAccountConfirm(false)}
          onConfirm={deleteAccount}
          deleting={deletingAccount}
          googleSignedIn={googleSignedIn}
        />
      )}

      {deleteConfirm && (
        <ModalShell onClose={() => setDeleteConfirm(null)} width={380}>
          <h3 style={{ fontFamily: 'var(--font-display)', margin: '0 0 8px' }}>
            {deleteConfirm.bulk ? `${deleteConfirm.ids.length}曲を削除しますか?` : 'この曲を削除しますか?'}
          </h3>
          <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '0 0 18px' }}>
            {deleteConfirm.bulk ? `選択した${deleteConfirm.ids.length}曲を削除します。` : `「${deleteConfirm.title}」を削除します。`}
            この操作は取り消せません。
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="quiet" onClick={() => setDeleteConfirm(null)}>キャンセル</Button>
            <Button
              variant="danger"
              onClick={() => (deleteConfirm.bulk ? bulkDeleteSongs(deleteConfirm.ids) : deleteSong(deleteConfirm.id))}
            >
              <Trash2 size={14} /> 削除する
            </Button>
          </div>
        </ModalShell>
      )}

      {songDetail && (
        <ModalShell onClose={() => setSongDetail(null)} width={520}>
          <SectionLabel>曲の詳細</SectionLabel>
          <SongCard
            song={songDetail}
            isMine={songDetail.ownerId === meId}
            ownerName={data.users[songDetail.ownerId]?.displayName}
            alreadyCopied={mySourceIds.has(songDetail.sourceSongId || songDetail.id)}
            onEdit={() => { openSongForm(songDetail); setSongDetail(null); }}
            onDelete={() => { setDeleteConfirm(songDetail); setSongDetail(null); }}
            onShare={() => { setSelectedIds(new Set([songDetail.id])); setShowShareList(true); setSongDetail(null); }}
            onCopy={() => { copySong(songDetail); setSongDetail(null); }}
          />
        </ModalShell>
      )}

      {followListMode && (
        <ModalShell onClose={() => setFollowListMode(null)} width={420}>
          <SectionLabel>{followListMode === 'following' ? 'フォロー中' : 'フォロワー'}</SectionLabel>
          {(followListMode === 'following' ? followingIds : followerIds).length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
              {followListMode === 'following' ? 'まだ誰もフォローしていません。' : 'まだフォロワーはいません。'}
            </p>
          ) : (
            (followListMode === 'following' ? followingIds : followerIds).map((uid) => (
              <UserRow
                key={uid} user={data.users[uid]}
                following={(me.followees || []).includes(uid)}
                onFollow={() => requestFollowToggle(uid)}
                onOpen={() => { setFollowListMode(null); setViewedUserId(uid); setView('discover'); }}
              />
            ))
          )}
        </ModalShell>
      )}

      {unfollowConfirm && (
        <ModalShell onClose={() => setUnfollowConfirm(null)} width={360}>
          <h3 style={{ fontFamily: 'var(--font-display)', margin: '0 0 8px' }}>フォローを外しますね?</h3>
          <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '0 0 18px' }}>
            {data.users[unfollowConfirm]?.displayName} さんのフォローを解除します。
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="quiet" onClick={() => setUnfollowConfirm(null)}>キャンセル</Button>
            <Button variant="danger" onClick={confirmUnfollow}><UserMinus size={14} /> フォローを外す</Button>
          </div>
        </ModalShell>
      )}

      {restorePending && (
        <ModalShell onClose={() => setRestorePending(null)} width={380}>
          <h3 style={{ fontFamily: 'var(--font-display)', margin: '0 0 8px' }}>バックアップから復元しますか?</h3>
          <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '0 0 18px', lineHeight: 1.7 }}>
            この端末に現在保存されているデータ(プロフィール{Object.keys(data.users).length}件・曲{Object.keys(data.songs).length}件)は、
            バックアップファイルの内容(プロフィール{Object.keys(restorePending.users || {}).length}件・曲{Object.keys(restorePending.songs || {}).length}件)で
            上書きされます。この操作は取り消せません。
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="quiet" onClick={() => setRestorePending(null)}>キャンセル</Button>
            <Button variant="danger" onClick={confirmRestore}><Check size={14} /> 復元する</Button>
          </div>
        </ModalShell>
      )}

      {reportTarget && data.users[reportTarget] && (
        <ReportModal
          userName={data.users[reportTarget].displayName}
          onClose={() => setReportTarget(null)}
          onSubmit={(reason) => reportUser(reportTarget, reason)}
        />
      )}

      {encounterUser && data.users[encounterUser] && (
        <div style={{
          position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 180,
          background: 'var(--surface, #fff)', border: '1px solid var(--line)', borderRadius: 12,
          boxShadow: '0 10px 30px rgba(0,0,0,.18)', padding: '12px 14px', display: 'flex',
          alignItems: 'center', gap: 10, maxWidth: 360, width: 'calc(100% - 32px)',
        }}>
          <div style={{
            width: 36, height: 36, borderRadius: '50%', background: 'var(--wine-soft)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--wine)', flexShrink: 0,
          }}>
            <Radar size={18} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700 }}>近くに利用者がいます!</div>
            <div style={{ fontSize: 12, color: 'var(--ink-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {data.users[encounterUser].displayName} さん
              {(me.followees || []).includes(encounterUser) && '(フォロー中)'}
            </div>
          </div>
          <Button onClick={() => { setViewedUserId(encounterUser); setView('discover'); setEncounterUser(null); }}>見る</Button>
          <IconBtn title="閉じる" onClick={() => setEncounterUser(null)}><X size={15} /></IconBtn>
        </div>
      )}

      <Toast text={toast} />
    </Wrap>
  );
}

/* ------------------------------------------------------------------ */
/*  補助コンポーネント                                                  */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  別ウィンドウ用: 曲登録フォームだけの軽量ルート                          */
/*  (PCブラウザで「曲を登録」を押すとこのモードのウィンドウが開く。          */
/*   PWAとしてインストール済みの場合は使われず、通常通り同一画面内で開く)     */
/* ------------------------------------------------------------------ */
export function SongFormPopup() {
  const params = new URLSearchParams(window.location.search);
  const songId = params.get('id') || null;
  const prefillVideoUrl = params.get('prefillVideoUrl') || '';
  const prefillScoreSource = params.get('prefillScoreSource') || '';
  const [ready, setReady] = useState(false);
  const [theme, setTheme] = useState(getTheme(THEMES[0].id));
  const [meId, setMeId] = useState(null);
  const [dataAll, setDataAll] = useState(null);
  const [initial, setInitial] = useState(null);
  const [formKey, setFormKey] = useState(0);

  useEffect(() => {
    (async () => {
      const [d, s, t] = await Promise.all([loadData(), loadSession(), loadThemeId()]);
      setDataAll(d);
      setMeId(s?.currentUserId || null);
      setTheme(getTheme(t));
      if (songId && d.songs[songId]) {
        setInitial(d.songs[songId]);
      } else if (prefillVideoUrl || prefillScoreSource) {
        setInitial({ ...(prefillVideoUrl ? { videoUrl: prefillVideoUrl } : {}), ...(prefillScoreSource ? { scoreSource: prefillScoreSource } : {}) });
      } else {
        setInitial(null);
      }
      setReady(true);
    })();
  }, [songId, prefillVideoUrl, prefillScoreSource]);

  const closeWindow = () => {
    try { window.close(); } catch (e) { /* noop */ }
  };

  const handleSave = async (draft) => {
    const latest = await loadData();
    const songs = { ...latest.songs };
    if (draft.id) {
      songs[draft.id] = { ...songs[draft.id], ...draft, updatedAt: Date.now() };
    } else {
      const id = genId('song');
      songs[id] = { ...draft, id, ownerId: meId, createdAt: Date.now(), updatedAt: Date.now() };
    }
    await saveData({ ...latest, songs });
    try {
      if (window.opener) window.opener.postMessage({ type: 'chorusdb:song-saved' }, window.location.origin);
    } catch (e) { /* noop */ }
    closeWindow();
  };

  if (!ready) {
    return (
      <Wrap theme={theme}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '60px 0', color: 'var(--ink-soft)' }}>
          <Loader2 size={18} className="spin" /> 読み込み中...
        </div>
      </Wrap>
    );
  }

  if (!meId) {
    return (
      <Wrap theme={theme}>
        <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--ink-soft)', fontSize: 13, lineHeight: 1.8 }}>
          プロフィールが見つかりませんでした。<br />
          元のタブでプロフィールを作成してから、もう一度お試しください。
        </div>
      </Wrap>
    );
  }

  return (
    <Wrap theme={theme}>
      <div style={{ maxWidth: 560, margin: '0 auto' }}>
        <SongForm
          key={formKey}
          initial={initial}
          onSave={handleSave}
          onCancel={closeWindow}
          onDuplicate={(draft) => { setInitial({ ...draft }); setFormKey((k) => k + 1); }}
          allSongs={Object.values(dataAll?.songs || {})}
        />
      </div>
    </Wrap>
  );
}

function Wrap({ children, theme }) {
  const themeVars = theme ? {
    '--paper': theme.paper, '--ink': theme.ink, '--ink-soft': theme.inkSoft,
    '--wine': theme.wine, '--wine-soft': theme.wineSoft,
    '--gold': theme.gold, '--gold-soft': theme.goldSoft,
    '--sage': theme.sage, '--sage-soft': theme.sageSoft,
    '--line': theme.line,
    // 以下はキーを持つテーマ(現状はApple風のみ)だけが上書きする追加トークン。
    // 未指定の場合はCSS側のvar(...,フォールバック値)がそのまま使われるので、他の49テーマは無影響。
    ...(theme.fontDisplay ? { '--font-display': theme.fontDisplay } : {}),
    ...(theme.fontBody ? { '--font-body': theme.fontBody } : {}),
    ...(theme.radiusControl != null ? { '--radius-control': `${theme.radiusControl}px` } : {}),
    ...(theme.radiusCard != null ? { '--radius-card': `${theme.radiusCard}px` } : {}),
    ...(theme.radiusPill != null ? { '--radius-pill': `${theme.radiusPill}px` } : {}),
    ...(theme.shadowCard ? { '--shadow-card': theme.shadowCard } : {}),
    ...(theme.shadowModal ? { '--shadow-modal': theme.shadowModal } : {}),
    ...(theme.surface ? { '--surface': theme.surface } : {}),
    ...(theme.danger ? { '--danger': theme.danger } : {}),
    ...(theme.goldText ? { '--gold-text': theme.goldText } : {}),
  } : {};
  return (
    <div className="app-wrap" style={{
      background: 'var(--paper)', minHeight: 480, borderRadius: 'var(--radius-card, 14px)', padding: '32px 26px 60px',
      fontFamily: 'var(--font-body)', color: 'var(--ink)', position: 'relative',
      maxWidth: 720, margin: '0 auto', boxSizing: 'border-box', transition: 'background .2s ease',
      overflow: 'hidden',
      ...themeVars,
    }}>
      {!theme?.flatBar && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 8,
          background: 'linear-gradient(90deg, var(--wine), var(--gold), var(--sage))',
          transition: 'background .2s ease',
        }} />
      )}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@500;700&family=Zen+Kaku+Gothic+New:wght@400;500;700&family=JetBrains+Mono:wght@500&display=swap');
        :root {
          --paper: #F3EEE1; --ink: #241F1B; --ink-soft: #6B6154;
          --wine: #7A2E2E; --wine-soft: #F1E1DD;
          --gold: #B08D57; --gold-soft: #F1E8D6;
          --sage: #5F6F4E; --sage-soft: #E7ECDD;
          --line: #DED5C0;
          --font-display: 'Shippori Mincho', serif;
          --font-body: 'Zen Kaku Gothic New', sans-serif;
          --font-mono: 'JetBrains Mono', monospace;
        }
        select { cursor: pointer; color: inherit; }
        /* buttonはブラウザ既定で文字色が黒固定になりがちなので、テーマの文字色を継承させる。
           色を個別指定しているボタン(Buttonコンポーネント等)はそちらが優先されるので影響ない。 */
        .app-wrap button { color: inherit; font-family: inherit; }
        .app-wrap input::placeholder, .app-wrap textarea::placeholder { color: var(--ink-soft); opacity: 0.8; }
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }

        @media (max-width: 639px) {
          .app-wrap { padding: 16px 14px 60px !important; border-radius: 0 !important; }
        }
      `}</style>
      {children}
    </div>
  );
}

function NavTab({ active, onClick, icon, label, badge, color = 'var(--wine)' }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 6, padding: '10px 20px 9px',
      background: active ? color : '#fff',
      border: `1px solid ${active ? color : 'var(--line)'}`,
      borderBottom: active ? `1px solid ${color}` : '1px solid var(--line)',
      borderRadius: '10px 10px 0 0',
      color: active ? '#fff' : 'var(--ink-soft)', fontWeight: active ? 700 : 600,
      fontSize: 13.5, cursor: 'pointer', fontFamily: 'var(--font-body)',
      marginBottom: -1, marginRight: 4, position: 'relative', top: active ? 0 : 4,
      boxShadow: active ? '0 -3px 8px rgba(0,0,0,.10)' : 'none',
      transition: 'top .15s ease',
    }}>
      {icon} {label}
      {badge > 0 && (
        <span style={{
          fontSize: 10.5, background: active ? 'rgba(255,255,255,.3)' : 'var(--line)',
          color: active ? '#fff' : 'var(--ink-soft)', borderRadius: 10, padding: '1px 6px',
        }}>{badge}</span>
      )}
    </button>
  );
}

function Stat({ label, value, onClick }) {
  return (
    <div onClick={onClick} style={{ cursor: onClick ? 'pointer' : 'default' }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>{label}</div>
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700,
      color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 12,
    }}>
      {children}
    </div>
  );
}

function EmptyState({ title, body, actionLabel, onAction }) {
  return (
    <div style={{
      textAlign: 'center', padding: '48px 20px', background: 'var(--surface, #fff)', border: '1px dashed var(--line)',
      borderRadius: 12,
    }}>
      <Music2 size={26} color="var(--ink-soft)" style={{ marginBottom: 10 }} />
      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, marginBottom: 6 }}>{title}</div>
      <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '0 0 16px' }}>{body}</p>
      {actionLabel && <Button variant="primary" onClick={onAction} style={{ margin: '0 auto' }}><Plus size={14} /> {actionLabel}</Button>}
    </div>
  );
}

function UserRow({ user, following, onFollow, onOpen }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, background: 'var(--surface, #fff)', border: '1px solid var(--line)',
      borderRadius: 10, padding: '10px 14px', marginBottom: 10,
    }}>
      <Avatar name={user.displayName} size={38} src={user.avatarDataUrl} />
      <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={onOpen}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{user.displayName}</div>
        <div style={{ fontSize: 11.5, color: 'var(--ink-soft)', fontFamily: 'var(--font-mono)' }}>@{user.userId}</div>
      </div>
      <Button variant="quiet" onClick={onOpen}>詳細</Button>
      <Button variant={following ? 'default' : 'primary'} onClick={onFollow}>
        {following ? <UserMinus size={13} /> : <UserPlus size={13} />}
      </Button>
    </div>
  );
}

function QrCanvas({ data, size = 240 }) {
  const canvasRef = useRef(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!data || !canvasRef.current) return;
    try {
      // データ量に応じて誤り訂正レベルを調整(小さいほど容量に余裕があるので堅牢なMを優先)
      const bytes = utf8Bytes(data);
      const ecLevel = bytes.length > 800 ? 'L' : 'M';
      const { modules, size: moduleCount } = encodeQR(data, ecLevel);
      setError('');

      const border = 4;
      const total = moduleCount + border * 2;
      const scale = Math.max(1, Math.floor(size / total));
      const pixelSize = total * scale;

      const canvas = canvasRef.current;
      canvas.width = pixelSize;
      canvas.height = pixelSize;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, pixelSize, pixelSize);
      ctx.fillStyle = '#241F1B';
      for (let r = 0; r < moduleCount; r++) {
        for (let c = 0; c < moduleCount; c++) {
          if (modules[r][c]) {
            ctx.fillRect((c + border) * scale, (r + border) * scale, scale, scale);
          }
        }
      }
    } catch (e) {
      setError('QRコードを生成できませんでした(データが多すぎる可能性があります)。リンクをコピーしてお使いください。');
    }
  }, [data, size]);

  if (error) {
    return <p style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{error}</p>;
  }
  return (
    <canvas
      ref={canvasRef}
      style={{
        width: size, height: size, maxWidth: 'none', maxHeight: 'none',
        border: '1px solid var(--line)', borderRadius: 8, background: 'var(--surface, #fff)',
      }}
    />
  );
}

function QrBlock({ shareUrl, oversizedNote }) {
  const [showQr, setShowQr] = useState(false);

  return (
    <>
      {oversizedNote}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <Button variant="primary" onClick={() => setShowQr(true)}>
          <QrCode size={13} /> QRコードを表示
        </Button>
      </div>
      {showQr && (
        <div style={{ textAlign: 'center', marginBottom: 14 }}>
          <QrCanvas data={shareUrl} size={220} />
        </div>
      )}
    </>
  );
}

function EventShareModal({ onClose, hostName, onToast }) {
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [copied, setCopied] = useState(false);
  const [shareUrl, setShareUrl] = useState('');

  useEffect(() => {
    let cancelled = false;
    if (!name.trim()) { setShareUrl(''); return undefined; }
    encodeEventPayload(name.trim(), date, hostName).then((encoded) => {
      if (!cancelled) setShareUrl(buildShareUrl(encoded));
    });
    return () => { cancelled = true; };
  }, [name, date, hostName]);

  const copyLink = async () => {
    const ok = await copyToClipboard(shareUrl);
    if (ok) { setCopied(true); onToast('リンクをコピーしました'); setTimeout(() => setCopied(false), 1500); }
    else onToast('コピーできませんでした。リンクを選択して手動でコピーしてください');
  };

  return (
    <ModalShell onClose={onClose} width={440}>
      <h2 style={{ fontFamily: 'var(--font-display)', margin: '0 0 4px' }}>イベントQRを作る</h2>
      <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '0 0 16px', lineHeight: 1.7 }}>
        演奏会や練習会などの名前を入れると、参加者が読み取って「参加記録」を残せるQRコードを作れます。
        サーバーには何も保存されません。
      </p>
      <Field label="イベント名" required>
        <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="例: 第10回 定期演奏会" />
      </Field>
      <Field label="日付(任意)">
        <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ maxWidth: 200 }} />
      </Field>

      {name.trim() && (
        <>
          <QrBlock shareUrl={shareUrl} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface, #fff)', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', marginBottom: 14 }}>
            <input readOnly value={shareUrl} onFocus={(e) => e.target.select()} style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, flex: 1, border: 'none', outline: 'none', background: 'transparent', color: 'var(--ink)', minWidth: 0 }} />
            <Button onClick={copyLink}>{copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'コピー済み' : 'コピー'}</Button>
          </div>
        </>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="quiet" onClick={onClose}>閉じる</Button>
      </div>
    </ModalShell>
  );
}

function ProfileShareModal({ me, onClose, onToast }) {
  const [copied, setCopied] = useState(false);
  const [shareUrl, setShareUrl] = useState('');

  useEffect(() => {
    let cancelled = false;
    encodeProfilePayload(me).then((encoded) => {
      if (!cancelled) setShareUrl(buildShareUrl(encoded));
    });
    return () => { cancelled = true; };
  }, [me]);

  const copyLink = async () => {
    const ok = await copyToClipboard(shareUrl);
    if (ok) { setCopied(true); onToast('リンクをコピーしました'); setTimeout(() => setCopied(false), 1500); }
    else onToast('コピーできませんでした。リンクを選択して手動でコピーしてください');
  };

  return (
    <ModalShell onClose={onClose} width={420}>
      <h2 style={{ fontFamily: 'var(--font-display)', margin: '0 0 4px' }}>プロフィールを共有</h2>
      <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '0 0 16px', lineHeight: 1.7 }}>
        表示名・自己紹介・年齢(表示設定に従います)だけを共有します。曲リストは含まれません。
        会場などでその場にいる人に見せて、読み取ってもらってください。
      </p>
      <QrBlock shareUrl={shareUrl} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface, #fff)', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', marginBottom: 16 }}>
        <input readOnly value={shareUrl} onFocus={(e) => e.target.select()} style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, flex: 1, border: 'none', outline: 'none', background: 'transparent', color: 'var(--ink)', minWidth: 0 }} />
        <Button onClick={copyLink}>{copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'コピー済み' : 'コピー'}</Button>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="quiet" onClick={onClose}>閉じる</Button>
      </div>
    </ModalShell>
  );
}

function SharedLinkImportModal({ url, initialField, mySongs, onClose, onOverwrite, onRegisterNew }) {
  const [field, setField] = useState(initialField);
  const [query, setQuery] = useState('');

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? mySongs.filter((s) => [s.title, s.composer, s.lyricist].filter(Boolean).some((v) => v.toLowerCase().includes(q)))
      : mySongs;
    return list.slice(0, 30);
  }, [mySongs, query]);

  const fieldLabel = field === 'videoUrl' ? '動画URL' : '楽譜入手先';

  return (
    <ModalShell onClose={onClose} width={480}>
      <h2 style={{ fontFamily: 'var(--font-display)', margin: '0 0 4px' }}>共有されたリンクを登録</h2>
      <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '0 0 12px', lineHeight: 1.7 }}>
        他のアプリの「共有」から届いたリンクです。既存の曲に登録するか、このリンクを元に新しい曲を登録できます。
      </p>
      <div style={{
        fontSize: 11.5, wordBreak: 'break-all', background: 'var(--paper)', border: '1px solid var(--line)',
        borderRadius: 8, padding: '8px 10px', marginBottom: 12, fontFamily: 'var(--font-mono)',
      }}>
        {url}
      </div>

      <div style={{ marginBottom: 14 }}>
        <label style={{ fontSize: 11.5, color: 'var(--ink-soft)', display: 'block', marginBottom: 4 }}>このリンクの種類</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <Button variant={field === 'videoUrl' ? 'default' : 'quiet'} onClick={() => setField('videoUrl')}>
            <Film size={13} /> 動画URL
          </Button>
          <Button variant={field === 'scoreSource' ? 'default' : 'quiet'} onClick={() => setField('scoreSource')}>
            <FileText size={13} /> 楽譜入手先
          </Button>
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <Button variant="primary" onClick={() => onRegisterNew(field, url)}>
          <Plus size={13} /> このリンクで新規に曲を登録
        </Button>
      </div>

      <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
        <label style={{ fontSize: 11.5, color: 'var(--ink-soft)', display: 'block', marginBottom: 6 }}>
          または、登録済みの曲を選んで{fieldLabel}を上書き
        </label>
        <TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="曲名・作曲者で検索" style={{ marginBottom: 8 }} />
        {mySongs.length === 0 ? (
          <p style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>登録済みの曲がありません。</p>
        ) : (
          <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--surface, #fff)' }}>
            {results.length === 0 ? (
              <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', padding: '10px 12px' }}>一致する曲が見つかりません。</p>
            ) : results.map((s) => (
              <div key={s.id} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                padding: '8px 12px', borderBottom: '1px solid var(--line)', fontSize: 12.5,
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</div>
                  <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>{s.composer}</div>
                </div>
                <Button variant="quiet" onClick={() => onOverwrite(s.id, field, url)}>上書き</Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <Button variant="quiet" onClick={onClose}>閉じる</Button>
      </div>
    </ModalShell>
  );
}

function ShareListModal({ mySongs, myName, onClose, onToast, googleSignedIn, driveShareConfigured, onShareViaDrive, initialSelectedIds }) {
  const [selected, setSelected] = useState(() =>
    initialSelectedIds ? new Set(initialSelectedIds) : new Set(mySongs.map((s) => s.id))
  );
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState('embed'); // 'embed' | 'drive'
  const [driveEncoded, setDriveEncoded] = useState('');
  const [driveLoading, setDriveLoading] = useState(false);
  const [driveError, setDriveError] = useState('');
  const [encoded, setEncoded] = useState('');

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setDriveEncoded(''); // 選択が変わったら、作成済みの共有ファイルは無効になるのでリセット
  };

  const selectedSongs = mySongs.filter((s) => selected.has(s.id));

  useEffect(() => {
    let cancelled = false;
    encodeSharePayload(myName, selectedSongs).then((enc) => {
      if (!cancelled) setEncoded(enc);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myName, selectedSongs.map((s) => s.id).join(',')]);

  const embedShareUrl = encoded ? buildShareUrl(encoded) : '';
  const oversized = encoded.length > SHARE_QR_SAFE_LIMIT;
  const canUseDrive = googleSignedIn && driveShareConfigured;
  const driveShareUrl = driveEncoded ? buildShareUrl(driveEncoded) : '';
  const shareUrl = mode === 'drive' ? driveShareUrl : embedShareUrl;

  const createDriveShare = async () => {
    setDriveLoading(true);
    setDriveError('');
    try {
      const enc = await onShareViaDrive(selectedSongs, myName);
      setDriveEncoded(enc);
      setShowQr(true);
    } catch (e) {
      setDriveError(e.message || 'ドライブへの共有ファイル作成に失敗しました');
    } finally {
      setDriveLoading(false);
    }
  };

  const copyLink = async () => {
    const ok = await copyToClipboard(shareUrl);
    if (ok) {
      setCopied(true);
      onToast('リンクをコピーしました');
      setTimeout(() => setCopied(false), 1500);
    } else {
      onToast('コピーできませんでした。リンクを選択して手動でコピーしてください');
    }
  };

  return (
    <ModalShell onClose={onClose} width={480}>
      <h2 style={{ fontFamily: 'var(--font-display)', margin: '0 0 4px' }}>曲リストを共有</h2>
      <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '0 0 14px', lineHeight: 1.7 }}>
        {mode === 'drive'
          ? '選んだ曲のデータをGoogleドライブ上のファイルとして保存し、そのファイルへの短いリンクだけを共有します。曲数が多くてもQRコードで確実に共有できます。'
          : '選んだ曲のデータをURL(またはQRコード)自体に埋め込んで共有します。サーバーには保存されません。'}
        共有相手には、プロフィールの表示名(「{myName}」)が「◯◯さんの登録曲」として表示されます。
      </p>

      {canUseDrive && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
          <Button
            variant={mode === 'embed' ? 'default' : 'quiet'}
            onClick={() => setMode('embed')}
          >
            直接埋め込み(少数向け)
          </Button>
          <Button
            variant={mode === 'drive' ? 'default' : 'quiet'}
            onClick={() => setMode('drive')}
          >
            Googleドライブ経由(大量向け)
          </Button>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{selected.size} / {mySongs.length} 曲を選択中</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <Button variant="quiet" onClick={() => { setSelected(new Set(mySongs.map((s) => s.id))); setDriveEncoded(''); }}>全選択</Button>
          <Button variant="quiet" onClick={() => { setSelected(new Set()); setDriveEncoded(''); }}>全解除</Button>
        </div>
      </div>

      {mySongs.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>共有できる公開曲がありません。</p>
      ) : (
        <div style={{
          maxHeight: 200, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 8,
          marginBottom: 16, background: 'var(--surface, #fff)',
        }}>
          {mySongs.map((s) => (
            <label key={s.id} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', fontSize: 13,
              borderBottom: '1px solid var(--line)', cursor: 'pointer',
            }}>
              <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} style={{ width: 15, height: 15 }} />
              {s.title}
              <span style={{ color: 'var(--ink-soft)', fontSize: 11.5 }}>({s.composer})</span>
            </label>
          ))}
        </div>
      )}

      {mode === 'embed' && oversized && (
        <p style={{ fontSize: 12, color: 'var(--danger, #9C3B2E)', margin: '0 0 12px' }}>
          曲数が多いため、QRコードが読み取れない可能性があります。
          {canUseDrive ? '「Googleドライブ経由」への切り替えをおすすめします。' : '曲を減らすか、リンクを直接送ってください。'}
        </p>
      )}

      {mode === 'drive' && (
        <>
          {driveError && <p style={{ fontSize: 12, color: 'var(--danger, #9C3B2E)', margin: '0 0 12px' }}>{driveError}</p>}
          {!driveEncoded && (
            <div style={{ marginBottom: 14 }}>
              <Button variant="primary" onClick={createDriveShare} disabled={selected.size === 0 || driveLoading}>
                {driveLoading ? <Loader2 size={13} className="spin" /> : <Share2 size={13} />}
                {driveLoading ? '共有ファイルを作成しています...' : 'ドライブに共有ファイルを作成'}
              </Button>
            </div>
          )}
        </>
      )}

      {(mode === 'embed' || driveEncoded) && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
          <Button variant="primary" onClick={() => setShowQr(true)} disabled={selected.size === 0}>
            <QrCode size={13} /> QRコードを表示
          </Button>
          <Button onClick={copyLink} disabled={selected.size === 0}>
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'コピーしました' : 'リンクをコピー'}
          </Button>
        </div>
      )}

      {showQr && selected.size > 0 && (mode === 'embed' || driveEncoded) && (
        <div style={{ textAlign: 'center', marginBottom: 14 }}>
          <QrCanvas data={shareUrl} size={200} />
        </div>
      )}

      {(mode === 'embed' || driveEncoded) && (
        <input
          readOnly value={shareUrl}
          onFocus={(e) => e.target.select()}
          style={{ ...inputStyle, fontFamily: 'var(--font-mono)', fontSize: 11.5 }}
        />
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <Button variant="quiet" onClick={onClose}>閉じる</Button>
      </div>
    </ModalShell>
  );
}

function QrCameraScanner({ onDecode }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const [starting, setStarting] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    const tick = () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        try {
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
          if (code && code.data) {
            onDecode(code.data);
            return; // 呼び出し元がカメラを閉じるので、ここでフレーム取得を止める
          }
        } catch (err) { /* 1フレームの読み取り失敗は無視して次のフレームへ */ }
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStarting(false);
        setError('お使いのブラウザはカメラ読み取りに対応していません。下の欄にURL/コードを貼り付けてください。');
        return;
      }
      if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
        setStarting(false);
        setError('カメラの利用にはhttps接続が必要です。下の欄にURL/コードを貼り付けてください。');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setStarting(false);
        rafRef.current = requestAnimationFrame(tick);
      } catch (e) {
        console.warn('[QrCameraScanner] カメラの起動に失敗しました', e);
        setStarting(false);
        if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
          setError('カメラへのアクセスが許可されていません。ブラウザ・OSの設定でこのサイトのカメラ利用を許可してください。');
        } else if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
          setError('カメラが見つかりませんでした。');
        } else {
          setError('カメラを起動できませんでした。下の欄にURL/コードを貼り付けてください。');
        }
      }
    })();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{
      position: 'relative', width: '100%', paddingTop: '75%', borderRadius: 10, overflow: 'hidden',
      background: '#000', marginBottom: 12,
    }}>
      <video ref={videoRef} playsInline muted style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
      <canvas ref={canvasRef} style={{ display: 'none' }} />
      {!error && (
        <div style={{
          position: 'absolute', inset: '14%', border: '2px solid rgba(255,255,255,0.85)', borderRadius: 14, pointerEvents: 'none',
        }} />
      )}
      {starting && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          color: '#fff', fontSize: 12.5, background: 'rgba(0,0,0,0.45)',
        }}>
          <Loader2 size={16} className="spin" /> カメラを起動しています...
        </div>
      )}
      {error && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 16, textAlign: 'center', color: '#fff', fontSize: 12, lineHeight: 1.6, background: 'rgba(0,0,0,0.8)',
        }}>
          {error}
        </div>
      )}
    </div>
  );
}

function ImportListModal({ initialCode, onClose, onImportSongs, onJoinEvent, onSaveProfile, myUserId, mySongs = [] }) {
  const [input, setInput] = useState(initialCode || '');
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [loadingDrive, setLoadingDrive] = useState(false);
  const [dupActions, setDupActions] = useState({}); // { [songIndex]: 'new' | 'skip' | 'overwrite' | 'merge' }

  const duplicateMatches = useMemo(() => {
    if (!preview || preview.type !== 'songs') return [];
    return preview.songs.map((s) => findDuplicateSong(s, mySongs));
  }, [preview, mySongs]);

  const runParse = async (raw) => {
    setError('');
    try {
      const code = extractShareCodeFromInput(raw);
      if (!code) { setError('リンクまたはコードを入力してください。'); return; }
      const result = await decodeSharePayload(code);
      if (result.type === 'songs' && result.songs.length === 0) {
        setError('曲データが見つかりませんでした。');
        return;
      }
      if (result.type === 'songs-drive') {
        setLoadingDrive(true);
        driveFetchPublicJson(result.driveFileId)
          .then((json) => {
            const songs = Array.isArray(json.songs) ? json.songs.map(shareEntryToSong) : [];
            if (songs.length === 0) {
              setError('曲データが見つかりませんでした。');
              return;
            }
            setPreview({ type: 'songs', from: json.from || result.from, songs });
          })
          .catch(() => setError('共有データを取得できませんでした。共有した相手がドライブ上のファイルを削除した可能性があります。'))
          .finally(() => setLoadingDrive(false));
        return;
      }
      setPreview(result);
    } catch (e) {
      setError(e.message && e.message.includes('対応していません') ? e.message : '読み込めませんでした。リンクまたはコードが正しいかご確認ください。');
    }
  };

  const parse = () => runParse(input);

  const handleScanned = (text) => {
    setScanning(false);
    setInput(text);
    runParse(text);
  };

  useEffect(() => {
    if (initialCode) parse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirm = () => {
    if (!preview) return;
    if (preview.type === 'songs') {
      const items = preview.songs.map((s, i) => {
        const dup = duplicateMatches[i];
        const dupState = dupActions[i];
        const action = dup ? (dupState?.mode || 'skip') : 'new';
        const mergeFields = action === 'merge' && dupState?.mergeFields ? flattenMergeFieldKeys(dupState.mergeFields) : undefined;
        return { song: s, action, existingId: dup?.id, mergeFields };
      });
      onImportSongs(items, preview.from);
    }
    if (preview.type === 'event') onJoinEvent(preview);
    if (preview.type === 'profile') onSaveProfile(preview);
    setDone(true);
  };

  const isOwnProfile = preview?.type === 'profile' && preview.userId === myUserId;

  return (
    <ModalShell onClose={onClose} width={480}>
      <h2 style={{ fontFamily: 'var(--font-display)', margin: '0 0 4px' }}>QRコード/URLを読み込む</h2>
      <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '0 0 14px', lineHeight: 1.7 }}>
        カメラでQRコードを直接読み取るか、受け取ったURLを貼り付けてください。
      </p>

      {!preview && (
        <>
          {scanning ? (
            <>
              <QrCameraScanner onDecode={handleScanned} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
                <Button variant="quiet" onClick={() => setScanning(false)}>
                  <X size={13} /> カメラを閉じる
                </Button>
              </div>
            </>
          ) : (
            <div style={{ marginBottom: 12 }}>
              <Button onClick={() => setScanning(true)}>
                <Camera size={13} /> カメラでQRコードを読み取る
              </Button>
            </div>
          )}
          <TextArea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="https://utacolle.com/#..."
            style={{ minHeight: 80, marginBottom: 12 }}
          />
          {error && <p style={{ color: 'var(--danger, #9C3B2E)', fontSize: 12.5, margin: '0 0 12px' }}>{error}</p>}
          {loadingDrive && (
            <p style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--ink-soft)', fontSize: 12.5, margin: '0 0 12px' }}>
              <Loader2 size={14} className="spin" /> ドライブから共有データを取得しています...
            </p>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="quiet" onClick={onClose}>キャンセル</Button>
            <Button variant="primary" onClick={parse} disabled={loadingDrive}><Search size={13} /> 内容を確認</Button>
          </div>
        </>
      )}

      {preview && !done && preview.type === 'songs' && (
        <>
          <div style={{ fontSize: 13, marginBottom: 10 }}>
            {preview.from && <>{preview.from} さんから、</>}
            <strong style={{ color: 'var(--wine)' }}>{preview.songs.length}曲</strong> のデータが見つかりました。
          </div>
          <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 8, marginBottom: 16 }}>
            {preview.songs.map((s, i) => {
              const dup = duplicateMatches[i];
              if (!dup) {
                return (
                  <div key={i} style={{
                    fontSize: 12.5, padding: '8px 12px', borderBottom: i < preview.songs.length - 1 ? '1px solid var(--line)' : 'none',
                  }}>
                    {s.title}
                    <span style={{ color: 'var(--ink-soft)' }}> ({s.lyricist} / {s.composer})</span>
                  </div>
                );
              }
              return (
                <div key={i} style={{
                  padding: '10px 12px', borderBottom: i < preview.songs.length - 1 ? '1px solid var(--line)' : 'none',
                  background: 'var(--gold-soft)',
                }}>
                  <div style={{ fontSize: 12.5, marginBottom: 4 }}>
                    {s.title}
                    <span style={{ color: 'var(--ink-soft)' }}> ({s.lyricist} / {s.composer})</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--gold-text, #8a6a34)', marginBottom: 2 }}>
                    <Flag size={11} /> 登録済みの曲と一致する可能性があります
                  </div>
                  <SongCompareCard existing={dup} incoming={s} />
                  <DupActionPicker
                    name={`dup-${i}`}
                    existing={dup}
                    incoming={s}
                    value={dupActions[i]}
                    onChange={(next) => setDupActions((prev) => ({ ...prev, [i]: next }))}
                  />
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="quiet" onClick={() => { setPreview(null); setDupActions({}); }}>やり直す</Button>
            <Button variant="primary" onClick={confirm}>
              <Check size={14} /> 登録する
            </Button>
          </div>
        </>
      )}

      {preview && !done && preview.type === 'event' && (
        <>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, background: 'var(--gold-soft)', borderRadius: 10,
            padding: '14px 16px', marginBottom: 18,
          }}>
            <Ticket size={22} color="var(--gold-text, #8a6a34)" />
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{preview.name}</div>
              {preview.date && <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{preview.date}</div>}
              {preview.from && <div style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>主催: {preview.from}</div>}
            </div>
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '0 0 16px' }}>
            このイベントに参加した記録を、あなたのプロフィールに残します(自分にしか表示されません)。
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="quiet" onClick={() => setPreview(null)}>やり直す</Button>
            <Button variant="primary" onClick={confirm}><Check size={14} /> 参加する</Button>
          </div>
        </>
      )}

      {preview && !done && preview.type === 'profile' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <Avatar name={preview.displayName} size={50} />
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 16 }}>{preview.displayName}</div>
                {preview.ageLabel && (
                  <span style={{ fontSize: 11, color: 'var(--ink-soft)', border: '1px solid var(--line)', borderRadius: 'var(--radius-pill, 20px)', padding: '1px 8px' }}>
                    {preview.ageLabel}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: 'var(--ink-soft)', fontFamily: 'var(--font-mono)' }}>@{preview.userId}</div>
            </div>
          </div>
          {preview.bio && <p style={{ fontSize: 13, color: 'var(--ink)', margin: '0 0 16px', lineHeight: 1.7 }}>{preview.bio}</p>}
          {isOwnProfile ? (
            <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '0 0 16px' }}>これはあなた自身のプロフィールです。</p>
          ) : (
            <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '0 0 16px' }}>
              このプロフィールをこの端末に保存すると、「さがす」からいつでも見られるようになります。
            </p>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="quiet" onClick={() => setPreview(null)}>やり直す</Button>
            {!isOwnProfile && (
              <Button variant="primary" onClick={confirm}><Check size={14} /> この端末に保存する</Button>
            )}
          </div>
        </>
      )}

      {done && (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <Check size={28} color="var(--sage)" style={{ marginBottom: 10 }} />
          <p style={{ fontSize: 13.5, margin: '0 0 18px' }}>読み込みました。</p>
          <Button variant="primary" onClick={onClose}>閉じる</Button>
        </div>
      )}
    </ModalShell>
  );
}

/* ---- スターターパック: 開封(30秒広告→ガチャ演出→重複確認)のモーダル ---- */
function StarterPackGachaModal({ pack, mySongs = [], onClose, onImport }) {
  const [adDone, setAdDone] = useState(false);
  const [drawn, setDrawn] = useState(null);
  const [revealedCount, setRevealedCount] = useState(0);
  const [step, setStep] = useState('reveal'); // 'reveal' | 'preview'
  const [dupActions, setDupActions] = useState({});
  const revealTimer = useRef(null);

  // 広告視聴が終わった時点で、曲を確定させ「開封済み」として記録する(24時間クールダウンの起点)。
  // ここで記録することで、演出後に全曲スキップしても再抽選できてしまうのを防ぐ。
  const handleAdComplete = () => {
    const picked = drawStarterPackSongs(pack);
    setDrawn(picked);
    saveStarterPackOpenedAt(pack.id, Date.now());
    setAdDone(true);
  };

  useEffect(() => {
    if (!adDone || !drawn || step !== 'reveal') return undefined;
    if (revealedCount >= drawn.length) return undefined;
    revealTimer.current = setTimeout(() => setRevealedCount((c) => c + 1), 900);
    return () => clearTimeout(revealTimer.current);
  }, [adDone, drawn, step, revealedCount]);

  const skipReveal = () => {
    clearTimeout(revealTimer.current);
    setRevealedCount(drawn.length);
    setStep('preview');
  };

  useEffect(() => {
    if (drawn && revealedCount >= drawn.length && step === 'reveal') {
      const t = setTimeout(() => setStep('preview'), 600);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [drawn, revealedCount, step]);

  const duplicateMatches = useMemo(() => {
    if (!drawn) return [];
    return drawn.map((s) => findDuplicateSong(s, mySongs));
  }, [drawn, mySongs]);

  const confirmImport = () => {
    if (drawn?.length) {
      const items = drawn.map((s, i) => {
        const dup = duplicateMatches[i];
        const dupState = dupActions[i];
        const action = dup ? (dupState?.mode || 'skip') : 'new';
        const mergeFields = action === 'merge' && dupState?.mergeFields ? flattenMergeFieldKeys(dupState.mergeFields) : undefined;
        return { song: s, action, existingId: dup?.id, mergeFields };
      });
      onImport(items);
    }
    onClose();
  };

  if (!adDone) {
    return <AdGateModal seconds={30} label={`「${pack.name}」を開封する前に`} onComplete={handleAdComplete} onCancel={onClose} />;
  }

  if (step === 'reveal' && drawn) {
    return (
      <div style={{
        position: 'fixed', inset: 0, background: 'rgba(20,16,14,.94)', zIndex: 300,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}>
        <div style={{ fontSize: 13, color: '#F3EEE1', marginBottom: 14, fontFamily: 'var(--font-display)' }}>
          {pack.name} — {revealedCount} / {drawn.length}曲
        </div>
        <div style={{
          width: '100%', maxWidth: 380, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10,
          maxHeight: '55vh', overflowY: 'auto', marginBottom: 20,
        }}>
          {drawn.slice(0, revealedCount).map((s, i) => (
            <div key={i} style={{
              background: '#fff', borderRadius: 10, padding: '10px 12px',
              animation: 'starter-pop .35s ease-out',
            }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink)', marginBottom: 2 }}>{s.title}</div>
              <div style={{ fontSize: 10.5, color: 'var(--ink-soft)' }}>{[s.lyricist, s.composer].filter(Boolean).join(' / ')}</div>
            </div>
          ))}
          {revealedCount < drawn.length && (
            <div style={{
              background: 'rgba(255,255,255,.14)', borderRadius: 10, padding: '10px 12px',
              display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 50,
            }}>
              <Sparkles size={18} color="#F3EEE1" />
            </div>
          )}
        </div>
        {revealedCount < drawn.length && (
          <Button variant="quiet" onClick={skipReveal} style={{ color: '#F3EEE1', borderColor: 'rgba(255,255,255,.4)' }}>
            <X size={13} /> 演出をスキップ
          </Button>
        )}
        <style>{`@keyframes starter-pop { from { opacity: 0; transform: scale(.85); } to { opacity: 1; transform: scale(1); } }`}</style>
      </div>
    );
  }

  return (
    <ModalShell onClose={onClose} width={540}>
      <h2 style={{ fontFamily: 'var(--font-display)', margin: '0 0 4px' }}>{pack.name} の結果</h2>
      <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '0 0 14px', lineHeight: 1.7 }}>
        {drawn?.length}曲を引きました。登録済みの曲と一致する可能性があるものは、どうするか選んでください。
      </p>
      {drawn && (
        <div style={{ maxHeight: 360, overflowY: 'auto', marginBottom: 18, border: '1px solid var(--line)', borderRadius: 8 }}>
          {drawn.map((s, i) => {
            const dup = duplicateMatches[i];
            if (!dup) {
              return (
                <div key={i} style={{
                  fontSize: 12.5, padding: '8px 12px', borderBottom: i < drawn.length - 1 ? '1px solid var(--line)' : 'none',
                }}>
                  {s.title}
                  <span style={{ color: 'var(--ink-soft)' }}> ({s.lyricist} / {s.composer})</span>
                </div>
              );
            }
            return (
              <div key={i} style={{
                padding: '10px 12px', borderBottom: i < drawn.length - 1 ? '1px solid var(--line)' : 'none',
                background: 'var(--gold-soft)',
              }}>
                <div style={{ fontSize: 12.5, marginBottom: 4 }}>
                  {s.title}
                  <span style={{ color: 'var(--ink-soft)' }}> ({s.lyricist} / {s.composer})</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--gold-text, #8a6a34)', marginBottom: 2 }}>
                  <Flag size={11} /> 登録済みの曲と一致する可能性があります
                </div>
                <SongCompareCard existing={dup} incoming={s} />
                <DupActionPicker
                  name={`starter-dup-${i}`}
                  existing={dup}
                  incoming={s}
                  value={dupActions[i]}
                  onChange={(next) => setDupActions((prev) => ({ ...prev, [i]: next }))}
                />
              </div>
            );
          })}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button variant="primary" onClick={confirmImport}>
          <Check size={14} /> コレクションに追加する
        </Button>
      </div>
    </ModalShell>
  );
}

function CSVImportModal({ onClose, onImport, mySongs = [] }) {
  const [step, setStep] = useState('upload'); // 'upload' | 'preview'
  const [parseError, setParseError] = useState('');
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);
  const [dupActions, setDupActions] = useState({});
  const [adDone, setAdDone] = useState(false);

  const duplicateMatches = useMemo(() => {
    if (!result?.valid) return [];
    return result.valid.map((s) => findDuplicateSong(s, mySongs));
  }, [result, mySongs]);

  const templateCsv = useMemo(() => buildCsvTemplate(), []);
  const templateHref = csvDownloadHref(templateCsv);

  const copyTemplate = async () => {
    const ok = await copyToClipboard(templateCsv);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setParseError('');
    const text = await decodeCsvFile(file);
    Papa.parse(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.replace(/^\uFEFF/, '').trim(),
      complete: (res) => {
        if (!res.data || res.data.length === 0) {
          setParseError('データが読み取れませんでした。テンプレートを参考に作り直してください。');
          return;
        }
        setResult(parseCsvRows(res.data));
        setStep('preview');
      },
      error: () => setParseError('CSVの読み込みに失敗しました。形式をご確認ください。'),
    });
  };

  const confirmImport = () => {
    if (result?.valid?.length) {
      const items = result.valid.map((s, i) => {
        const dup = duplicateMatches[i];
        const dupState = dupActions[i];
        const action = dup ? (dupState?.mode || 'skip') : 'new';
        const mergeFields = action === 'merge' && dupState?.mergeFields ? flattenMergeFieldKeys(dupState.mergeFields) : undefined;
        return { song: s, action, existingId: dup?.id, mergeFields };
      });
      onImport(items);
    }
    onClose();
  };

  if (!adDone) {
    return <AdGateModal seconds={30} label="CSVアップロードを始める前に" onComplete={() => setAdDone(true)} onCancel={onClose} />;
  }

  return (
    <ModalShell onClose={onClose} width={540}>
      <h2 style={{ fontFamily: 'var(--font-display)', margin: '0 0 4px' }}>CSVから一括登録</h2>

      {step === 'upload' && (
        <>
          <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '0 0 14px', lineHeight: 1.7 }}>
            1行目に項目名、2行目以降に曲データを入力したCSVファイルを選んでください。
            「曲名」「作詩」「作曲」「編成」は必須です。編成・伴奏・言語はプルダウンの選択肢と一致しない場合、自動的に「その他」として登録されます。
            「タグ」は「、」区切りで複数指定でき、公開タグとして登録されます。
            文字コードはUTF-8・Shift-JIS(Excelで保存した場合の既定形式)のどちらでも読み込めます。
          </p>

          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <a
              href={templateHref}
              download="chorusdb_template.csv"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                fontSize: 13.5, fontFamily: 'var(--font-body)', fontWeight: 600, padding: '8px 14px',
                borderRadius: 6, background: 'var(--surface, #fff)', color: 'var(--ink)', border: '1px solid var(--line)',
                textDecoration: 'none',
              }}
            >
              <FileText size={13} /> テンプレートをダウンロード
            </a>
            <Button variant="quiet" onClick={copyTemplate}>
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'コピーしました' : 'テンプレートをコピー'}
            </Button>
          </div>
          <p style={{ fontSize: 11, color: 'var(--ink-soft)', margin: '0 0 18px' }}>
            ダウンロードがうまく開けない場合は「テンプレートをコピー」でテキストをコピーし、表計算アプリなどに貼り付けてCSVとして保存してください。
          </p>

          <div style={{ position: 'relative', display: 'inline-block' }}>
            <Button variant="primary" style={{ pointerEvents: 'none' }}>
              <Plus size={14} /> CSVファイルを選ぶ
            </Button>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={handleFile}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer' }}
            />
          </div>
          {parseError && <p style={{ color: 'var(--danger, #9C3B2E)', fontSize: 12.5, marginTop: 14 }}>{parseError}</p>}
        </>
      )}

      {step === 'preview' && result && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 14 }}>
            <div style={{ fontSize: 13.5 }}>
              <strong style={{ color: 'var(--wine)' }}>{result.valid.length}件</strong> 登録できます
            </div>
            {result.errors.length > 0 && (
              <div style={{ fontSize: 13.5, color: 'var(--danger, #9C3B2E)' }}>{result.errors.length}件はスキップされます</div>
            )}
          </div>

          {result.errors.length > 0 && (
            <div style={{
              maxHeight: 120, overflowY: 'auto', background: 'var(--paper)', border: '1px solid var(--line)',
              borderRadius: 8, padding: '8px 12px', marginBottom: 14,
            }}>
              {result.errors.map((e, i) => (
                <div key={i} style={{ fontSize: 12, color: 'var(--danger, #9C3B2E)' }}>{e.row}行目: {e.reason}</div>
              ))}
            </div>
          )}

          {result.valid.length > 0 && (
            <div style={{
              maxHeight: 320, overflowY: 'auto', marginBottom: 18, border: '1px solid var(--line)', borderRadius: 8,
            }}>
              {result.valid.map((s, i) => {
                const dup = duplicateMatches[i];
                if (!dup) {
                  return (
                    <div key={i} style={{
                      fontSize: 12.5, padding: '8px 12px', borderBottom: i < result.valid.length - 1 ? '1px solid var(--line)' : 'none',
                    }}>
                      {s.title}
                      <span style={{ color: 'var(--ink-soft)' }}> ({s.lyricist} / {s.composer})</span>
                    </div>
                  );
                }
                return (
                  <div key={i} style={{
                    padding: '10px 12px', borderBottom: i < result.valid.length - 1 ? '1px solid var(--line)' : 'none',
                    background: 'var(--gold-soft)',
                  }}>
                    <div style={{ fontSize: 12.5, marginBottom: 4 }}>
                      {s.title}
                      <span style={{ color: 'var(--ink-soft)' }}> ({s.lyricist} / {s.composer})</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--gold-text, #8a6a34)', marginBottom: 2 }}>
                      <Flag size={11} /> 登録済みの曲と一致する可能性があります
                    </div>
                    <SongCompareCard existing={dup} incoming={s} />
                    <DupActionPicker
                      name={`csv-dup-${i}`}
                      existing={dup}
                      incoming={s}
                      value={dupActions[i]}
                      onChange={(next) => setDupActions((prev) => ({ ...prev, [i]: next }))}
                    />
                  </div>
                );
              })}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="quiet" onClick={() => { setStep('upload'); setResult(null); setDupActions({}); }}>やり直す</Button>
            <Button variant="primary" onClick={confirmImport} disabled={result.valid.length === 0}>
              <Check size={14} /> {result.valid.length}件を登録する
            </Button>
          </div>
        </>
      )}
    </ModalShell>
  );
}

function ReportModal({ userName, onClose, onSubmit }) {
  const [reason, setReason] = useState(REPORT_REASONS[0]);
  return (
    <ModalShell onClose={onClose} width={400}>
      <h2 style={{ fontFamily: 'var(--font-display)', margin: '0 0 4px' }}>{userName} さんを通報</h2>
      <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '0 0 16px' }}>
        通報が10件たまるとアカウントが自動的に凍結されます。他の利用者が「問題ない」と判断した場合は擁護によって件数が減ります。
      </p>
      <Field label="理由">
        <select value={reason} onChange={(e) => setReason(e.target.value)} style={inputStyle}>
          {REPORT_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </Field>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
        <Button variant="quiet" onClick={onClose}>キャンセル</Button>
        <Button variant="danger" onClick={() => onSubmit(reason)}><Flag size={13} /> 通報する</Button>
      </div>
    </ModalShell>
  );
}

