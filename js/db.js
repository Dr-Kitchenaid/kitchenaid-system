'use strict';

const DB = {
  _store: { quotations: [], invoices: [], repairs: [], parts: [], settings: {}, sequences: {} },
  _syncTimer: null,
  _initialized: false,

  _workerUrl() { return (localStorage.getItem('ka_worker_url') || '').replace(/\/$/, ''); },
  _apiKey()    { return localStorage.getItem('ka_api_key') || ''; },

  async init() {
    if (this._initialized) return;
    this._initialized = true;
    const url = this._workerUrl();
    if (url) {
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
            settings:   data.settings   || {},
            sequences:  data.sequences  || {},
          };
          this.applyNavLogo();
          return;
        }
      } catch (_) {}
    }
    // Fallback: load from localStorage
    this._store = {
      quotations: JSON.parse(localStorage.getItem('ka_quotations') || '[]'),
      invoices:   JSON.parse(localStorage.getItem('ka_invoices')   || '[]'),
      repairs:    JSON.parse(localStorage.getItem('ka_repairs')    || '[]'),
      parts:      JSON.parse(localStorage.getItem('ka_parts')      || '[]'),
      settings:   JSON.parse(localStorage.getItem('ka_settings')  || '{}'),
      sequences:  {},
    };
    this.applyNavLogo();
  },

  _scheduleSync() {
    clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(() => this._doSync(), 800);
  },

  async _doSync() {
    const url = this._workerUrl();
    if (!url) return;
    try {
      await fetch(url + '/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': this._apiKey() },
        body: JSON.stringify(this._store),
      });
    } catch (_) {}
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
