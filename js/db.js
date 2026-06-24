'use strict';

const DEFAULT_WORKER_URL = 'https://kitchenaid-messenger.dr-kicthenaid.workers.dev';
const DEFAULT_API_KEY    = 'ka-secret-999';

const DB = {
  _store: { quotations: [], invoices: [], repairs: [], parts: [], expenses: [], attachments: [], settings: {}, sequences: {} },
  _syncTimer: null,
  _initialized: false,
  _loadedFromKV: false,
  _kvLastModified: 0,
  _conflictPromptOpen: false,
  _retryTimer: null,
  _retryIntervalMs: 30000,

  _workerUrl() {
    let u = (localStorage.getItem('ka_worker_url') || DEFAULT_WORKER_URL).trim().replace(/\/$/, '');
    if (u && !u.startsWith('http')) u = 'https://' + u;
    return u;
  },
  _apiKey()    { return localStorage.getItem('ka_api_key') || DEFAULT_API_KEY; },

  async init() {
    if (this._initialized) return;
    this._initialized = true;
    const ok = await this._attemptKVLoad();
    if (ok) {
      this._hideOfflineBanner();
      this.applyNavLogo();
      return;
    }
    // Fallback: load from localStorage
    this._store = {
      quotations: JSON.parse(localStorage.getItem('ka_quotations') || '[]'),
      invoices:   JSON.parse(localStorage.getItem('ka_invoices')   || '[]'),
      repairs:    JSON.parse(localStorage.getItem('ka_repairs')    || '[]'),
      parts:      JSON.parse(localStorage.getItem('ka_parts')      || '[]'),
      expenses:   JSON.parse(localStorage.getItem('ka_expenses')   || '[]'),
      attachments:JSON.parse(localStorage.getItem('ka_attachments')|| '[]'),
      settings:   JSON.parse(localStorage.getItem('ka_settings')  || '{}'),
      sequences:  {},
    };
    this._showOfflineBanner();
    this.applyNavLogo();
    this._startRetryReconnect();
  },

  async _attemptKVLoad() {
    const url = this._workerUrl();
    if (!url) return false;
    try {
      const r = await fetch(url + '/export', {
        headers: { 'X-API-Key': this._apiKey() },
      });
      if (r.ok) {
        const data = await r.json();
        this._store = {
          quotations: data.quotations || [],
          invoices:   data.invoices   || [],
          repairs:    data.repairs    || [],
          parts:      data.parts      || [],
          expenses:   data.expenses   || [],
          attachments:data.attachments || [],
          settings:   data.settings   || {},
          sequences:  data.sequences  || {},
        };
        this._kvLastModified = Number(data.lastModified) || 0;
        this._loadedFromKV = true;
        return true;
      }
    } catch (_) {}
    return false;
  },

  _startRetryReconnect() {
    if (this._retryTimer) return;
    this._retryTimer = setInterval(async () => {
      if (this._loadedFromKV) {
        clearInterval(this._retryTimer);
        this._retryTimer = null;
        return;
      }
      const ok = await this._attemptKVLoad();
      if (ok) {
        clearInterval(this._retryTimer);
        this._retryTimer = null;
        this._showReconnectedBanner();
      }
    }, this._retryIntervalMs);
  },

  _showReconnectedBanner() {
    if (typeof document === 'undefined') return;
    const banner = document.getElementById('ka-offline-banner');
    if (!banner) return;
    banner.style.background = '#bbf7d0';
    banner.style.color = '#14532d';
    banner.innerHTML = '✅ เชื่อมต่อ KV กลับมาแล้ว — กดเพื่อโหลดข้อมูลใหม่ <button id="ka-retry-sync" type="button" style="margin-left:12px;padding:4px 12px;background:#14532d;color:#fff;border:0;border-radius:4px;cursor:pointer;font-weight:600;font-size:13px;">โหลดข้อมูลใหม่</button>';
    const btn = document.getElementById('ka-retry-sync');
    if (btn) btn.addEventListener('click', () => location.reload());
  },

  _showOfflineBanner() {
    if (typeof document === 'undefined') return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this._showOfflineBanner());
      return;
    }
    if (document.getElementById('ka-offline-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'ka-offline-banner';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#fbbf24;color:#78350f;padding:10px 16px;text-align:center;font-size:14px;font-weight:600;box-shadow:0 2px 4px rgba(0,0,0,.15);font-family:-apple-system,Segoe UI,sans-serif;line-height:1.4;';
    banner.innerHTML = 'OFFLINE MODE — โหลดข้อมูลจาก KV ไม่สำเร็จ ข้อมูลที่แก้ไขจะไม่ sync ขึ้นเซิร์ฟเวอร์ <button id="ka-retry-sync" type="button" style="margin-left:12px;padding:4px 12px;background:#78350f;color:#fff;border:0;border-radius:4px;cursor:pointer;font-weight:600;font-size:13px;">รีเฟรช</button>';
    document.body.insertBefore(banner, document.body.firstChild);
    document.body.style.paddingTop = banner.offsetHeight + 'px';
    const btn = document.getElementById('ka-retry-sync');
    if (btn) btn.addEventListener('click', () => location.reload());
  },

  _hideOfflineBanner() {
    if (typeof document === 'undefined') return;
    const banner = document.getElementById('ka-offline-banner');
    if (banner) {
      banner.remove();
      document.body.style.paddingTop = '';
    }
  },

  _scheduleSync() {
    clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(() => this._doSync(), 800);
  },

  async forceSync() {
    clearTimeout(this._syncTimer);
    this._syncTimer = null;
    await this._doSync();
  },

  async _doSync() {
    // Safety: ห้าม sync ถ้ายังโหลดจาก KV ไม่สำเร็จ — ป้องกันการ overwrite KV ด้วย state ว่าง
    if (!this._loadedFromKV) {
      console.warn('[DB] Skip sync: not loaded from KV yet (refusing to overwrite remote data)');
      return;
    }
    if (this._conflictPromptOpen) {
      console.warn('[DB] Skip sync: conflict prompt already open');
      return;
    }
    const url = this._workerUrl();
    if (!url) return;
    try {
      const r = await fetch(url + '/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': this._apiKey() },
        body: JSON.stringify({ ...this._store, _lastModified: this._kvLastModified }),
      });
      if (r.status === 409) {
        const conflict = await r.json().catch(() => ({}));
        await this._handleConflict(conflict);
        return;
      }
      if (r.ok) {
        const result = await r.json().catch(() => ({}));
        if (result.lastModified) this._kvLastModified = Number(result.lastModified);
      }
    } catch (_) {}
  },

  async _handleConflict(conflict) {
    this._conflictPromptOpen = true;
    try {
      const serverTime = conflict.serverLastModified
        ? new Date(conflict.serverLastModified).toLocaleString('th-TH')
        : '-';
      const msg =
        'พบข้อมูลใหม่กว่าบนเซิร์ฟเวอร์ (อาจมีคนแก้ไขจากเครื่องอื่น)\n\n' +
        `เวลาแก้ไขล่าสุดบนเซิร์ฟเวอร์: ${serverTime}\n\n` +
        'OK = ทับด้วยข้อมูลในเครื่องนี้ (ข้อมูลใหม่จากเครื่องอื่นจะหาย)\n' +
        'Cancel = โหลดข้อมูลใหม่จากเซิร์ฟเวอร์ (การแก้ไขล่าสุดในเครื่องนี้จะหาย)';
      const overwrite = confirm(msg);
      if (overwrite) {
        this._kvLastModified = Number(conflict.serverLastModified) || Date.now();
        await this._doSync();
      } else if (conflict.currentData) {
        this._store = {
          quotations: conflict.currentData.quotations || [],
          invoices:   conflict.currentData.invoices   || [],
          repairs:    conflict.currentData.repairs    || [],
          parts:      conflict.currentData.parts      || [],
          expenses:   conflict.currentData.expenses   || [],
          attachments:conflict.currentData.attachments || [],
          settings:   conflict.currentData.settings   || {},
          sequences:  conflict.currentData.sequences  || {},
        };
        this._kvLastModified = Number(conflict.serverLastModified) || 0;
        location.reload();
      }
    } finally {
      this._conflictPromptOpen = false;
    }
  },

  uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  },

  nextNum(prefix) {
    const yr = new Date().getFullYear();
    const key = `${prefix}_${yr}`;
    const n = (this._store.sequences[key] || 0) + 1;
    this._store.sequences[key] = n;
    this._scheduleSync();
    return `${prefix}-${yr}-${String(n).padStart(4, '0')}`;
  },

  // ---- Parts / Stock ----
  getParts() { return this._store.parts || []; },
  addPart(p) {
    p.id = this.uid(); p.createdAt = new Date().toISOString();
    this._store.parts = [...this.getParts(), p];
    this._scheduleSync(); return p;
  },
  updatePart(id, data) {
    const list = this.getParts();
    const i = list.findIndex(x => x.id === id);
    if (i < 0) return null;
    list[i] = { ...list[i], ...data, updatedAt: new Date().toISOString() };
    this._store.parts = list; this._scheduleSync(); return list[i];
  },
  deletePart(id) {
    this._store.parts = this.getParts().filter(p => p.id !== id);
    this._scheduleSync();
  },

  // ---- Expenses (รายจ่าย) ----
  getExpenses() { return this._store.expenses || []; },
  addExpense(e) {
    e.id = e.id || this.uid(); e.createdAt = new Date().toISOString();
    this._store.expenses = [...this.getExpenses(), e];
    this._scheduleSync(); return e;
  },
  updateExpense(id, data) {
    const list = this.getExpenses();
    const i = list.findIndex(x => x.id === id);
    if (i < 0) return null;
    list[i] = { ...list[i], ...data, updatedAt: new Date().toISOString() };
    this._store.expenses = list; this._scheduleSync(); return list[i];
  },
  deleteExpense(id) {
    this._store.expenses = this.getExpenses().filter(e => e.id !== id);
    this._scheduleSync();
  },

  // ---- Attachments (ไฟล์แนบลูกค้า เช่น 50ทวิ/หนังสือรับรองหักภาษี ณ ที่จ่าย) ----
  // ไฟล์จริงเก็บใน R2 (ผ่าน uploadFile); ที่นี่เก็บแค่ metadata + url (ห้ามฝัง base64).
  getAttachments() { return this._store.attachments || []; },
  addAttachment(a) {
    a.id = a.id || this.uid(); a.createdAt = new Date().toISOString();
    this._store.attachments = [...this.getAttachments(), a];
    this._scheduleSync(); return a;
  },
  deleteAttachment(id) {
    this._store.attachments = this.getAttachments().filter(a => a.id !== id);
    this._scheduleSync();
  },

  // อัปโหลดไฟล์ขึ้น R2 ผ่าน worker /image → คืน { ok, key, url }
  // dir: 'wht' (50ทวิ) | 'parts' | 'expenses'.  file = File/Blob.
  async uploadFile(dir, id, file) {
    const url = this._workerUrl();
    if (!url) return { ok: false, error: 'no worker url' };
    const ext = (file.name || '').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const ep = `${url}/image?dir=${encodeURIComponent(dir)}&id=${encodeURIComponent(id)}&ext=${encodeURIComponent(ext)}`;
    try {
      const r = await fetch(ep, {
        method: 'POST',
        headers: { 'X-API-Key': this._apiKey(), 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: d.error || ('HTTP ' + r.status) };
      return d; // { ok, key, url }
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  },

  // ลบไฟล์ออกจาก R2 (best-effort) ตาม key
  async deleteFile(key) {
    const url = this._workerUrl();
    if (!url || !key) return;
    try {
      await fetch(`${url}/image?key=${encodeURIComponent(key)}`, {
        method: 'DELETE',
        headers: { 'X-API-Key': this._apiKey() },
      });
    } catch (_) {}
  },

  // ---- Quotations ----
  getQuotations() { return this._store.quotations || []; },
  addQuotation(q) {
    q.id = this.uid(); q.createdAt = new Date().toISOString();
    this._store.quotations = [...this.getQuotations(), q];
    this._scheduleSync(); return q;
  },
  updateQuotation(id, data) {
    const list = this.getQuotations();
    const i = list.findIndex(x => x.id === id);
    if (i < 0) return null;
    list[i] = { ...list[i], ...data, updatedAt: new Date().toISOString() };
    this._store.quotations = list; this._scheduleSync(); return list[i];
  },
  deleteQuotation(id) {
    this._store.quotations = this.getQuotations().filter(q => q.id !== id);
    this._scheduleSync();
  },
  getQuotationById(id) { return this.getQuotations().find(q => q.id === id) || null; },

  // ---- Invoices ----
  getInvoices() { return this._store.invoices || []; },
  addInvoice(inv) {
    inv.id = this.uid(); inv.createdAt = new Date().toISOString();
    this._store.invoices = [...this.getInvoices(), inv];
    this._scheduleSync(); return inv;
  },
  updateInvoice(id, data) {
    const list = this.getInvoices();
    const i = list.findIndex(x => x.id === id);
    if (i < 0) return null;
    list[i] = { ...list[i], ...data, updatedAt: new Date().toISOString() };
    this._store.invoices = list; this._scheduleSync(); return list[i];
  },
  deleteInvoice(id) {
    this._store.invoices = this.getInvoices().filter(inv => inv.id !== id);
    this._scheduleSync();
  },
  getInvoiceById(id) { return this.getInvoices().find(inv => inv.id === id) || null; },

  // ---- Repairs ----
  getRepairs() { return this._store.repairs || []; },
  addRepair(r) {
    r.id = this.uid(); r.createdAt = new Date().toISOString();
    this._store.repairs = [...this.getRepairs(), r];
    this._scheduleSync(); return r;
  },
  updateRepair(id, data) {
    const list = this.getRepairs();
    const i = list.findIndex(x => x.id === id);
    if (i < 0) return null;
    list[i] = { ...list[i], ...data, updatedAt: new Date().toISOString() };
    this._store.repairs = list; this._scheduleSync(); return list[i];
  },
  deleteRepair(id) {
    this._store.repairs = this.getRepairs().filter(r => r.id !== id);
    this._scheduleSync();
  },
  getRepairById(id) { return this.getRepairs().find(r => r.id === id) || null; },

  // ---- Settings ----
  getSettings() {
    const defaults = {
      shopName: 'KitchenAid Service Center',
      address: '', phone: '', email: '', taxId: '',
      vatRate: 7, paymentInfo: '',
    };
    return { ...defaults, ...this._store.settings };
  },
  saveSettings(s) {
    this._store.settings = s;
    this._scheduleSync();
  },

  applyNavLogo() {
    const logo = this.getSettings().shopLogo;
    const img  = document.getElementById('nav-logo');
    const icon = document.getElementById('nav-icon');
    if (!img) return;
    if (logo) {
      img.src = logo; img.style.display = '';
      if (icon) icon.style.display = 'none';
    } else {
      img.style.display = 'none';
      if (icon) icon.style.display = '';
    }
  },
};

document.addEventListener('DOMContentLoaded', () => DB.applyNavLogo());
