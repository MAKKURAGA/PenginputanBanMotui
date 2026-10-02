// ══════════════════════════════════════════════════════════
// BAN MOTUI — SERVICE WORKER (Makkuraga Grup, Site Motui)
// Simpan di folder yang sama dengan index.html Motui dengan nama: sw.js
// Tugasnya:
//  1. Cache app shell (index.html, manifest, icon) supaya app bisa DIBUKA tanpa jaringan.
//  2. Kirim data Ban (Pasang/Lepas/Ganti) ke Google Sheets Motui lewat Background Sync,
//     bahkan saat app ditutup / HP di-lock, begitu dapat jaringan.
// ══════════════════════════════════════════════════════════

const SW_VERSION   = 'ban-motui-sw-v3';
const CACHE_PREFIX = 'ban-motui-shell-';       // awalan khusus Motui: activate HANYA membuang cache berawalan ini,
const CACHE_NAME   = CACHE_PREFIX + 'v3';      // jadi tidak menyentuh cache app lain (mis. Kolonodale) di domain yang sama.
                                               // NAIKKAN angka v3 tiap kali index.html di-update & redeploy.
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './favicon-32.png',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];
const DB_NAME  = 'BanDB_Motui';  // HARUS sama dgn indexedDB.open('BanDB_Motui', 1) di index.html Motui
const DB_VER   = 1;
const SYNC_TAG = 'ban-sync';     // HARUS sama dgn requestBackgroundSync() -> sync.register('ban-sync')

// URL ini HARUS sama persis dengan const GAS_URL di index.html Motui.
// Kalau ganti deployment GAS, update DI DUA TEMPAT lalu naikkan CACHE_NAME di atas.
const GAS_URL = 'https://script.google.com/macros/s/AKfycbxskcwG58L0CqwHCGBqmlQrR1J-i1A3KFWzl2BkjsPrOHp72yCpWPeMQUtX0GnKIP4/exec';

const RETRY_DELAYS_MS = [60000, 300000, 900000, 3600000]; // 1m,5m,15m,1jam — SAMA dgn index.html

// ── Install: precache app shell (per-file, supaya 1 file gagal tidak menggagalkan semua) ──
self.addEventListener('install', e => {
  console.log('[SW] Install:', SW_VERSION);
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(
        APP_SHELL.map(url =>
          cache.add(new Request(url, { cache: 'reload' })).catch(err => {
            console.warn('[SW] Gagal precache satu file (' + url + '):', err.message);
            return null;
          })
        )
      )
    )
  );
  self.skipWaiting();
});

// ── Activate: buang cache Motui versi lama (HANYA yang berawalan CACHE_PREFIX) ──
self.addEventListener('activate', e => {
  console.log('[SW] Activate:', SW_VERSION);
  e.waitUntil(
    Promise.all([
      caches.keys().then(keys => Promise.all(
        keys.filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map(k => caches.delete(k))
      )),
      self.clients.claim()
    ])
  );
});

// ── Fetch: stale-while-revalidate untuk app shell; GAS & domain lain lewat begitu saja ──
// Tampilkan cache dulu (cepat & jalan offline), sambil diam-diam mengambil versi terbaru dari jaringan
// untuk dipakai di pembukaan BERIKUTNYA. Jadi update index.html tidak lagi "nyangkut" di versi lama.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req, { cache: 'no-cache' })
        .then(res => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => null);
      if (cached) { e.waitUntil(network); return cached; }
      return network.then(res => {
        if (res) return res;
        if (req.mode === 'navigate') return caches.match('./index.html');
        return new Response('', { status: 504, statusText: 'Offline & tidak ada cache' });
      });
    })
  );
});

// ── Background Sync ──────────────────────────────────────
self.addEventListener('sync', e => {
  if (e.tag === SYNC_TAG) {
    console.log('[SW] Background sync dipanggil browser');
    e.waitUntil(doSync());
  }
});

// ── Fungsi Sync Utama ─────────────────────────────────────
// Kunci bersama (Web Locks) dengan halaman: kalau index.html sedang sync, SW tidak ikut mengirim
// record yang sama (sumber dobel). Nama kunci HARUS sama dgn di index.html.
const LOCK_NAME = 'ban-motui-sync';
async function doSync() {
  if (self.navigator && navigator.locks) {
    let ran = false;
    await navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async lock => {
      if (!lock) return;           // halaman sedang sync — biarkan dia yang menyelesaikan
      ran = true;
      await doSyncInner();
    });
    if (!ran) console.log('[SW] Halaman sedang sync, SW lewati');
    return;
  }
  return doSyncInner();
}

async function doSyncInner() {
  let db;
  try {
    db = await openDB();
  } catch (err) {
    console.error('[SW] Gagal buka IndexedDB:', err.message);
    return;
  }

  // Urutan kirim per unit HARUS sama dgn urutan input di HP (lepas dulu, baru pasang/geser):
  // server menolak geser ke posisi yang di server MASIH Aktif. Record yang baru diedit
  // dihitung dari updatedAt-nya (sama dgn syncAll() di index.html).
  const recTime = r => r.updatedAt || r.createdAt || '';
  const all = (await dbGetAll(db, 'records')).sort((a, b) => recTime(a) < recTime(b) ? -1 : 1);
  const isOpen = r => r.status === 'pending' || r.status === 'error';
  const inBase = new Set(all.filter(shouldRetryRecord).map(r => r.localId));
  const held = new Set(); // unit yang punya antrean lebih tua yang belum waktunya dicoba ulang
  const todo = [];
  all.forEach(r => {
    if (!isOpen(r)) return;
    if (inBase.has(r.localId)) { if (!held.has(r.unit)) todo.push(r); }
    else if (r.status === 'error' && (r.retryCount || 0) < RETRY_DELAYS_MS.length) held.add(r.unit);
  });

  if (!todo.length) {
    console.log('[SW] Tidak ada data pending, sync selesai');
    return;
  }
  console.log('[SW] Ada', todo.length, 'data yang perlu disync');

  let anySuccess = false;
  let connErr = null; // error koneksi pertama; dilempar ULANG setelah loop selesai
  const blockedUnits = new Set(); // unit yang record sebelumnya gagal kirim — sisanya menunggu
  for (const rec of todo) {
    if (blockedUnits.has(rec.unit)) continue; // tetap pending, dicoba lagi berurutan
    try {
      const r = await syncOne(db, rec);
      if (r === 'ok') anySuccess = true;
      else if (r === 'fail') blockedUnits.add(rec.unit);
    } catch (err) {
      blockedUnits.add(rec.unit);
      if (!connErr) connErr = err;
    }
  }

  // SYNC_DONE cuma dikirim kalau MINIMAL 1 record benar-benar 'synced' (hindari toast sukses palsu).
  if (anySuccess) {
    const clientsList = await self.clients.matchAll({ type: 'window' });
    clientsList.forEach(c => c.postMessage({ type: 'SYNC_DONE' }));
  }

  // Lempar ulang SETELAH SYNC_DONE terkirim, supaya browser menjadwalkan ulang event 'sync'.
  if (connErr) throw connErr;
}

// Hasil: 'ok' (tersimpan), 'rejected' (ditolak aturan data, tidak memblokir record lain),
// 'fail' (gagal jaringan/server, record lain di unit yang sama menunggu).
async function syncOne(db, rec) {
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 60000); // sama dgn index.html: GAS bisa cold start / antre lock

    const res = await fetch(GAS_URL, {
      method: 'POST',
      body: JSON.stringify({ action: 'submitBan', data: rec.payload }),
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      redirect: 'follow',
      signal: ctrl.signal
    });
    clearTimeout(tid);

    let json, parseFailed = false;
    try { json = await res.json(); }
    catch { parseFailed = true; json = { status: 'error', message: 'Respons bukan JSON valid' }; }
    if (parseFailed && await sudahAdaDiServer(rec)) json = { status: 'ok' }; // data sebenarnya sudah masuk

    if (json.status === 'ok') {
      await dbUpdate(db, 'records', rec.localId, {
        status: 'synced', syncedAt: new Date().toISOString(), errorMsg: '', retryCount: 0, nextRetryAt: null
      });
      console.log('[SW] Sync OK:', rec.localId, rec.jenis, rec.unit);
      return 'ok';
    }

    if (json.code === 'VALIDASI') {
      await dbUpdate(db, 'records', rec.localId, { status: 'rejected', errorMsg: json.message || 'Ditolak server' });
      console.warn('[SW] Ditolak server (VALIDASI):', rec.localId, json.message);
      return 'rejected';
    }

    const count = (rec.retryCount || 0) + 1;
    await dbUpdate(db, 'records', rec.localId, {
      status: 'error', errorMsg: json.message || 'Respons tidak OK', retryCount: count,
      nextRetryAt: Date.now() + RETRY_DELAYS_MS[Math.min(count - 1, RETRY_DELAYS_MS.length - 1)]
    });
    console.warn('[SW] GAS error:', rec.localId, json.message);
    return 'fail';

  } catch (err) {
    // Timeout / jaringan putus di tengah jalan: data sering SUDAH masuk. Cek dulu supaya tidak dikirim ulang.
    if (await sudahAdaDiServer(rec)) {
      await dbUpdate(db, 'records', rec.localId, {
        status: 'synced', syncedAt: new Date().toISOString(), errorMsg: '', retryCount: 0, nextRetryAt: null
      });
      return 'ok';
    }
    const count = (rec.retryCount || 0) + 1;
    const msg = err.name === 'AbortError' ? 'Timeout (>60 detik)' : err.message;
    await dbUpdate(db, 'records', rec.localId, {
      status: 'error', errorMsg: msg, retryCount: count,
      nextRetryAt: Date.now() + RETRY_DELAYS_MS[Math.min(count - 1, RETRY_DELAYS_MS.length - 1)]
    });
    console.warn('[SW] Exception sync:', rec.localId, msg);
    // Timeout ditelan (record lain di unit LAIN tetap dicoba); error koneksi lain dilempar ulang
    // supaya browser menjadwalkan ulang event 'sync' dengan backoff bawaannya.
    if (err.name !== 'AbortError') throw err;
    return 'fail';
  }
}

// Sama dgn sudahAdaDiServer() di index.html. Hanya untuk record yang belum pernah synced
// (record hasil edit memang sudah punya Client ID di server).
async function sudahAdaDiServer(rec) {
  if (rec.syncedAt || !rec.tanggal) return false;
  try {
    const ctrl = new AbortController(), tid = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(GAS_URL + '?action=getHistory&date=' + encodeURIComponent(rec.tanggal), { method: 'GET', redirect: 'follow', signal: ctrl.signal });
    clearTimeout(tid);
    const json = JSON.parse(await res.text());
    if (json.status !== 'ok') return false;
    const id = rec.payload && rec.payload['Client ID'];
    if (!id) return false;
    const ids = new Set((json.rows || []).map(r => r.clientId));
    return rec.jenis === 'ganti' ? (ids.has(id + '-L') && ids.has(id + '-P')) : ids.has(id);
  } catch (e) { return false; }
}

// Sama dgn shouldRetryRecord() di index.html.
function shouldRetryRecord(rec) {
  if (rec.status === 'pending') return true;
  if (rec.status === 'error') {
    const count = rec.retryCount || 0;
    if (count >= RETRY_DELAYS_MS.length) return false;
    return Date.now() >= (rec.nextRetryAt || 0);
  }
  return false; // synced / rejected
}

// ── Helpers: IndexedDB ────────────────────────────────────
// Tidak ada onupgradeneeded dgn sengaja — DB & store dibuat oleh index.html (initDB).
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGetAll(db, store) {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(store)) return resolve([]);
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function dbUpdate(db, store, key, updates) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    const get = os.get(key);
    get.onsuccess = () => {
      if (!get.result) { resolve(); return; }
      const put = os.put(Object.assign({}, get.result, updates));
      put.onsuccess = () => resolve();
      put.onerror = () => reject(put.error);
    };
    get.onerror = () => reject(get.error);
  });
}
