// Tokenhound — sniffs out where your prompt tokens go.
// Read-only: it never adds anything to the prompt and never edits chats or cards.

import { STRINGS } from './i18n.js';
import { houndSvg, houseSvg } from './sprites.js';

const MODULE = 'tokenhound';
const VERSION = '0.5.19';
const LOG_PREFIX = 'tokenhound:log:';
const LOG_INDEX = 'tokenhound:index';
const LOG_FORMAT = 1;
const MAX_CHATS = 100;
const SIDE_PREFIX = 'tokenhound:side:';
const SIDE_MAX = 200; // side calls kept per chat
const POS_KEY = 'tokenhound:btnpos';
const HOUSE_POS_KEY = 'tokenhound:housepos';
const DISPLAYS = ['button', 'walk', 'house', 'menu'];
const HOUSE_NUMS = ['sign', 'donut'];
const FAB_STYLES = ['line', 'ring', 'plain'];
const TAP_OPENS = ['card', 'window'];
const WALK_TOYS = ['off', 'nose', 'ride'];
const THEMES = ['auto', 'light', 'dark'];
const CARD_MIN_CHANGE = 50; // smaller changes are left out of the quick card
const SERVER_PREFIX = 'tokenhound-';
const SERVER_INDEX = 'tokenhound-index.json';
const SERVER_FORMAT = 1;

const DEFAULTS = Object.freeze({
    enabled: true,
    display: 'walk',
    barOn: false,
    barHound: true,
    fabStyle: 'line',
    tapOpens: 'card',
    barTap: 'window',
    walkToy: 'off',
    houseNum: 'sign',
    mainWalk: true,
    lang: 'auto',
    theme: 'auto',
    readUsage: true,
    serverSync: true,
    showEstimate: true,
    logSize: 50,
    stages: [50, 85, 95],
    exportScope: 'chat',
    exportWhat: 'all',
    exportNames: true,
    exportModels: true,
});
const EXPORT_SCOPES = ['chat', 'all'];
const EXPORT_WHATS = ['all', 'chat', 'side'];

const COLORS = {
    preset: '#7F77DD',
    card: '#D4537E',
    persona: '#1D9E75',
    examples: '#5DCAA5',
    wi: '#EF9F27',
    ext: '#378ADD',
    history: '#97C459',
};
const PART_ORDER = ['preset', 'card', 'persona', 'examples', 'wi', 'ext', 'history'];
const STAGE_COLORS = ['#7F77DD', '#7F77DD', '#EF9F27', '#E24B4A'];

const SKIP_EXT_KEYS = ['QUIET_PROMPT', '__STORY_STRING__'];
const SKIP_EXT_PREFIX = ['customDepthWI', 'customWIOutlet'];
const KNOWN_EXT = {
    '1_memory': 'ext_summary',
    '2_floating_prompt': 'ext_authors_note',
    '3_vectors': 'ext_vectors',
    '4_vectors_data_bank': 'ext_databank',
    'chromadb': 'ext_smart',
    'PERSONA_DESCRIPTION': 'ext_persona',
};

/** @type {typeof DEFAULTS} */
let settings;
let eventsBound = false;
let failedSaveWarned = false;

const state = {
    chatId: null,
    log: [],            // turn records for the current chat
    side: [],           // AI calls made apart from chat replies, for the current chat
    latest: null,       // last real turn
    contFrom: null,     // send time of the message a "continue" is about to change
    estimate: null,     // last estimate (not saved)
    current: null,      // generation being watched
    generating: false,
    estimateRunning: false,
    pendingUsage: null, // { rec } waiting for the API reply
    prevPrompt: new Map(), // chatId -> array of message texts (memory only)
    lastWi: [],         // world info entries of the last real turn (memory only)
    open: false,
    view: 'main',
    expand: { wi: false, ext: false },
    logOpen: new Set(),   // turns opened in the turn log (by time)
    logExpand: new Set(), // "<time>:wi" / "<time>:ext" opened inside a turn
    pane: 'chat',         // first screen: 'chat' (chat replies) or 'side' (side calls)
    paneMenu: false,      // pane picker open
    sideOpen: new Set(),  // side-call groups opened (by extension)
    baseHeight: window.innerHeight,
    seq: 0,
};

// ---------- helpers ----------

const ctx = () => SillyTavern.getContext();

function lang() {
    if (settings?.lang === 'en' || settings?.lang === 'ko') return settings.lang;
    let loc = '';
    try { loc = ctx().getCurrentLocale?.() || ''; } catch { /* ignore */ }
    if (!loc) { try { loc = localStorage.getItem('language') || ''; } catch { /* ignore */ } }
    return String(loc).toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

function t(key, vars = {}) {
    const dict = STRINGS[lang()] || STRINGS.en;
    let s = dict[key] ?? STRINGS.en[key] ?? key;
    for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
    return s;
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const fmt = n => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');
function short(n) {
    if (!Number.isFinite(n)) return '—';
    if (n >= 100000) return `${Math.round(n / 1000)}k`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(Math.round(n));
}
const squash = s => String(s ?? '').replace(/\s+/g, ' ').trim();

function contentText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(p => (typeof p === 'string' ? p : (p?.text ?? ''))).join('\n');
    return '';
}

async function count(text) {
    const s = String(text ?? '');
    if (!s.trim()) return 0;
    try {
        const c = ctx();
        if (typeof c.getTokenCountAsync === 'function') return await c.getTokenCountAsync(s);
    } catch { /* fall through */ }
    return Math.ceil(s.length / 3.5);
}

function stageOf(pct) {
    const [a, b, c] = settings.stages;
    if (pct >= c) return 4;
    if (pct >= b) return 3;
    if (pct >= a) return 2;
    return 1;
}

function toast(type, msg) {
    try { window.toastr?.[type]?.(msg, t('title')); } catch { /* ignore */ }
}

function isMobile() {
    return window.matchMedia('(max-width: 700px)').matches;
}

// ---------- settings ----------

function loadSettings() {
    const c = ctx();
    const store = c.extensionSettings;
    store[MODULE] = Object.assign({}, structuredClone(DEFAULTS), store[MODULE] || {});
    const s = store[MODULE];
    if (!Array.isArray(s.stages) || s.stages.length !== 3) s.stages = DEFAULTS.stages.slice();
    s.stages = s.stages.map(n => Math.min(100, Math.max(1, Number(n) || 50)));
    s.logSize = [20, 50, 100].includes(Number(s.logSize)) ? Number(s.logSize) : 50;
    // 0.2.x "bar" display became its own switch: keep the screen looking the same.
    if (s.display === 'bar') { s.display = 'menu'; s.barOn = true; }
    if (!DISPLAYS.includes(s.display)) s.display = DEFAULTS.display;
    s.barOn = !!s.barOn;
    s.barHound = s.barHound !== false;
    if (!FAB_STYLES.includes(s.fabStyle)) s.fabStyle = DEFAULTS.fabStyle;
    if (!TAP_OPENS.includes(s.tapOpens)) s.tapOpens = DEFAULTS.tapOpens;
    if (!TAP_OPENS.includes(s.barTap)) s.barTap = DEFAULTS.barTap;
    if (!WALK_TOYS.includes(s.walkToy)) s.walkToy = DEFAULTS.walkToy;
    if (!THEMES.includes(s.theme)) s.theme = DEFAULTS.theme;
    if (!HOUSE_NUMS.includes(s.houseNum)) s.houseNum = DEFAULTS.houseNum;
    s.mainWalk = s.mainWalk !== false;
    if (!EXPORT_SCOPES.includes(s.exportScope)) s.exportScope = DEFAULTS.exportScope;
    if (!EXPORT_WHATS.includes(s.exportWhat)) s.exportWhat = DEFAULTS.exportWhat;
    s.exportNames = s.exportNames !== false;
    s.exportModels = s.exportModels !== false;
    delete s.showBar; // 0.1.0 setting
    settings = s;
}

function saveSettings() {
    try { ctx().saveSettingsDebounced(); } catch { /* ignore */ }
}

// ---------- turn log storage (this device only) ----------

function loadSide(chatId) {
    if (!chatId) return [];
    try {
        const data = JSON.parse(localStorage.getItem(SIDE_PREFIX + chatId) || 'null');
        return Array.isArray(data?.calls) ? data.calls.filter(r => r && Number.isFinite(r.t)) : [];
    } catch { return []; }
}

function storeSide(chatId, calls) {
    if (!chatId) return;
    try { localStorage.setItem(SIDE_PREFIX + chatId, JSON.stringify({ v: 1, calls })); } catch { /* ignore */ }
}

/** Joins two side-call lists by time. */
function mergeSide(local, remote, cutoff) {
    const byT = new Map();
    for (const r of remote || []) if (r && Number.isFinite(r.t)) byT.set(r.t, r);
    for (const r of local || []) if (r && Number.isFinite(r.t)) byT.set(r.t, r);
    return [...byT.values()].filter(r => r.t > cutoff).sort((x, y) => x.t - y.t).slice(-SIDE_MAX);
}

function loadLog(chatId) {
    if (!chatId) return [];
    try {
        const raw = localStorage.getItem(LOG_PREFIX + chatId);
        if (!raw) return [];
        const data = JSON.parse(raw);
        if (data?.v !== LOG_FORMAT || !Array.isArray(data.turns)) return [];
        return data.turns.filter(r => r && Number.isFinite(r.t));
    } catch { return []; }
}

function saveLog() {
    const chatId = state.chatId;
    if (!chatId) return;
    try {
        const turns = state.log.slice(-settings.logSize);
        state.log = turns;
        localStorage.setItem(LOG_PREFIX + chatId, JSON.stringify({ v: LOG_FORMAT, turns }));
        let index = [];
        try { index = JSON.parse(localStorage.getItem(LOG_INDEX) || '[]'); } catch { index = []; }
        index = index.filter(id => id !== chatId);
        index.push(chatId);
        while (index.length > MAX_CHATS) {
            const old = index.shift();
            try { localStorage.removeItem(LOG_PREFIX + old); } catch { /* ignore */ }
        }
        localStorage.setItem(LOG_INDEX, JSON.stringify(index));
    } catch (e) {
        console.warn('[Tokenhound] save failed', e);
        if (!failedSaveWarned) { failedSaveWarned = true; toast('warning', t('save_failed')); }
    }
    schedulePush();
}

// ---------- turn log on the SillyTavern server (shared between devices) ----------
// Small JSON files in the user's "files" folder (the same place as Data Bank uploads).
// Only numbers and names are stored, never message text. Chat files are not touched.

let syncWarned = false;
let pushTimer = null;
let pushChain = Promise.resolve();
let lastPull = { chatId: null, at: 0 };

function fileNameFor(chatId) {
    // SillyTavern only allows letters, numbers, '-' and '_' in names, so hash the chat ID.
    const bytes = new TextEncoder().encode(String(chatId));
    let a = 0x811c9dc5;
    let b = 0x9747b28c;
    for (const x of bytes) {
        a = Math.imul(a ^ x, 16777619) >>> 0;
        b = Math.imul(b ^ x, 2246822519) >>> 0;
    }
    return `${SERVER_PREFIX}${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}.json`;
}

function requestHeaders() {
    try { return ctx().getRequestHeaders?.() || { 'Content-Type': 'application/json' }; } catch { return { 'Content-Type': 'application/json' }; }
}

function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

async function serverRead(name) {
    const res = await fetch(`/user/files/${name}?t=${Date.now()}`, { method: 'GET', cache: 'no-store', headers: requestHeaders() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`read ${res.status}`);
    try { return await res.json(); } catch { return null; }
}

async function serverWrite(name, obj) {
    const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers: requestHeaders(),
        body: JSON.stringify({ name, data: toBase64(JSON.stringify(obj)) }),
    });
    if (!res.ok) throw new Error(`write ${res.status}`);
}

async function serverDelete(name) {
    const res = await fetch('/api/files/delete', {
        method: 'POST',
        headers: requestHeaders(),
        body: JSON.stringify({ path: `user/files/${name}` }),
    });
    if (!res.ok && res.status !== 404) throw new Error(`delete ${res.status}`);
}

function syncFailed(e) {
    console.warn('[Tokenhound] server sync failed', e);
    if (!syncWarned) { syncWarned = true; toast('warning', t('sync_failed')); }
}

async function readIndex() {
    const idx = await serverRead(SERVER_INDEX);
    const files = Array.isArray(idx?.files) ? idx.files.filter(f => typeof f === 'string' && f.startsWith(SERVER_PREFIX)) : [];
    return { v: SERVER_FORMAT, files, clearedAllAt: Number(idx?.clearedAllAt) || 0 };
}

/** Joins two turn lists by time. This device's copy wins for the same turn. */
function mergeTurns(local, remote, cutoff) {
    const byT = new Map();
    for (const r of remote || []) if (r && Number.isFinite(r.t)) byT.set(r.t, r);
    for (const r of local || []) {
        if (!r || !Number.isFinite(r.t)) continue;
        const o = byT.get(r.t);
        byT.set(r.t, o?.void && !r.void && !r.out ? { ...r, void: true, awaitingReply: false } : r);
    }
    return [...byT.values()].filter(r => r.t > cutoff).sort((x, y) => x.t - y.t).slice(-settings.logSize);
}

const sameTurns = (x, y) => x.length === y.length && x.every((r, i) => r.t === y[i].t);

function adoptMerged(chatId, merged, side) {
    if (side) storeSide(chatId, side);
    if (state.chatId !== chatId) return;
    const before = state.log;
    const sideBefore = state.side;
    if (side) state.side = side;
    state.log = merged;
    const last = lastShown();
    if (!state.latest || !last || last.t !== state.latest.t) state.latest = last;
    try { localStorage.setItem(LOG_PREFIX + chatId, JSON.stringify({ v: LOG_FORMAT, turns: merged })); } catch { /* ignore */ }
    if (!sameTurns(before, merged) || (side && !sameTurns(sideBefore, side))) render();
}

/** Loads the server copy of this chat's log and merges it in. */
async function pullLog(force = false) {
    const chatId = state.chatId;
    if (!settings.serverSync || !chatId) return;
    if (!force && lastPull.chatId === chatId && Date.now() - lastPull.at < 3000) return;
    lastPull = { chatId, at: Date.now() };
    try {
        const name = fileNameFor(chatId);
        // Only ask for files the index knows about, so the browser console stays free of 404s.
        const index = await readIndex();
        const file = index.files.includes(name) ? await serverRead(name) : null;
        const cutoff = Math.max(index.clearedAllAt, Number(file?.clearedAt) || 0);
        const remote = file?.v === SERVER_FORMAT && Array.isArray(file.turns) ? file.turns : [];
        const merged = mergeTurns(state.chatId === chatId ? state.log : [], remote, cutoff);
        const rSide = Array.isArray(file?.side) ? file.side : [];
        const side = mergeSide(state.chatId === chatId ? state.side : loadSide(chatId), rSide, cutoff);
        adoptMerged(chatId, merged, side);
        if (!sameTurns(merged, mergeTurns([], remote, cutoff)) || !sameTurns(side, mergeSide([], rSide, cutoff))) schedulePush();
    } catch (e) {
        syncFailed(e);
    }
}

function schedulePush() {
    if (!settings?.serverSync || !state.chatId) return;
    clearTimeout(pushTimer);
    const chatId = state.chatId;
    pushTimer = setTimeout(() => { pushChain = pushChain.then(() => pushLog(chatId)).catch(() => {}); }, 2000);
}

/** Saves this chat's log to the server, merging with what is there first. */
async function pushLog(chatId) {
    if (!settings.serverSync || !chatId) return;
    try {
        const name = fileNameFor(chatId);
        // Only ask for files the index knows about, so the browser console stays free of 404s.
        const index = await readIndex();
        const file = index.files.includes(name) ? await serverRead(name) : null;
        const fileCut = Number(file?.clearedAt) || 0;
        const cutoff = Math.max(index.clearedAllAt, fileCut);
        const remote = file?.v === SERVER_FORMAT && Array.isArray(file.turns) ? file.turns : [];
        const local = state.chatId === chatId ? state.log : loadLog(chatId);
        const merged = mergeTurns(local, remote, cutoff);
        const side = mergeSide(state.chatId === chatId ? state.side : loadSide(chatId), Array.isArray(file?.side) ? file.side : [], cutoff);
        await serverWrite(name, { v: SERVER_FORMAT, clearedAt: fileCut, turns: merged, side });
        adoptMerged(chatId, merged, side);
        if (!index.files.includes(name)) {
            index.files.push(name);
            while (index.files.length > MAX_CHATS) {
                const old = index.files.shift();
                try { await serverDelete(old); } catch { /* ignore */ }
            }
            await serverWrite(SERVER_INDEX, index);
        }
    } catch (e) {
        syncFailed(e);
    }
}

async function clearServerChat(chatId) {
    if (!settings.serverSync || !chatId) return;
    // Keep an empty file with a "cleared" time, so other devices drop their older copies too.
    try {
        const name = fileNameFor(chatId);
        await serverWrite(name, { v: SERVER_FORMAT, clearedAt: Date.now(), turns: [], side: [] });
        const index = await readIndex();
        if (!index.files.includes(name)) { index.files.push(name); await serverWrite(SERVER_INDEX, index); }
    } catch (e) {
        syncFailed(e);
    }
}

async function clearServerAll() {
    if (!settings.serverSync) return;
    try {
        const index = await readIndex();
        for (const name of index.files) {
            try { await serverDelete(name); } catch { /* ignore */ }
        }
        await serverWrite(SERVER_INDEX, { v: SERVER_FORMAT, files: [], clearedAllAt: Date.now() });
    } catch (e) {
        syncFailed(e);
    }
}

function clearChatLog() {
    clearTimeout(pushTimer);
    const chatId = state.chatId;
    pushChain = pushChain.then(() => clearServerChat(chatId)).catch(() => {});
    if (state.chatId) {
        try { localStorage.removeItem(LOG_PREFIX + state.chatId); } catch { /* ignore */ }
        try { localStorage.removeItem(SIDE_PREFIX + state.chatId); } catch { /* ignore */ }
    }
    state.log = [];
    state.side = [];
    state.latest = null;
    state.estimate = null;
    state.prevPrompt.delete(state.chatId);
}

function clearAllLogs() {
    clearTimeout(pushTimer);
    pushChain = pushChain.then(() => clearServerAll()).catch(() => {});
    try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && (k.startsWith(LOG_PREFIX) || k.startsWith(SIDE_PREFIX) || k === LOG_INDEX)) keys.push(k);
        }
        keys.forEach(k => localStorage.removeItem(k));
    } catch { /* ignore */ }
    state.prevPrompt.clear();
    state.log = [];
    state.latest = null;
    state.estimate = null;
}

// ---------- model / limits ----------

function connectionInfo() {
    const c = ctx();
    let model = '';
    let profile = '';
    try {
        if (c.mainApi === 'openai') {
            model = c.getChatCompletionModel?.(c.chatCompletionSettings) || c.chatCompletionSettings?.model || '';
        } else if (c.onlineStatus && c.onlineStatus !== 'no_connection') {
            model = String(c.onlineStatus);
        }
    } catch { /* ignore */ }
    try {
        const cm = c.extensionSettings?.connectionManager;
        const p = cm?.profiles?.find(x => x.id === cm.selectedProfile);
        profile = p?.name || '';
    } catch { /* ignore */ }
    return { model: String(model || ''), profile: String(profile || '') };
}

function limits() {
    const c = ctx();
    try {
        if (c.mainApi === 'openai') {
            const s = c.chatCompletionSettings || {};
            return { max: Number(s.openai_max_context) || 0, reply: Number(s.openai_max_tokens) || 0 };
        }
    } catch { /* ignore */ }
    let reply = 0;
    try { reply = Number(document.getElementById('amount_gen')?.value) || 0; } catch { /* ignore */ }
    return { max: Number(c.maxContext) || 0, reply };
}

// ---------- analysis ----------

function makeLocator(texts) {
    const norm = texts.map(squash);
    const probesOf = (text) => {
        const s = squash(text);
        if (!s) return [];
        if (s.length <= 60) return [s];
        const mid = Math.floor(s.length / 2);
        return [s.slice(0, 48), s.slice(mid - 20, mid + 20), s.slice(-40)];
    };
    return {
        norm,
        find(text, fromEnd = false, strict = false) {
            const probes = probesOf(text);
            if (!probes.length) return null;
            const order = [...norm.keys()];
            if (fromEnd) order.reverse();
            for (const i of order) {
                if (strict && probes.length === 3) {
                    // Start matches, or both middle and end match in the same message.
                    const a = norm[i].indexOf(probes[0]);
                    if (a !== -1) return { msg: i, off: a };
                    const b = norm[i].indexOf(probes[1]);
                    if (b !== -1 && norm[i].indexOf(probes[2]) !== -1) return { msg: i, off: b };
                    continue;
                }
                for (const p of probes) {
                    const off = norm[i].indexOf(p);
                    if (off !== -1) return { msg: i, off };
                }
            }
            return null;
        },
    };
}

// Installed extensions' names, read once from SillyTavern (read-only).
let stExt = null;
let extNames = null;
let extNamesFrom = -1;

async function loadStExtensions() {
    try { stExt = await import('../../../extensions.js'); } catch { stExt = null; }
}

const squashName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function installedNames() {
    const list = stExt?.extensionNames;
    if (!Array.isArray(list)) return [];
    if (extNames && extNamesFrom === list.length) return extNames;
    const out = [];
    for (const full of list) {
        const folder = String(full).replace(/^third-party\//, '');
        let shown = '';
        try { shown = stExt.getExtensionManifest?.(full)?.display_name || ''; } catch { /* ignore */ }
        const plain = folder.replace(/^(SillyTavern|ST)[-_ ]+/i, '');
        const label = shown || plain;
        for (const n of new Set([shown, folder, plain].map(squashName))) {
            if (n.length >= 4 && n !== 'tokenhound') out.push({ n, label });
        }
    }
    out.sort((a, b) => b.n.length - a.n.length);
    extNames = out;
    extNamesFrom = list.length;
    return out;
}

function extLabel(key) {
    if (KNOWN_EXT[key]) return t(KNOWN_EXT[key]);
    if (key.startsWith('DEPTH_PROMPT')) return t('ext_char_note');
    const sq = squashName(key.replace(/^\d+_/, ''));
    const hit = sq && installedNames().find(e => sq.startsWith(e.n));
    if (hit) return hit.label;
    return key.replace(/^\d+_/, '').replace(/[_-]+/g, ' ').trim() || key;
}

/**
 * Builds a turn record from the final prompt.
 * @param {{role: string, text: string}[]} msgs
 * @param {object} cur
 */
async function analyze(msgs, cur) {
    const c = ctx();
    const texts = msgs.map(m => m.text);
    const loc = makeLocator(texts);
    const msgTokens = await Promise.all(texts.map(count));
    const total = msgTokens.reduce((a, b) => a + b, 0);
    const spots = []; // { label, msg, off } for cache diff

    const parts = { preset: 0, card: 0, persona: 0, examples: 0, wi: 0, ext: 0, history: 0 };
    const items = []; // for "biggest items"

    // Character card
    let fields = {};
    try { fields = c.getCharacterCardFields?.() || {}; } catch { fields = {}; }
    let cardName = '';
    try { if (c.groupId) cardName = c.characters?.[c.characterId]?.name || ''; } catch { /* ignore */ }
    for (const f of ['description', 'personality', 'scenario', 'system', 'jailbreak']) {
        const text = fields[f];
        if (!text || !String(text).trim()) continue;
        const at = loc.find(text);
        if (!at) continue;
        const n = await count(text);
        parts.card += n;
        spots.push({ label: t('part_card'), ...at });
    }
    if (parts.card) items.push({ label: cardName ? t('part_card_named', { name: cardName }) : t('part_card'), tok: parts.card });

    // Persona
    if (fields.persona && String(fields.persona).trim()) {
        const at = loc.find(fields.persona);
        if (at) {
            parts.persona = await count(fields.persona);
            spots.push({ label: t('part_persona'), ...at });
            items.push({ label: t('part_persona'), tok: parts.persona });
        }
    }

    // Example dialogue
    if (fields.mesExamples && String(fields.mesExamples).trim()) {
        const blocks = String(fields.mesExamples).split(/<START>/i).map(s => s.trim()).filter(Boolean);
        let at = null;
        for (const b of blocks) { at = loc.find(b); if (at) break; }
        if (at) {
            parts.examples = await count(blocks.join('\n'));
            spots.push({ label: t('part_examples'), ...at });
            items.push({ label: t('part_examples'), tok: parts.examples });
        }
    }

    // World info (activated entries reported by SillyTavern)
    const wi = [];
    // SillyTavern doesn't report world info on dry runs, so estimates reuse the last real turn's entries.
    const wiSource = cur.est ? state.lastWi : (cur.wi || []);
    if (!cur.est) state.lastWi = cur.wi || [];
    for (const e of wiSource) {
        const text = e.content || '';
        if (!text.trim()) continue;
        if (cur.est && !loc.find(text)) continue;
        const n = await count(text);
        const name = e.name || t('wi_unnamed', { uid: e.uid });
        wi.push({ uid: e.uid, world: e.world || '', n: name, tok: n, sq: squash(text) });
        parts.wi += n;
        const at = loc.find(text);
        if (at) spots.push({ label: `${t('part_wi', { n: '' }).replace(/\s*\(.*\)/, '')}: ${name}`, ...at });
        items.push({ label: name, tok: n });
    }

    // Extension prompts
    const ext = [];
    let extPrompts = {};
    try { extPrompts = c.extensionPrompts || {}; } catch { extPrompts = {}; }
    for (const [key, p] of Object.entries(extPrompts)) {
        if (SKIP_EXT_KEYS.includes(key) || SKIP_EXT_PREFIX.some(x => key.startsWith(x))) continue;
        const value = p?.value;
        if (!value || !String(value).trim()) continue;
        const at = loc.find(value);
        if (!at) continue;
        let n = await count(value);
        // World info placed inside Author's note etc. is already counted above.
        const sqv = squash(value);
        for (const w of wi) if (w.sq && sqv.includes(w.sq)) n -= w.tok;
        n = Math.max(0, n);
        if (key === 'PERSONA_DESCRIPTION' && !parts.persona) { parts.persona = n; items.push({ label: t('part_persona'), tok: n }); spots.push({ label: t('part_persona'), ...at }); continue; }
        if (key.startsWith('DEPTH_PROMPT')) { parts.card += n; spots.push({ label: t('ext_char_note'), ...at }); continue; }
        const label = extLabel(key);
        ext.push({ k: key, label, tok: n });
        parts.ext += n;
        spots.push({ label, ...at });
        items.push({ label, tok: n });
    }
    ext.sort((a, b) => b.tok - a.tok);

    // Chat history: walk back from the newest message until it stops matching.
    const chat = Array.isArray(c.chat) ? c.chat : [];
    const visible = [];
    let hidden = 0;
    for (let i = 0; i < chat.length; i++) {
        if (!chat[i] || !String(chat[i].mes ?? '').trim()) continue;
        if (chat[i].is_system) hidden++;
        else visible.push(i);
    }
    // A swipe rewrites the last reply, so that message is not in the prompt on purpose.
    if (cur?.type === 'swipe' && visible.length && !chat[visible[visible.length - 1]].is_user) visible.pop();
    let inc = 0;
    let misses = 0;
    let histStart = Infinity;
    const usedMsgs = new Set();
    let histTokSum = 0;
    let lastHistMsg = Infinity;
    const sourceMsgs = new Set(spots.map(x => x.msg));
    for (let j = visible.length - 1; j >= 0; j--) {
        const m = chat[visible[j]];
        let at = loc.find(m.mes, true, true);
        // In chat completion, a history message can't be one of the sections found above,
        // and history runs in order (older messages sit earlier in the prompt).
        if (at && texts.length > 1 && (sourceMsgs.has(at.msg) || at.msg > lastHistMsg)) at = null;
        if (at) {
            lastHistMsg = at.msg;
            inc++;
            misses = 0;
            histStart = Math.min(histStart, at.msg);
            if (texts.length > 1) usedMsgs.add(at.msg);
            else histTokSum += await count(m.mes);
        } else {
            misses++;
            if (misses >= (inc ? 3 : 6)) break;
        }
    }
    if (texts.length > 1) for (const i of usedMsgs) parts.history += msgTokens[i];
    else parts.history = histTokSum;
    if (Number.isFinite(histStart)) spots.push({ label: '__history__', msg: histStart, off: 0 });

    const known = parts.card + parts.persona + parts.examples + parts.wi + parts.ext + parts.history;
    parts.preset = Math.max(0, total - known);
    const sum = PART_ORDER.reduce((a, k) => a + parts[k], 0);

    const { max, reply } = limits();
    const info = connectionInfo();
    items.sort((a, b) => b.tok - a.tok);

    return {
        id: ++state.seq + '-' + Date.now(),
        t: Date.now(),
        est: !!cur.est,
        total: Math.max(total, sum),
        max,
        reply,
        parts,
        wi: wi.map(({ uid, world, n, tok }) => ({ uid, world, n, tok })),
        ext,
        top: items.slice(0, 3),
        hist: { inc, all: visible.length, hidden },
        model: info.model,
        profile: info.profile,
        cardName,
        usage: null,
        usageState: cur.est ? 'none' : (settings.readUsage ? 'waiting' : 'off'),
        out: null,
        awaitingReply: !cur.est,
        cache: null,
        _texts: texts,
        _spots: spots,
    };
}

function cacheDiff(rec, prevTexts, prevRec) {
    const res = { state: 'first', where: '', pct: 0, wiNew: [], wiGone: [], extChanged: [] };
    if (prevRec) {
        const prevWi = new Map((prevRec.wi || []).map(w => [`${w.world}:${w.uid}`, w.n]));
        const nowWi = new Map((rec.wi || []).map(w => [`${w.world}:${w.uid}`, w.n]));
        for (const [k, n] of nowWi) if (!prevWi.has(k)) res.wiNew.push(n);
        for (const [k, n] of prevWi) if (!nowWi.has(k)) res.wiGone.push(n);
        const prevExt = new Map((prevRec.ext || []).map(e => [e.k, e.tok]));
        for (const e of rec.ext || []) if (prevExt.has(e.k) && prevExt.get(e.k) !== e.tok) res.extChanged.push(e.label);
    }
    if (!prevTexts) return res;
    const now = rec._texts;
    let i = 0;
    while (i < now.length && i < prevTexts.length && now[i] === prevTexts[i]) i++;
    if (i >= prevTexts.length) { res.state = 'same'; return res; }
    const a = now[i] || '';
    const b = prevTexts[i] || '';
    let k = 0;
    while (k < a.length && k < b.length && a[k] === b[k]) k++;
    const totalChars = now.reduce((x, s) => x + s.length, 0) || 1;
    const prefix = now.slice(0, i).reduce((x, s) => x + s.length, 0) + k;
    res.state = 'changed';
    res.pct = Math.round((prefix / totalChars) * 100);
    // Find the section that starts at or before the change point.
    const pointNorm = squash(a.slice(0, k)).length;
    let best = null;
    for (const s of rec._spots) {
        if (s.msg < i || (s.msg === i && s.off <= pointNorm + 1)) {
            if (!best || s.msg > best.msg || (s.msg === best.msg && s.off > best.off)) best = s;
        }
    }
    if (!best) res.where = t('cache_where_unknown');
    else if (best.label === '__history__') res.where = (i === best.msg) ? t('cache_where_history_old') : t('cache_where_history');
    else res.where = best.label;
    return res;
}

function stripPrivate(rec) {
    const { _texts, _spots, ...rest } = rec;
    return rest;
}

async function runAnalysis(msgs, cur) {
    try {
        const rec = await analyze(msgs, cur);
        if (cur.chatId !== ctx().getCurrentChatId?.()) return; // chat changed meanwhile
        const prevTexts = state.prevPrompt.get(cur.chatId) || null;
        const prevRec = lastShown();
        rec.cache = rec.est ? null : cacheDiff(rec, prevTexts, prevRec);
        if (rec.est) {
            state.estimate = stripPrivate(rec);
        } else {
            cur.prevTexts = prevTexts;
            cur.texts = rec._texts;
            state.prevPrompt.set(cur.chatId, rec._texts);
            const clean = stripPrivate(rec);
            cur.rec = clean;
            state.log.push(clean);
            state.latest = clean;
            state.estimate = null;
            const up = cur.usagePending;
            if (up) { up.rec = clean; if (up.onRec) { up.onRec(clean); up.onRec = null; } }
            if (cur.pendingReply) { await attachReply(clean, cur.pendingReply); }
            else if (cur.ended) settleTurn(cur);
            saveLog();
        }
        render();
    } catch (e) {
        console.warn('[Tokenhound] analysis failed', e);
    }
}

async function attachReply(rec, messageId) {
    try {
        const m = ctx().chat?.[messageId];
        if (!m || m.is_user) return;
        // Message number as SillyTavern shows it (#N), plus which swipe it was.
        if (Number.isInteger(Number(messageId))) rec.mid = Number(messageId);
        if (Array.isArray(m.swipes) && m.swipes.length > 1 && Number.isInteger(m.swipe_id)) rec.sw = m.swipe_id + 1;
        // The reply's send time, to find the message again after earlier ones are deleted.
        if (m.send_date) {
            const sd = String(m.send_date);
            const old = state.contFrom;
            state.contFrom = null;
            // "Continue" gives the message a new send time: move older turns along with it.
            if (old && old !== sd) for (const r of state.log) if (r.sd === old) r.sd = sd;
            rec.sd = sd;
        }
        rec.out = { text: await count(m.mes), reason: await count(m.extra?.reasoning || '') };
    } catch { /* ignore */ }
    rec.awaitingReply = false;
}

// ---------- API usage (read-only response watch) ----------

function normUsage(u) {
    if (!u || typeof u !== 'object') return null;
    const num = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : undefined);
    const r = {
        input: num(u.prompt_tokens ?? u.input_tokens ?? u.promptTokenCount),
        output: num(u.completion_tokens ?? u.output_tokens ?? u.candidatesTokenCount),
        cached: num(u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? u.cachedContentTokenCount ?? u.prompt_cache_hit_tokens ?? u.input_tokens_details?.cached_tokens),
        write: num(u.cache_creation_input_tokens),
        reason: num(u.completion_tokens_details?.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens ?? u.thoughtsTokenCount),
        separate: ('cache_read_input_tokens' in u) || ('cache_creation_input_tokens' in u),
    };
    if (r.input === undefined && r.output === undefined) return null;
    return r;
}

function pickUsage(o) {
    if (!o || typeof o !== 'object') return null;
    return normUsage(o.usage || o.usageMetadata || o.message?.usage || o.response?.usage || null);
}

function mergeUsage(a, b) {
    if (!a) return b;
    if (!b) return a;
    const out = { separate: a.separate || b.separate };
    for (const k of ['input', 'output', 'cached', 'write', 'reason']) {
        const x = a[k]; const y = b[k];
        out[k] = x === undefined ? y : (y === undefined ? x : Math.max(x, y));
    }
    return out;
}

async function readUsage(res, pending) {
    let usage = null;
    try {
        if (!res.ok) throw new Error('not ok');
        const text = await res.text();
        const isStream = (res.headers.get('content-type') || '').includes('event-stream') || /^\s*(data|event):/.test(text);
        if (isStream) {
            for (const line of text.split('\n')) {
                const s = line.trim();
                if (!s.startsWith('data:')) continue;
                const body = s.slice(5).trim();
                if (!body || body === '[DONE]' || !body.includes('oken')) continue;
                try { usage = mergeUsage(usage, pickUsage(JSON.parse(body))); } catch { /* skip */ }
            }
        } else {
            try { usage = pickUsage(JSON.parse(text)); } catch { /* not json */ }
        }
    } catch { usage = null; }
    if (usage && usage.separate) usage.input = (usage.input || 0) + (usage.cached || 0) + (usage.write || 0);
    const apply = (rec) => {
        rec.usage = usage ? { input: usage.input, output: usage.output, cached: usage.cached, write: usage.write, reason: usage.reason } : null;
        rec.usageState = usage ? 'ok' : 'none';
        saveLog();
        render();
    };
    if (pending.rec) apply(pending.rec);
    else pending.onRec = apply;
}

// ---------- AI calls made apart from chat replies (read-only) ----------

const OWN_FOLDER = (() => {
    try { return decodeURIComponent((/\/scripts\/extensions\/(?:third-party\/)?([^/]+)\//.exec(import.meta.url) || [])[1] || ''); } catch { return ''; }
})();

function callStack() {
    const limit = Error.stackTraceLimit;
    try {
        Error.stackTraceLimit = 60;
        return String(new Error().stack || '');
    } catch { return ''; } finally {
        try { Error.stackTraceLimit = limit; } catch { /* ignore */ }
    }
}

/**
 * The extension folder that made the call, from the call stack. '' if unknown.
 * Extensions that only wrap fetch sit before SillyTavern's own request code,
 * so the first extension after SillyTavern's code is the caller.
 */
function callerFolder(stack) {
    const extRe = /\/scripts\/extensions\/(third-party\/)?([^/\s?#:]+)\//;
    let seenCore = false;
    let fallback = '';
    for (const line of String(stack).split('\n')) {
        const m = extRe.exec(line);
        if (m) {
            let folder = m[2];
            try { folder = decodeURIComponent(folder); } catch { /* keep */ }
            if (folder === OWN_FOLDER) continue;
            const full = (m[1] ? 'third-party/' : '') + folder;
            if (seenCore) return full;
            if (!fallback) fallback = full;
        } else if (/\/(scripts\/[^\s)]*|script)\.js/.test(line)) {
            seenCore = true;
        }
    }
    // Called fetch directly (no SillyTavern code in between): that extension is the caller.
    return seenCore ? '' : fallback;
}

function folderLabel(full) {
    if (!full) return '';
    let shown = '';
    try { shown = stExt?.getExtensionManifest?.(full)?.display_name || ''; } catch { /* ignore */ }
    return shown;
}

const folderPlain = (full) => String(full || '').replace(/^third-party\//, '');

function sideModel(body) {
    if (body?.model) return String(body.model);
    if (body && !body.chat_completion_source && !body.api_type) return '';
    try { return ctx().getChatCompletionModel?.() || ''; } catch { return ''; }
}

function bodyText(body) {
    if (!body) return '';
    if (Array.isArray(body.messages)) return body.messages.map(m => contentText(m?.content)).join('\n');
    if (typeof body.prompt === 'string') return body.prompt;
    return '';
}

function replyText(json) {
    try {
        const c = json?.choices?.[0];
        if (c) return contentText(c.message?.content ?? c.text ?? '');
        if (Array.isArray(json?.content)) return json.content.map(x => x?.text || '').join('');
        const g = json?.candidates?.[0]?.content?.parts;
        if (Array.isArray(g)) return g.map(x => x?.text || '').join('');
        if (typeof json?.output === 'string') return json.output;
    } catch { /* ignore */ }
    return '';
}

function watchSide(p, body, stack, chatId) {
    if (!chatId) return; // only calls made while a chat is open
    const t0 = Date.now();
    const src = callerFolder(stack);
    const model = sideModel(body);
    p.then(async (res) => {
        if (!res || !res.ok) return;
        let usage = null;
        let outText = null;
        if (settings.readUsage) {
            try {
                const text = await res.clone().text();
                const isStream = (res.headers.get('content-type') || '').includes('event-stream') || /^\s*(data|event):/.test(text);
                if (isStream) {
                    let out = '';
                    for (const line of text.split('\n')) {
                        const s2 = line.trim();
                        if (!s2.startsWith('data:')) continue;
                        const b = s2.slice(5).trim();
                        if (!b || b === '[DONE]') continue;
                        try {
                            const j = JSON.parse(b);
                            const d = j?.choices?.[0]?.delta;
                            out += contentText(d?.content ?? '') || j?.choices?.[0]?.text || j?.delta?.text || replyText(j) || '';
                            if (b.includes('oken')) usage = mergeUsage(usage, pickUsage(j));
                        } catch { /* skip */ }
                    }
                    outText = out;
                } else {
                    const json = JSON.parse(text);
                    usage = pickUsage(json);
                    outText = replyText(json);
                }
            } catch { /* keep going with estimates */ }
            if (usage && usage.separate) usage.input = (usage.input || 0) + (usage.cached || 0) + (usage.write || 0);
        }
        let est = false;
        let input = Number.isFinite(usage?.input) ? usage.input : null;
        let output = Number.isFinite(usage?.output) ? usage.output : null;
        if (input === null) { input = await count(bodyText(body)); est = true; }
        if (output === null && outText !== null) { output = await count(outText); est = true; }
        addSide(chatId, { t: t0, src, name: folderLabel(src) || folderPlain(src), model, in: input, out: output, est: est || undefined });
    }).catch(() => { /* failed or stopped: not counted */ });
}

function addSide(chatId, rec) {
    const list = chatId === state.chatId ? state.side : loadSide(chatId);
    while (list.some(r => r.t === rec.t)) rec.t += 1; // keep times unique
    list.push(rec);
    list.sort((a, b) => a.t - b.t);
    const kept = list.slice(-SIDE_MAX);
    if (chatId === state.chatId) state.side = kept;
    storeSide(chatId, kept);
    if (chatId === state.chatId) { schedulePush(); if (state.open && state.view === 'main') render(); }
}

function installFetchWatch() {
    if (window.__tokenhoundFetchWatch) return;
    const original = window.fetch;
    if (typeof original !== 'function') return;
    const watched = function (input, init) {
        // Who is calling: read before the request starts, while the call stack is still here.
        let stack = '';
        let hit = null;
        try {
            const url = typeof input === 'string' ? input : (input?.url || '');
            hit = settings?.enabled ? /\/api\/backends\/(chat|text)-completions\/generate/.exec(url) : null;
            if (hit) stack = callStack();
        } catch { hit = null; }
        const p = original.apply(this, arguments);
        if (!hit) return p;
        try {
            let body = null;
            try { if (typeof init?.body === 'string') body = JSON.parse(init.body); } catch { body = null; }
            const pending = state.pendingUsage;
            // Chat replies carry a type (normal, swipe, continue...). Calls without one, or "quiet", are side calls.
            const isReply = hit[1] === 'chat' && body ? (typeof body.type === 'string' && body.type !== 'quiet') : !!pending;
            if (isReply) {
                if (pending && settings.readUsage) {
                    state.pendingUsage = null;
                    p.then(res => { try { readUsage(res.clone(), pending); } catch { /* ignore */ } }).catch(() => { /* ignore */ });
                }
            } else {
                watchSide(p, body, stack, ctx().getCurrentChatId?.() || null);
            }
        } catch { /* never break the request */ }
        return p;
    };
    window.fetch = watched;
    window.__tokenhoundFetchWatch = true;
}

// ---------- event handlers ----------

function onGenerationStarted(type, _params, dryRun) {
    if (!settings.enabled) return;
    if (type === 'quiet') return; // background calls from other features
    if (dryRun && !state.estimateRunning) return; // SillyTavern's own dry runs
    if (!dryRun) state.generating = true;
    if (!dryRun) {
        const chat = ctx().chat;
        const last = Array.isArray(chat) ? chat[chat.length - 1] : null;
        state.contFrom = type === 'continue' && last && !last.is_user && last.send_date ? String(last.send_date) : null;
    }
    state.current = { type, est: !!dryRun, wi: [], chatId: ctx().getCurrentChatId?.() || null, done: false, pendingReply: null };
}

function onWorldInfoActivated(entries) {
    const cur = state.current;
    if (!cur || cur.done || !Array.isArray(entries)) return;
    cur.wi = entries.map(e => ({
        uid: e?.uid,
        world: e?.world || '',
        name: e?.comment || (Array.isArray(e?.key) ? e.key[0] : '') || '',
        content: String(e?.content ?? ''),
    }));
}

function takePrompt(msgs, dryRun) {
    const cur = state.current;
    if (!cur || cur.done || !!dryRun !== cur.est) return;
    cur.done = true;
    if (!cur.est && settings.readUsage) {
        const pending = { rec: null, onRec: null };
        cur.usagePending = pending;
        state.pendingUsage = pending;
        setTimeout(() => { if (state.pendingUsage === pending) state.pendingUsage = null; }, 20000);
    }
    // Do the counting later so the request isn't delayed.
    setTimeout(() => { runAnalysis(msgs, cur); }, 0);
}

function onChatCompletionPromptReady(data) {
    if (!settings.enabled || !data || !Array.isArray(data.chat)) return;
    const msgs = data.chat.map(m => ({ role: m?.role || '', text: contentText(m?.content) }));
    takePrompt(msgs, data.dryRun);
}

function onCombinePrompts(data) {
    if (!settings.enabled || !data || typeof data.prompt !== 'string') return;
    if (ctx().mainApi === 'openai') return;
    takePrompt([{ role: 'prompt', text: data.prompt }], data.dryRun);
}

function onMessageReceived(messageId, type) {
    if (!settings.enabled || type === 'quiet') return;
    // The newest turn, even a hidden one: a reply can still come in after "stop".
    const rec = state.log[state.log.length - 1];
    if (rec && !rec.est && (rec.awaitingReply || (rec.void && !rec.out)) && Date.now() - rec.t < 30 * 60 * 1000) {
        attachReply(rec, messageId).then(() => {
            if (rec.void && rec.out) { delete rec.void; state.latest = rec; }
            saveLog(); render();
        });
    } else if (state.current && state.current.done && !state.current.est) {
        state.current.pendingReply = messageId; // analysis still running
    }
}

// A turn that ends with no reply and no usage (stop, swipe stop, error) is hidden,
// so the card and window keep showing the turn before it.
const SETTLE_MS = 2000;

function settleTurn(cur) {
    const chatId = cur.chatId;
    setTimeout(() => {
        if (state.chatId !== chatId || !cur.rec) return;
        const rec = state.log.find(r => r.t === cur.rec.t);
        if (!rec || !rec.awaitingReply) return; // the reply came in
        rec.awaitingReply = false;
        if (!rec.out && !rec.usage) {
            rec.void = true;
            if (rec.usageState === 'waiting') rec.usageState = 'none';
            if (state.latest === rec) state.latest = lastShown();
            // Compare the next turn with the turn before this one.
            if (state.prevPrompt.get(chatId) === cur.texts) {
                if (cur.prevTexts) state.prevPrompt.set(chatId, cur.prevTexts);
                else state.prevPrompt.delete(chatId);
            }
        }
        saveLog();
        render();
    }, SETTLE_MS);
}

function onGenerationDone() {
    state.generating = false;
    const cur = state.current;
    if (cur && !cur.est && cur.done && !cur.ended) {
        cur.ended = true;
        if (cur.rec) settleTurn(cur); // otherwise runAnalysis does it when it finishes
    }
    // A turn that isn't the one being settled (rare): just stop waiting, as before.
    const rec = state.latest;
    if (rec && rec.awaitingReply && rec !== cur?.rec) { rec.awaitingReply = false; saveLog(); render(); }
    // If the API never reported usage, stop showing "waiting".
    setTimeout(() => {
        const r = state.latest;
        if (r && r.usageState === 'waiting') { r.usageState = 'none'; saveLog(); render(); }
    }, 4000);
}

function onChatChanged() {
    state.chatId = ctx().getCurrentChatId?.() || null;
    state.log = loadLog(state.chatId);
    state.side = loadSide(state.chatId);
    state.latest = lastShown();
    state.logOpen.clear();
    state.logExpand.clear();
    state.sideOpen.clear();
    state.paneMenu = false;
    state.estimate = null;
    state.current = null;
    state.pendingUsage = null;
    state.lastWi = [];
    closeCard();
    render();
    pullLog(true);
}

function bindEvents() {
    if (eventsBound) return;
    const c = ctx();
    const ev = c.eventSource;
    const T = c.eventTypes || c.event_types;
    if (!ev || !T) return;
    const on = (name, fn) => { if (T[name]) ev.on(T[name], (...a) => { try { return fn(...a); } catch (e) { console.warn('[Tokenhound]', name, e); } }); };
    on('GENERATION_STARTED', onGenerationStarted);
    on('WORLD_INFO_ACTIVATED', onWorldInfoActivated);
    on('CHAT_COMPLETION_PROMPT_READY', onChatCompletionPromptReady);
    on('GENERATE_AFTER_COMBINE_PROMPTS', onCombinePrompts);
    on('MESSAGE_RECEIVED', onMessageReceived);
    on('GENERATION_ENDED', onGenerationDone);
    on('GENERATION_STOPPED', onGenerationDone);
    on('CHAT_CHANGED', onChatChanged);
    on('SETTINGS_UPDATED', () => { renderDisplay(); });
    eventsBound = true;
}

// ---------- estimate ----------

async function runEstimate() {
    if (state.generating || state.estimateRunning) { toast('info', t('busy')); return; }
    const c = ctx();
    state.estimateRunning = true;
    render();
    try {
        await c.generate('normal', {}, true);
    } catch (e) {
        console.warn('[Tokenhound] estimate failed', e);
        toast('warning', t('estimate_failed'));
    } finally {
        state.estimateRunning = false;
        if (state.current?.est) state.current = null;
        setTimeout(render, 50);
    }
}

// ---------- UI ----------

function shown() {
    return state.estimate || state.latest;
}

/** Turns to show: a turn that ended with no reply and no usage (stopped, failed) stays hidden. */
function shownLog() {
    return state.log.filter(r => !r.void);
}

function lastShown() {
    for (let i = state.log.length - 1; i >= 0; i--) if (!state.log[i].void) return state.log[i];
    return null;
}

function prevShown(rec) {
    if (!rec) return null;
    for (let i = state.log.length - 1; i >= 0; i--) {
        const r = state.log[i];
        if (!r.void && r.t < rec.t) return r;
    }
    return null;
}

function pctOf(rec) {
    return rec && rec.max ? Math.round((rec.total / rec.max) * 100) : 0;
}

// Text tint for the fuller stages (calm stages keep the normal text color).
function pctClass(stage) {
    return stage >= 3 ? ` th-pct${stage}` : '';
}

// Small ring split by part, with the number in the middle (wandering hound bubble).
function donutSvg(rec, size = 30, w = 4, filled = false) {
    const r = (size - w) / 2;
    const c = 2 * Math.PI * r;
    const mid = size / 2;
    const ring = (stroke, len, off, extra = '') => `<circle cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-dasharray="${len.toFixed(2)} ${c.toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${mid} ${mid})"${extra}/>`;
    // Toy donuts get a solid middle so they don't look hollow on a big screen.
    let html = filled ? `<circle class="th-ring-fill" cx="${mid}" cy="${mid}" r="${r}"/>` : '';
    html += `<circle class="th-ring-empty" cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke-width="${w}"/>`;
    let off = 0;
    if (rec && rec.max) {
        for (const k of PART_ORDER) {
            const len = Math.min(c - off, ((rec.parts[k] || 0) / rec.max) * c);
            if (len > 0) { html += ring(COLORS[k], len, off); off += len; }
        }
        const rl = Math.min(c - off, ((rec.reply || 0) / rec.max) * c);
        if (rl > 0) html += ring('currentColor', rl, off, ' class="th-ring-reply"');
    }
    return `<svg class="th-ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true" focusable="false">${html}</svg>`;
}

function barSegments(rec) {
    if (!rec || !rec.max) return '';
    let html = '';
    for (const k of PART_ORDER) {
        const w = (rec.parts[k] / rec.max) * 100;
        if (w > 0) html += `<span style="width:${Math.min(100, w).toFixed(2)}%;background:${COLORS[k]}"></span>`;
    }
    const rw = (rec.reply / rec.max) * 100;
    if (rw > 0) html += `<span class="th-seg-reply" style="width:${Math.min(100, rw).toFixed(2)}%"></span>`;
    return html;
}

function deltaHtml(rec, prev, key) {
    if (!prev) return '';
    const d = (rec.parts[key] || 0) - (prev.parts?.[key] || 0);
    if (!d) return '<span class="th-delta"></span>';
    return `<span class="th-delta ${d > 0 ? 'th-up' : 'th-down'}">${d > 0 ? '+' : '−'}${fmt(Math.abs(d))}</span>`;
}

function partLabel(rec, k) {
    switch (k) {
        case 'preset': return t('part_preset');
        case 'card': return rec.cardName ? t('part_card_named', { name: rec.cardName }) : t('part_card');
        case 'persona': return t('part_persona');
        case 'examples': return t('part_examples');
        case 'wi': return t('part_wi', { n: (rec.wi || []).length });
        case 'ext': return t('part_ext');
        case 'history': return t('part_history', { inc: rec.hist?.inc ?? 0, all: rec.hist?.all ?? 0 });
    }
    return k;
}

// Item rows (main view and an opened turn in the turn log).
function partsHtml(rec, prev, isOpen, keyOf) {
    let html = '<div class="th-rows">';
    for (const k of PART_ORDER) {
        const v = rec.parts[k] || 0;
        if (!v && (k === 'examples' || k === 'persona')) continue;
        const pp = rec.total ? Math.round((v / rec.total) * 100) : 0;
        const expandable = k === 'wi' || k === 'ext';
        const open = expandable && isOpen(k);
        html += `<div class="th-row${expandable ? ' th-click' : ''}" ${expandable ? `data-expand="${esc(keyOf(k))}" role="button" tabindex="0"` : ''}>`
            + `<span class="th-dot" style="background:${COLORS[k]}"></span>`
            + `<span class="th-name th-ellipsis">${esc(partLabel(rec, k))}${expandable ? ` <i class="fa-solid fa-chevron-${open ? 'up' : 'down'} th-chev"></i>` : ''}</span>`
            + deltaHtml(rec, prev, k)
            + `<span class="th-num">${fmt(v)}</span><span class="th-pct">${pp}%</span></div>`;
        if (k === 'wi' && open) {
            html += '<div class="th-sub">';
            html += (rec.wi || []).length ? rec.wi.slice().sort((a, b) => b.tok - a.tok).map(w => `<div class="th-subrow"><span class="th-ellipsis">${esc(w.n)}</span><span class="th-num">${fmt(w.tok)}</span></div>`).join('') : `<div class="th-muted">${esc(t('wi_none'))}</div>`;
            html += '</div>';
        }
        if (k === 'ext' && open) {
            html += '<div class="th-sub">';
            html += (rec.ext || []).length ? rec.ext.map(e => `<div class="th-subrow"><span class="th-ellipsis">${esc(e.label)}</span><span class="th-num">${fmt(e.tok)}</span></div>`).join('') : `<div class="th-muted">${esc(t('ext_none'))}</div>`;
            html += '</div>';
        }
        if (k === 'history') {
            const cut = Math.max(0, (rec.hist?.all || 0) - (rec.hist?.inc || 0));
            if (cut) html += `<div class="th-sub th-warntext">${esc(t('history_cut', { n: cut }))}</div>`;
            if (rec.hist?.hidden) html += `<div class="th-sub th-muted">${esc(t('history_hidden', { n: rec.hist.hidden }))}</div>`;
        }
    }
    html += '</div>';
    return html;
}

function renderMain() {
    const rec = shown();
    if (!rec) {
        return `<div class="th-empty">${houndSvg(1, 3)}<div class="th-empty-title">${esc(t('empty_title'))}</div><div class="th-muted">${esc(t('empty_body'))}</div></div>${renderButtons()}`;
    }
    const prev = rec.est ? state.latest : prevShown(rec);
    const pct = pctOf(rec);
    const stage = stageOf(pct);
    const free = Math.max(0, rec.max - rec.total - rec.reply);
    const model = rec.model || t('no_model');
    const meta = rec.profile
        ? `<span class="th-meta-profile th-ellipsis">${esc(rec.profile)}</span><span class="th-meta-model th-ellipsis">${esc(model)}</span>`
        : `<span class="th-meta-model th-ellipsis">${esc(model)}</span>`;
    const metaTitle = [rec.profile, model].filter(Boolean).join(' · ');
    let html = '';
    html += `<div class="th-meta" title="${esc(metaTitle)}">${meta}</div>`;
    if (rec.est) html += `<div class="th-badge">${esc(t('estimate_badge'))}</div>`;
    html += `<div class="th-total"><span class="th-big">${fmt(rec.total)}</span><span class="th-muted th-ellipsis">${esc(t('of_context', { max: fmt(rec.max), pct }))}</span></div>`;
    html += `<div class="th-stack">${barSegments(rec)}</div>`;
    html += `<div class="th-small th-muted">${esc(t('reply_free', { reply: fmt(rec.reply), free: fmt(free) }))}</div>`;
    if (stage >= 3) html += `<div class="th-warn th-stage${stage}">${esc(t('warn_high'))}</div>`;

    html += partsHtml(rec, prev, k => !!state.expand[k], k => k);

    // Cache
    const ch = rec.cache;
    if (ch) {
        html += `<div class="th-sec">${esc(t('sec_cache'))}</div><div class="th-card">`;
        if (ch.state === 'first') html += `<div class="th-muted">${esc(t('cache_first'))}</div>`;
        else if (ch.state === 'same') html += `<div>${esc(t('cache_same'))}</div>`;
        else html += `<div>${esc(t('cache_changed', { where: ch.where, pct: ch.pct }))}</div>`;
        if (ch.wiNew?.length) html += `<div class="th-small">${esc(t('cache_wi_new', { list: ch.wiNew.join(', ') }))}</div>`;
        if (ch.wiGone?.length) html += `<div class="th-small">${esc(t('cache_wi_gone', { list: ch.wiGone.join(', ') }))}</div>`;
        if (ch.extChanged?.length) html += `<div class="th-small">${esc(t('cache_ext_changed', { list: ch.extChanged.join(', ') }))}</div>`;
        html += '</div>';
    }

    // API usage
    if (!rec.est) {
        html += `<div class="th-sec">${esc(t('sec_usage'))}</div><div class="th-card">`;
        if (!settings.readUsage) html += `<div class="th-muted">${esc(t('usage_off'))}</div>`;
        else if (rec.usageState === 'waiting') html += `<div class="th-muted">${esc(t('usage_waiting'))}</div>`;
        else if (!rec.usage) html += `<div class="th-muted">${esc(t('usage_none'))}</div>`;
        else {
            const u = rec.usage;
            const hit = u.cached !== undefined && u.input ? ` (${Math.round((u.cached / u.input) * 100)}%)` : '';
            const kv = [
                [t('usage_input'), fmt(u.input)],
                u.cached !== undefined ? [t('usage_cached'), fmt(u.cached) + hit] : null,
                u.write !== undefined ? [t('usage_cache_write'), fmt(u.write)] : null,
                [t('usage_output'), fmt(u.output)],
                u.reason !== undefined ? [t('usage_reasoning'), fmt(u.reason)] : null,
            ].filter(Boolean);
            html += '<div class="th-kv">' + kv.map(([a, b]) => `<span class="th-muted">${esc(a)}</span><span class="th-num">${esc(b)}</span>`).join('') + '</div>';
        }
        html += '</div>';
        if (rec.out) {
            html += `<div class="th-sec">${esc(t('sec_reply'))}</div><div class="th-card th-inline">`
                + `<span>${esc(t('reply_text', { n: fmt(rec.out.text) }))}</span>`
                + (rec.out.reason ? `<span>${esc(t('reply_reasoning', { n: fmt(rec.out.reason) }))}</span>` : '')
                + '</div>';
        }
    }

    // Biggest items
    if (rec.top?.length) {
        html += `<div class="th-sec">${esc(t('sec_top'))}</div><div class="th-card">`
            + rec.top.map((it, i) => `<div class="th-subrow"><span class="th-ellipsis">${i + 1}. ${esc(it.label)}</span><span class="th-num">${fmt(it.tok)}</span></div>`).join('')
            + '</div>';
    }

    // Trend
    const turns = shownLog().slice(-20);
    if (turns.length >= 2) {
        const maxV = Math.max(...turns.map(x => x.total), 1) * 1.1;
        const pts = turns.map((x, i) => `${((i / (turns.length - 1)) * 300).toFixed(1)},${(44 - (x.total / maxV) * 40).toFixed(1)}`).join(' ');
        html += `<div class="th-sec">${esc(t('sec_trend', { n: turns.length }))}</div>`
            + `<svg class="th-spark" viewBox="0 0 300 46" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${STAGE_COLORS[0]}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
    }

    html += renderButtons();
    return html;
}

function renderButtons() {
    let est = '';
    if (state.estimateRunning) est = `<button class="th-btn" data-act="estimate" aria-busy="true">${esc(t('estimating'))}</button>`;
    else if (state.estimate) est = `<button class="th-btn" data-act="estimate-off">${esc(t('btn_estimate_off'))}</button>`;
    else if (settings.showEstimate) est = `<button class="th-btn" data-act="estimate">${esc(t('btn_estimate'))}</button>`;
    return `<div class="th-btns"><button class="th-btn" data-act="log">${esc(t('btn_log'))}</button>${est}<button class="th-btn" data-act="copy">${esc(t('btn_copy'))}</button></div>`;
}

function paneHtml() {
    const n = state.side.length;
    const label = state.pane === 'side' ? t('pane_side') : t('pane_chat');
    let html = `<div class="th-pane" role="button" tabindex="0" data-act="pane" aria-haspopup="menu" aria-expanded="${state.paneMenu}"><span class="th-ellipsis">${esc(label)}</span><i class="fa-solid fa-chevron-${state.paneMenu ? 'up' : 'down'}"></i></div>`;
    if (state.paneMenu) {
        const item = (k, text, extra = '') => `<div class="th-paneitem${state.pane === k ? ' th-on' : ''}" role="menuitemradio" aria-checked="${state.pane === k}" tabindex="0" data-act="pane-${k}">${esc(text)}${extra}</div>`;
        html += `<div class="th-panemenu" role="menu">${item('chat', t('pane_chat'))}${item('side', t('pane_side'), n ? ` <span class="th-panecount">· ${esc(t('side_n', { n }))}</span>` : '')}</div>`;
    }
    return html;
}

function sideKey(r) { return r.src || ''; }

function sideName(key, fallback) {
    if (!key) return t('side_unknown');
    return folderLabel(key) || fallback || folderPlain(key);
}

const sideNum = (v) => (Number.isFinite(v) ? fmt(v) : '?');

function renderSide() {
    const calls = state.side;
    let html = `<div class="th-small th-muted th-sidedesc">${esc(t('side_desc'))}</div>`;
    if (!calls.length) return html + `<div class="th-muted th-pad">${esc(t('side_empty'))}</div>`;
    let tin = 0;
    let tout = 0;
    let anyEst = false;
    const groups = new Map();
    for (const r of calls) {
        tin += r.in || 0;
        tout += r.out || 0;
        if (r.est || !Number.isFinite(r.out)) anyEst = true;
        const k = sideKey(r);
        const g = groups.get(k) || { key: k, name: r.name, n: 0, in: 0, out: 0, model: '', last: 0, list: [], est: false };
        if (r.est || !Number.isFinite(r.out)) g.est = true;
        g.n += 1;
        g.in += r.in || 0;
        g.out += r.out || 0;
        if (r.t >= g.last) { g.last = r.t; g.model = r.model || g.model; if (r.name) g.name = r.name; }
        g.list.push(r);
        groups.set(k, g);
    }
    const tilde = anyEst ? '~' : '';
    html += `<div class="th-sidetiles">`
        + `<div class="th-sidetile"><div class="th-small th-muted">${esc(t('side_calls'))}</div><b>${esc(t('side_n', { n: calls.length }))}</b></div>`
        + `<div class="th-sidetile"><div class="th-small th-muted">${esc(t('side_sent'))}</div><b>${tilde}${fmt(tin)}</b></div>`
        + `<div class="th-sidetile"><div class="th-small th-muted">${esc(t('side_reply'))}</div><b>${tilde}${fmt(tout)}</b></div></div>`;
    const list = [...groups.values()].sort((a, b) => (b.in + b.out) - (a.in + a.out) || (a.key === '' ? 1 : 0) - (b.key === '' ? 1 : 0));
    html += '<div class="th-log">';
    for (const g of list) {
        const open = state.sideOpen.has(g.key);
        const name = sideName(g.key, g.name);
        html += `<div class="th-logitem"><div class="th-logrow th-click" data-sideopen="${esc(g.key)}" role="button" tabindex="0" aria-expanded="${open}"><div class="th-logmain"><div class="th-logtop"><span class="th-ellipsis th-logtitle${g.key ? '' : ' th-muted'}">${esc(name)}</span>${g.model ? `<span class="th-logtag th-ellipsis">${esc(g.model)}</span>` : ''}</div><div class="th-small th-muted th-ellipsis">${esc(t('side_row', { n: g.n, in: (g.est ? '~' : '') + fmt(g.in), out: (g.est ? '~' : '') + fmt(g.out) }))}</div></div><i class="fa-solid fa-chevron-${open ? 'up' : 'down'} th-chev"></i></div>`;
        if (open) {
            html += '<div class="th-logdetail">';
            for (const r of g.list.slice(-10).reverse()) {
                const time = new Date(r.t).toLocaleString(lang() === 'ko' ? 'ko-KR' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                const est = r.est || !Number.isFinite(r.out);
                html += `<div class="th-subrow"><span class="th-muted th-ellipsis">${esc(time)}${r.model && r.model !== g.model ? ` · ${esc(r.model)}` : ''}</span><span class="th-nowrap">${est ? '~' : ''}${sideNum(r.in)} → ${sideNum(r.out)}${est ? ` <span class="th-sideest">${esc(t('side_est'))}</span>` : ''}</span></div>`;
            }
            if (g.list.length > 10) html += `<div class="th-small th-muted">${esc(t('side_more', { n: g.list.length - 10 }))}</div>`;
            html += '</div>';
        }
        html += '</div>';
    }
    return html + '</div>';
}

/** Send time -> where that message (and swipe) is in the chat now. */
function sendDateMap() {
    const chat = ctx().chat;
    const map = new Map();
    if (!Array.isArray(chat)) return map;
    const add = (sd, i, s) => {
        if (!sd) return;
        const k = String(sd);
        const a = map.get(k);
        if (a) a.push([i, s]); else map.set(k, [[i, s]]);
    };
    chat.forEach((m, i) => {
        if (!m || m.is_user) return;
        const many = Array.isArray(m.swipes) && m.swipes.length > 1;
        if (many && Array.isArray(m.swipe_info)) {
            m.swipe_info.forEach((si, j) => add(si?.send_date, i, j + 1));
            if (Number.isInteger(m.swipe_id)) add(m.send_date, i, m.swipe_id + 1);
        } else add(m.send_date, i, 0);
    });
    return map;
}

function tagHtml(m) {
    if (!m) return '';
    if (m.gone) return `<span class="th-logtag th-gone">${esc(t('log_mid_gone'))}</span>`;
    return `<span class="th-logtag">${esc(m.s ? t('log_mid_swipe', { n: m.n, s: m.s }) : t('log_mid', { n: m.n }))}</span>`;
}

/** The message number to show for a turn now: {n, s} or {gone: true}, or null. */
function msgTag(r, map) {
    if (!Number.isInteger(r.mid)) return null;
    if (!r.sd || !map.size) return { n: r.mid, s: r.sw || 0 }; // older turns: as saved
    const hits = map.get(r.sd);
    if (!hits) return { gone: true };
    // Deleting only moves numbers down, so prefer the nearest one at or below the saved number.
    let best = null;
    for (const h of hits) {
        const below = h[0] <= r.mid;
        if (!best || (below && (!best.below || h[0] > best.h[0])) || (!below && !best.below && h[0] < best.h[0])) best = { h, below };
    }
    return { n: best.h[0], s: best.h[1] };
}

function renderLog() {
    const list = shownLog();
    if (!list.length) return `<div class="th-muted th-pad">${esc(t('log_empty'))}</div>`;
    const sdMap = sendDateMap();
    return '<div class="th-log">' + list.map((r, i) => {
        const pct = pctOf(r);
        const open = state.logOpen.has(r.t);
        const time = new Date(r.t).toLocaleString(lang() === 'ko' ? 'ko-KR' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        let html = `<div class="th-logitem${open ? ' th-open' : ''}">`
            + `<div class="th-logrow th-click" data-logrow="${r.t}" role="button" tabindex="0" aria-expanded="${open}">${houndSvg(stageOf(pct), 1)}<div class="th-logmain"><div class="th-logtop"><span class="th-ellipsis th-logtitle">${esc(t('log_item', { total: fmt(r.total), pct }))}</span>${tagHtml(msgTag(r, sdMap))}</div><div class="th-small th-muted th-ellipsis">${esc(time)} · ${esc(r.model || t('no_model'))}</div></div>`
            + `<div class="th-mini">${barSegments(r)}</div><i class="fa-solid fa-chevron-${open ? 'up' : 'down'} th-chev"></i></div>`;
        if (open) html += logDetailHtml(r, list[i - 1] || null);
        return html + '</div>';
    }).reverse().join('') + '</div>';
}

// What one saved turn looked like (opened below its row in the turn log).
function logDetailHtml(rec, prev) {
    const free = Math.max(0, rec.max - rec.total - rec.reply);
    let html = '<div class="th-logdetail">';
    html += `<div class="th-stack">${barSegments(rec)}</div>`;
    html += `<div class="th-small th-muted">${esc(t('reply_free', { reply: fmt(rec.reply), free: fmt(free) }))}</div>`;
    html += partsHtml(rec, prev, k => state.logExpand.has(`${rec.t}:${k}`), k => `${rec.t}:${k}`);
    const ch = rec.cache;
    if (ch && ch.state !== 'first') {
        html += `<div class="th-small">${esc(ch.state === 'same' ? t('cache_same') : t('cache_changed', { where: ch.where, pct: ch.pct }))}</div>`;
    }
    if (rec.out) {
        html += `<div class="th-small th-muted">${esc(t('reply_text', { n: fmt(rec.out.text) }))}${rec.out.reason ? ` · ${esc(t('reply_reasoning', { n: fmt(rec.out.reason) }))}` : ''}</div>`;
    }
    return html + '</div>';
}

function selectHtml(id, value, options) {
    return `<select id="${id}" class="th-select">${options.map(([v, label]) => `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
}

function displayOptions() {
    return DISPLAYS.map(d => [d, t('disp_' + d)]);
}

function fabStyleOptions() {
    return FAB_STYLES.map(f => [f, t('fab_' + f)]);
}

function tapOptions() {
    return TAP_OPENS.map(v => [v, t('tap_' + v)]);
}

function toyOptions() {
    return WALK_TOYS.map(v => [v, t('toy_' + v)]);
}

function houseNumOptions() {
    return HOUSE_NUMS.map(v => [v, t('house_num_' + v)]);
}

function themeOptions() {
    return [['auto', t('theme_auto')], ['light', t('theme_light')], ['dark', t('theme_dark')]];
}

function langOptions() {
    return [['auto', t('lang_auto')], ['en', 'English'], ['ko', '한국어']];
}

function exportScopeOptions() {
    return EXPORT_SCOPES.map(v => [v, t('exp_scope_' + v)]);
}

function exportWhatOptions() {
    return EXPORT_WHATS.map(v => [v, t('exp_what_' + v)]);
}

// ---------- data export (CSV, numbers and names only) ----------

/** Every chat on this device that has a turn log or side calls. The open chat uses what is in memory. */
function exportChats() {
    const ids = new Set();
    if (settings.exportScope === 'chat') {
        if (state.chatId) ids.add(state.chatId);
    } else {
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i) || '';
                if (k.startsWith(LOG_PREFIX)) ids.add(k.slice(LOG_PREFIX.length));
                else if (k.startsWith(SIDE_PREFIX)) ids.add(k.slice(SIDE_PREFIX.length));
            }
        } catch { /* ignore */ }
        if (state.chatId) ids.add(state.chatId);
    }
    return [...ids].map(id => ({
        id,
        turns: id === state.chatId ? state.log : loadLog(id),
        side: id === state.chatId ? state.side : loadSide(id),
    }));
}

function csvCell(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) || /^[=+\-@\t]/.test(s) ? `"${(/^[=+\-@\t]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s;
}

function csvTime(ms) {
    const d = new Date(ms);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Replaces names with "Chat 1", "Model 2"... in the order they first show up. */
function nameHider(keep, key) {
    const seen = new Map();
    return (name) => {
        if (!name) return '';
        if (keep) return name;
        if (!seen.has(name)) seen.set(name, t(key, { n: seen.size + 1 }));
        return seen.get(name);
    };
}

function buildCsvRows() {
    const what = settings.exportWhat;
    const sdMap = what !== 'side' ? sendDateMap() : new Map();
    const rows = [];
    for (const c of exportChats()) {
        if (what !== 'side') {
            for (const r of c.turns) {
                if (!r || r.void || r.est) continue;
                const tag = c.id === state.chatId ? msgTag(r, sdMap) : (Number.isInteger(r.mid) ? { n: r.mid, s: r.sw || 0 } : null);
                const u = r.usage || null;
                const counted = r.out ? (r.out.text || 0) + (r.out.reason || 0) : null;
                const inTok = Number.isFinite(u?.input) ? u.input : r.total;
                const outTok = Number.isFinite(u?.output) ? u.output : counted;
                const p = r.parts || {};
                rows.push({ t: r.t, cells: [
                    t('pane_chat'), c.id, csvTime(r.t),
                    tag ? (tag.gone ? t('log_mid_gone') : tag.n) : '', tag && tag.s ? tag.s : '',
                    r.cardName || '', '', r.profile || '', r.model || '',
                    inTok, outTok, Number.isFinite(u?.input) && Number.isFinite(u?.output) ? '' : 'y',
                    u?.cached ?? '', u?.reason ?? '',
                    r.total, r.max, r.reply,
                    p.preset, p.card, p.persona, p.examples, p.wi, p.ext, p.history,
                    r.hist?.inc ?? '', r.hist?.all ?? '', r.hist?.hidden ?? '',
                    r.cache?.state || '',
                ] });
            }
        }
        if (what !== 'chat') {
            for (const r of c.side) {
                if (!r) continue;
                const est = r.est || !Number.isFinite(r.out);
                const who = r.src ? (folderLabel(r.src) || r.name || folderPlain(r.src)) : t('side_unknown');
                rows.push({ t: r.t, cells: [
                    t('pane_side'), c.id, csvTime(r.t), '', '',
                    '', who, '', r.model || '',
                    r.in, Number.isFinite(r.out) ? r.out : '', est ? 'y' : '',
                    ...Array(16).fill(''),
                ] });
            }
        }
    }
    rows.sort((a, b) => a.t - b.t);
    // Hidden names are numbered in time order, so "Chat 1" is the first chat in the file.
    const hide = [[1, nameHider(settings.exportNames, 'exp_anon_chat')], [5, nameHider(settings.exportNames, 'exp_anon_char')],
        [7, nameHider(settings.exportModels, 'exp_anon_profile')], [8, nameHider(settings.exportModels, 'exp_anon_model')]];
    return rows.map(r => { for (const [i, f] of hide) r.cells[i] = f(r.cells[i]); return r.cells; });
}

function exportCsv() {
    let rows = [];
    try { rows = buildCsvRows(); } catch (e) { console.warn('[Tokenhound] export', e); }
    if (!rows.length) { toast('info', t('exp_none')); return; }
    const head = t('exp_head').split('|');
    const text = '\uFEFF' + [head, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    const file = `tokenhound-${settings.exportScope === 'all' ? 'all' : 'chat'}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.csv`;
    try {
        const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = file;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        toast('success', t('exp_done', { n: rows.length }));
    } catch (e) {
        console.warn('[Tokenhound] export', e);
        toast('warning', t('exp_fail'));
    }
}

function renderQuickSettings() {
    const check = (id, val, label) => `<label class="th-check"><input type="checkbox" id="${id}"${val ? ' checked' : ''}><span>${esc(label)}</span></label>`;
    return '<div class="th-settings">'
        + check('th-q-enabled', settings.enabled, t('set_enabled'))
        + `<label class="th-field"><span>${esc(t('set_display'))}</span>${selectHtml('th-q-display', settings.display, displayOptions())}</label>`
        + (settings.display === 'walk' ? `<label class="th-field"><span>${esc(t('set_walk_toy'))}</span>${selectHtml('th-q-toy', settings.walkToy, toyOptions())}</label>` : '')
        + (settings.display === 'house' ? `<label class="th-field"><span>${esc(t('set_house_num'))}</span>${selectHtml('th-q-housenum', settings.houseNum, houseNumOptions())}</label>` : '')
        + (settings.display === 'button' ? `<label class="th-field"><span>${esc(t('set_fab_style'))}</span>${selectHtml('th-q-fabstyle', settings.fabStyle, fabStyleOptions())}</label>` : '')
        + (settings.display !== 'menu' ? `<label class="th-field"><span>${esc(t('set_tap'))}</span>${selectHtml('th-q-tap', settings.tapOpens, tapOptions())}</label>` : '')
        + (settings.display !== 'menu' ? check('th-q-mainwalk', settings.mainWalk, t('set_main_walk')) : '')
        + check('th-q-bar', settings.barOn, t('set_bar'))
        + (settings.barOn ? check('th-q-barhound', settings.barHound, t('set_bar_hound')) : '')
        + (settings.barOn ? `<label class="th-field"><span>${esc(t('set_bar_tap'))}</span>${selectHtml('th-q-bartap', settings.barTap, tapOptions())}</label>` : '')
        + check('th-q-usage', settings.readUsage, t('set_usage'))
        + `<div class="th-small th-muted th-hint">${esc(t('set_usage_hint'))}</div>`
        + check('th-q-estimate', settings.showEstimate, t('set_estimate'))
        + `<label class="th-field"><span>${esc(t('set_theme'))}</span>${selectHtml('th-q-theme', settings.theme, themeOptions())}</label>`
        + `<label class="th-field"><span>${esc(t('set_lang'))}</span>${selectHtml('th-q-lang', settings.lang, langOptions())}</label>`
        + `<div class="th-export"><b>${esc(t('exp_title'))}</b>`
        + `<label class="th-field"><span>${esc(t('exp_scope'))}</span>${selectHtml('th-q-exscope', settings.exportScope, exportScopeOptions())}</label>`
        + `<label class="th-field"><span>${esc(t('exp_what'))}</span>${selectHtml('th-q-exwhat', settings.exportWhat, exportWhatOptions())}</label>`
        + check('th-q-exnames', settings.exportNames, t('exp_names'))
        + check('th-q-exmodels', settings.exportModels, t('exp_models'))
        + `<div class="th-btns th-exbtns"><button class="th-btn" data-act="export">${esc(t('exp_btn'))}</button></div>`
        + `<div class="th-small th-muted">${esc(t('exp_hint'))}</div></div>`
        + `<div class="th-small th-muted">${esc(t('set_more'))}</div>`
        + `<div class="th-small th-muted">${esc(t('set_version', { v: VERSION }))}</div>`
        + '</div>';
}

function ensureWindow() {
    let win = document.getElementById('th-window');
    if (win) return win;
    win = document.createElement('div');
    win.id = 'th-window';
    win.className = 'th-window';
    win.setAttribute('role', 'dialog');
    win.innerHTML = `<div class="th-head"><button class="th-icon" data-act="back" hidden></button><span class="th-logo">${houndSvg(1, 1.25)}</span><b class="th-title th-ellipsis"></b><span class="th-paneslot"></span><span class="th-spacer"></span><button class="th-icon" data-act="settings"><i class="fa-solid fa-gear"></i></button><button class="th-icon" data-act="close"><i class="fa-solid fa-xmark"></i></button></div><div class="th-body"></div>`;
    document.body.appendChild(win);
    win.addEventListener('click', onWindowClick);
    win.addEventListener('change', onWindowChange);
    win.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && (e.target?.dataset?.expand || e.target?.dataset?.logrow || e.target?.dataset?.sideopen || e.target?.dataset?.act?.startsWith('pane'))) { e.preventDefault(); e.target.click(); }
        if (e.key === 'Escape') {
            if (state.paneMenu) { state.paneMenu = false; render(); win.querySelector('[data-act="pane"]')?.focus(); return; }
            closeWindow();
        }
    });
    return win;
}

function sizeWindow() {
    const win = document.getElementById('th-window');
    if (!win) return;
    if (isMobile()) {
        const h = state.baseHeight || window.innerHeight;
        win.style.setProperty('top', '0px', 'important');
        win.style.setProperty('left', '0px', 'important');
        win.style.setProperty('width', '100%', 'important');
        win.style.setProperty('height', `${h}px`, 'important');
    } else {
        win.style.removeProperty('top');
        win.style.removeProperty('left');
        win.style.removeProperty('width');
        win.style.removeProperty('height');
    }
}

function openWindow() {
    closeCard();
    state.open = true;
    state.view = 'main';
    ensureWindow();
    render();
    sizeWindow();
    pullLog();
}

function closeWindow() {
    state.open = false;
    document.getElementById('th-window')?.remove();
}

function renderWindow() {
    const win = document.getElementById('th-window');
    if (!win || !state.open) return;
    applyTheme();
    const body = win.querySelector('.th-body');
    const back = win.querySelector('[data-act="back"]');
    const title = win.querySelector('.th-title');
    const gear = win.querySelector('[data-act="settings"]');
    const closeBtn = win.querySelector('[data-act="close"]');
    back.hidden = state.view === 'main';
    back.innerHTML = '<i class="fa-solid fa-arrow-left"></i>';
    back.setAttribute('aria-label', t('back'));
    back.title = t('back');
    gear.setAttribute('aria-label', t('settings'));
    gear.title = t('settings');
    closeBtn.setAttribute('aria-label', t('close'));
    closeBtn.title = t('close');
    const rec = shown();
    win.querySelector('.th-logo').innerHTML = houndSvg(stageOf(pctOf(rec)), isMobile() ? 1.25 : 2);
    title.textContent = state.view === 'settings' ? t('settings') : (state.view === 'log' ? t('btn_log') : t('title'));
    win.querySelector('.th-paneslot').innerHTML = state.view === 'main' ? paneHtml() : '';
    const scroll = body.scrollTop;
    const side = state.view === 'main' && state.pane === 'side';
    body.innerHTML = state.view === 'settings' ? renderQuickSettings() : (state.view === 'log' ? renderLog() : (side ? renderSide() : renderMain()));
    body.scrollTop = scroll;
}

async function copySummary() {
    const rec = shown();
    if (!rec) return;
    const lines = [t('summary_head', { total: fmt(rec.total), max: fmt(rec.max), pct: pctOf(rec) })];
    if (rec.model) lines.push([rec.profile, rec.model].filter(Boolean).join(' · '));
    for (const k of PART_ORDER) if (rec.parts[k]) lines.push(`- ${partLabel(rec, k)}: ${fmt(rec.parts[k])}`);
    for (const e of rec.ext || []) lines.push(`  · ${e.label}: ${fmt(e.tok)}`);
    if (rec.usage) lines.push(`${t('sec_usage')}: ${t('usage_input')} ${fmt(rec.usage.input)}${rec.usage.cached !== undefined ? `, ${t('usage_cached')} ${fmt(rec.usage.cached)}` : ''}, ${t('usage_output')} ${fmt(rec.usage.output)}`);
    try {
        await navigator.clipboard.writeText(lines.join('\n'));
        toast('success', t('copied'));
    } catch {
        toast('warning', t('copy_failed'));
    }
}

function onWindowClick(e) {
    const el = e.target.closest('[data-act],[data-expand],[data-logrow],[data-sideopen]');
    if (state.paneMenu && !el?.dataset?.act?.startsWith('pane')) { state.paneMenu = false; render(); }
    if (!el) return;
    if (el.dataset.sideopen !== undefined) {
        const key = el.dataset.sideopen;
        if (state.sideOpen.has(key)) state.sideOpen.delete(key); else state.sideOpen.add(key);
        render();
        return;
    }
    if (el.dataset.logrow) {
        const key = Number(el.dataset.logrow);
        if (state.logOpen.has(key)) state.logOpen.delete(key); else state.logOpen.add(key);
        render();
        return;
    }
    if (el.dataset.expand) {
        const key = el.dataset.expand;
        if (key.includes(':')) {
            if (state.logExpand.has(key)) state.logExpand.delete(key); else state.logExpand.add(key);
        } else {
            state.expand[key] = !state.expand[key];
        }
        render();
        return;
    }
    switch (el.dataset.act) {
        case 'close': closeWindow(); break;
        case 'settings': state.view = state.view === 'settings' ? 'main' : 'settings'; render(); break;
        case 'back': state.view = 'main'; render(); break;
        case 'pane': state.paneMenu = !state.paneMenu; render(); if (state.paneMenu) document.querySelector('#th-window [data-act="pane-' + state.pane + '"]')?.focus(); break;
        case 'pane-chat': case 'pane-side':
            state.pane = el.dataset.act === 'pane-side' ? 'side' : 'chat';
            state.paneMenu = false;
            render();
            document.querySelector('#th-window [data-act="pane"]')?.focus();
            break;
        case 'log': state.view = 'log'; render(); break;
        case 'copy': copySummary(); break;
        case 'export': exportCsv(); break;
        case 'estimate': runEstimate(); break;
        case 'estimate-off': state.estimate = null; render(); break;
    }
}

function onWindowChange(e) {
    const el = e.target;
    switch (el.id) {
        case 'th-q-enabled': settings.enabled = el.checked; break;
        case 'th-q-display': settings.display = el.value; break;
        case 'th-q-bar': settings.barOn = el.checked; break;
        case 'th-q-barhound': settings.barHound = el.checked; break;
        case 'th-q-fabstyle': settings.fabStyle = el.value; break;
        case 'th-q-tap': settings.tapOpens = el.value; break;
        case 'th-q-bartap': settings.barTap = el.value; break;
        case 'th-q-toy': settings.walkToy = el.value; break;
        case 'th-q-housenum': settings.houseNum = el.value; break;
        case 'th-q-mainwalk': settings.mainWalk = el.checked; break;
        case 'th-q-usage': settings.readUsage = el.checked; break;
        case 'th-q-estimate': settings.showEstimate = el.checked; break;
        case 'th-q-theme': settings.theme = el.value; break;
        case 'th-q-lang': settings.lang = el.value; break;
        case 'th-q-exscope': settings.exportScope = el.value; break;
        case 'th-q-exwhat': settings.exportWhat = el.value; break;
        case 'th-q-exnames': settings.exportNames = el.checked; break;
        case 'th-q-exmodels': settings.exportModels = el.checked; break;
        default: return;
    }
    saveSettings();
    syncPanel();
    render();
}

// ---------- mini bar ----------

function renderBar() {
    let bar = document.getElementById('th-bar');
    const anchor = document.getElementById('send_form');
    if (!anchor) return;
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'th-bar';
        bar.className = 'th-bar';
        bar.setAttribute('role', 'button');
        bar.tabIndex = 0;
        bar.addEventListener('click', () => onHoundTap(bar, settings.barTap));
        bar.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); bar.click(); } });
        anchor.parentNode.insertBefore(bar, anchor);
    }
    const rec = shown();
    const pct = pctOf(rec);
    const stage = stageOf(pct);
    bar.title = `${t('open')} · ${t('stage_' + stage)}`;
    bar.setAttribute('aria-label', bar.title);
    bar.innerHTML = `${settings.barHound ? houndSvg(stage, isMobile() ? 1.25 : 2) : ''}<span class="th-bar-track">${barSegments(rec)}</span>`
        + `<span class="th-bar-text">${rec ? `<span class="th-bar-pct${pctClass(stage)}">${pct}%</span> · ${short(rec.total)}${rec.est ? ' ~' : ''}` : '—'}</span>`;
}

// ---------- small button (drag to move, position kept per device) ----------

function readPos(key = POS_KEY) {
    try {
        const p = JSON.parse(localStorage.getItem(key) || 'null');
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
    } catch { /* ignore */ }
    return null;
}

function placeFab(fab, left, top, key = fab.dataset.posKey || POS_KEY) {
    const vw = window.innerWidth;
    const vh = state.baseHeight || window.innerHeight;
    const w = fab.offsetWidth || 64;
    const h = fab.offsetHeight || 36;
    if (left === undefined) {
        const p = readPos(key);
        if (p) {
            left = p.x * vw;
            top = p.y * vh;
        } else {
            const form = document.getElementById('send_form')?.getBoundingClientRect();
            left = vw - w - 12;
            top = (form && form.top > h + 20 ? form.top : vh - 90) - h - 10;
        }
    }
    left = Math.min(Math.max(4, left), Math.max(4, vw - w - 4));
    top = Math.min(Math.max(4, top), Math.max(4, vh - h - 4));
    fab.style.left = `${Math.round(left)}px`;
    fab.style.top = `${Math.round(top)}px`;
}

function bindFabDrag(fab, key = POS_KEY) {
    fab.dataset.posKey = key;
    let drag = null;
    let moved = false;
    const end = () => {
        if (drag && moved) {
            const vh = state.baseHeight || window.innerHeight;
            const pos = { x: (parseFloat(fab.style.left) || 0) / window.innerWidth, y: (parseFloat(fab.style.top) || 0) / vh };
            try { localStorage.setItem(key, JSON.stringify(pos)); } catch { /* ignore */ }
        }
        drag = null;
        fab.classList.remove('th-dragging');
    };
    fab.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, left: parseFloat(fab.style.left) || 0, top: parseFloat(fab.style.top) || 0 };
        moved = false;
        try { fab.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    fab.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const dx = e.clientX - drag.sx;
        const dy = e.clientY - drag.sy;
        if (!moved && Math.hypot(dx, dy) < 6) return;
        if (!moved) closeCard();
        moved = true;
        fab.classList.add('th-dragging');
        placeFab(fab, drag.left + dx, drag.top + dy);
    });
    fab.addEventListener('pointerup', end);
    fab.addEventListener('pointercancel', end);
    fab.addEventListener('lostpointercapture', end);
    window.addEventListener('blur', end);
    window.addEventListener('pagehide', end);
    document.addEventListener('visibilitychange', () => { if (document.hidden) end(); });
    fab.addEventListener('click', (e) => {
        if (moved) { moved = false; e.preventDefault(); return; }
        onHoundTap(fab);
    });
}

function renderFab() {
    let fab = document.getElementById('th-fab');
    if (!fab) {
        fab = document.createElement('div');
        fab.id = 'th-fab';
        fab.className = 'th-fab';
        fab.setAttribute('role', 'button');
        fab.tabIndex = 0;
        fab.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onHoundTap(fab); } });
        document.body.appendChild(fab);
        bindFabDrag(fab);
    }
    const rec = shown();
    const pct = pctOf(rec);
    const stage = stageOf(pct);
    fab.title = `${t('open')} · ${t('stage_' + stage)}`;
    fab.setAttribute('aria-label', fab.title);
    const look = FAB_STYLES.includes(settings.fabStyle) ? settings.fabStyle : DEFAULTS.fabStyle;
    const text = `<span class="th-fab-text${pctClass(stage)}">${rec ? `${pct}%${rec.est ? '~' : ''}` : '—'}</span>`;
    fab.className = `th-fab th-fab-${look}${fab.classList.contains('th-dragging') ? ' th-dragging' : ''}`;
    if (look === 'ring') {
        fab.innerHTML = `${donutSvg(rec, 56, 7)}<span class="th-fab-in">${houndSvg(stage, 1)}${text}</span>`;
    } else if (look === 'line') {
        fab.innerHTML = `<span class="th-fab-row">${houndSvg(stage, 1)}${text}</span><span class="th-fab-track">${barSegments(rec)}</span>`;
    } else {
        fab.innerHTML = `${houndSvg(stage, 1)}${text}`;
    }
    // The look changes the size, so keep it inside the screen.
    if (!fab.style.left) placeFab(fab);
    else if (!fab.classList.contains('th-dragging')) placeFab(fab, parseFloat(fab.style.left) || 0, parseFloat(fab.style.top) || 0);
}

// ---------- quick card (tap the button or the hound) ----------

const card = { anchor: null };

function onHoundTap(anchor, opens = settings.tapOpens) {
    if (state.open) { closeWindow(); return; }
    if (opens === 'window') { closeCard(); openWindow(); return; }
    if (card.anchor === anchor && document.getElementById('th-card')) { closeCard(); return; }
    openCard(anchor);
}

function openCard(anchor) {
    card.anchor = anchor;
    let el = document.getElementById('th-card');
    if (!el) {
        el = document.createElement('div');
        el.id = 'th-card';
        el.className = 'th-card-pop';
        el.setAttribute('role', 'dialog');
        el.addEventListener('click', (e) => {
            if (e.target.closest('[data-act="more"]')) { closeCard(); openWindow(); }
        });
        document.body.appendChild(el);
        document.addEventListener('pointerdown', onCardOutside, true);
        document.addEventListener('keydown', onCardKey, true);
        window.addEventListener('resize', closeCard);
    }
    renderCard();
}

function closeCard() {
    card.anchor = null;
    const el = document.getElementById('th-card');
    if (!el) return;
    el.remove();
    document.removeEventListener('pointerdown', onCardOutside, true);
    document.removeEventListener('keydown', onCardKey, true);
    window.removeEventListener('resize', closeCard);
}

function onCardOutside(e) {
    const el = document.getElementById('th-card');
    if (!el) return;
    if (el.contains(e.target)) return;
    if (card.anchor && card.anchor.contains(e.target)) return; // the tap itself toggles
    closeCard();
}

function onCardKey(e) {
    if (e.key === 'Escape') closeCard();
}

function signed(n) {
    return `${n > 0 ? '+' : '−'}${fmt(Math.abs(n))}`;
}

function shortPart(k) {
    return t('card_part_' + k);
}

function cardHtml() {
    const rec = shown();
    const more = `<div class="th-card-foot"><button class="th-card-more" data-act="more">${esc(t('card_more'))} <i class="fa-solid fa-chevron-right"></i></button></div>`;
    if (!rec) return `<div class="th-muted">${esc(t('card_empty'))}</div>${more}`;
    const prev = rec.est ? state.latest : prevShown(rec);
    const pct = pctOf(rec);
    const stage = stageOf(pct);
    const totalDelta = prev ? rec.total - (prev.total || 0) : 0;
    let html = `<div class="th-card-top"><span class="th-card-pct${pctClass(stage)}">${pct}%${rec.est ? '~' : ''}</span>`
        + `<span class="th-num">${fmt(rec.total)}${prev && totalDelta ? ` <span class="th-card-d">${signed(totalDelta)}</span>` : ''}</span></div>`;
    if (rec.est) html += `<div class="th-small th-muted">${esc(t('estimate_badge'))}</div>`;
    html += `<div class="th-card-stack">${barSegments(rec)}</div>`;

    if (!prev) {
        html += `<div class="th-small th-muted">${esc(t('card_first'))}</div>`;
    } else {
        const changes = PART_ORDER
            .map(k => ({ k, now: rec.parts[k] || 0, d: (rec.parts[k] || 0) - (prev.parts?.[k] || 0) }))
            .filter(x => Math.abs(x.d) >= CARD_MIN_CHANGE)
            .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
            .slice(0, 3);
        if (!changes.length) {
            html += `<div class="th-small th-muted">${esc(t('card_same'))}</div>`;
        } else {
            html += `<div class="th-small th-muted">${esc(t('card_changed'))}</div>`;
            for (const c of changes) {
                let note = '';
                if (c.k === 'wi') {
                    const dn = (rec.wi || []).length - (prev.wi || []).length;
                    if (dn > 0) note = t('card_wi_on', { n: dn });
                    else if (dn < 0) note = t('card_wi_off', { n: -dn });
                }
                html += `<div class="th-card-row"><span class="th-dot" style="background:${COLORS[c.k]}"></span>`
                    + `<span class="th-name th-ellipsis">${esc(shortPart(c.k))}${note ? ` <span class="th-muted">(${esc(note)})</span>` : ''}</span>`
                    + `<span class="th-num">${fmt(c.now)} <span class="th-card-d">${signed(c.d)}</span></span></div>`;
            }
        }
    }

    const ch = rec.cache;
    const usage = !rec.est && rec.usage ? rec.usage : null;
    if ((ch && ch.state !== 'first') || usage) {
        html += '<div class="th-card-line"></div>';
        if (ch && ch.state === 'same') html += `<div class="th-card-row"><span class="th-name th-muted">${esc(t('card_cache'))}</span><span class="th-card-ok">${esc(t('card_cache_kept'))}</span></div>`;
        else if (ch && ch.state === 'changed') html += `<div class="th-card-row"><span class="th-muted">${esc(t('card_cache'))}</span><span class="th-card-warn th-ellipsis">${esc(t('card_cache_broke', { where: ch.where }))}</span></div>`;
        if (usage) html += `<div class="th-card-row"><span class="th-name th-muted">${esc(t('card_usage'))}</span><span class="th-num">${esc(t('card_usage_val', { input: fmt(usage.input), output: fmt(usage.output) }))}</span></div>`;
    }
    return html + more;
}

function placeCard(el, anchor) {
    const vw = window.innerWidth;
    const vh = state.baseHeight || window.innerHeight;
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    // Open toward the middle of the screen, above the hound when there's room.
    let left = r.width > w ? r.left + (r.width - w) / 2 : (r.left + r.width / 2 > vw / 2) ? r.right - w : r.left;
    left = Math.min(Math.max(8, left), Math.max(8, vw - w - 8));
    let top = r.top - h - 8;
    if (top < 8) top = Math.min(r.bottom + 8, vh - h - 8);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(Math.max(8, top))}px`;
}

function renderCard() {
    const el = document.getElementById('th-card');
    if (!el) return;
    const anchor = card.anchor;
    if (!anchor || !anchor.isConnected || !settings.enabled || state.open) { closeCard(); return; }
    el.setAttribute('aria-label', t('title'));
    el.innerHTML = cardHtml();
    applyTheme();
    placeCard(el, anchor);
}

// ---------- wandering hound (walks along the top edge of the input) ----------

const walk = { timer: null, x: 8, dir: 1, tick: 0, pause: 0, key: '', bubbleUntil: 0, lastT: null, roll: 0 };
// Phone: 1.25x. PC: 2x so the hound isn't tiny on a wide screen (2x keeps every dot the same size).
// Donuts grow by the same ratio.
const WALK_PHONE = {
    scale: 1.25,
    nose: { size: 20, w: 3, font: 9 },
    ride: { size: 28, w: 4, font: 11 },
};
const WALK_PC = {
    scale: 2,
    nose: { size: 32, w: 5, font: 13 },
    ride: { size: 38, w: 6, font: 14 },
};

function walkDims() {
    const d = isMobile() ? WALK_PHONE : WALK_PC;
    const sc = d.scale;
    return {
        scale: sc,
        w: 28 * sc,
        h: 16 * sc,
        toys: {
            nose: { ...d.nose, left: 25 * sc, bottom: 0, dogBottom: 0 }, // rolled ahead by the nose
            ride: { ...d.ride, left: 0, bottom: 0, dogBottom: d.ride.size - sc }, // the hound balances on top
        },
    };
}

function walkToy() {
    return settings.display === 'walk' ? walkDims().toys[settings.walkToy] || null : null;
}

function rigSize(toy) {
    const { w, h } = walkDims();
    if (!toy) return { w, h };
    return { w: Math.max(w, toy.left + toy.size), h: Math.max(h + toy.dogBottom, toy.size) };
}

function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

function stopWalker() {
    if (walk.timer) { clearInterval(walk.timer); walk.timer = null; }
    document.getElementById('th-lane')?.remove();
}

function walkStep() {
    const lane = document.getElementById('th-lane');
    const dog = document.getElementById('th-walker');
    if (!lane || !dog || !lane.isConnected || document.hidden) {
        if (walk.timer) { clearInterval(walk.timer); walk.timer = null; }
        return;
    }
    const rec = shown();
    const pct = pctOf(rec);
    const stage = stageOf(pct);
    const still = reducedMotion();
    walk.tick++;
    let frame = 'stand';
    if (stage === 4) {
        frame = 'sleep';
    } else if (!still) {
        // Mood decides the pace: easy trot, stop-and-sniff, slow panting walk.
        const speed = stage === 3 ? 1 : 2;
        if (walk.pause > 0) {
            walk.pause--;
            frame = stage === 2 ? 'sniff' : 'stand';
        } else {
            if (stage === 2 && walk.tick % 45 === 0) walk.pause = 12;
            const max = Math.max(8, lane.clientWidth - rigSize(walkToy()).w - 8);
            walk.x += walk.dir * speed;
            walk.roll += speed;
            if (walk.x >= max) { walk.x = max; walk.dir = -1; }
            if (walk.x <= 8) { walk.x = 8; walk.dir = 1; }
            const step = walk.tick % 4 < 2;
            frame = step ? 'walk' : (stage === 3 ? 'pant' : 'stand');
        }
    }
    const toy = walkToy();
    const showBubble = !toy && Date.now() < walk.bubbleUntil;
    const label = rec ? `${pct}${rec.est ? '~' : ''}` : '—';
    const dims = walkDims();
    const key = `${frame}:${walk.dir}:${showBubble}:${label}:${settings.walkToy}:${dims.scale}:${rec ? `${rec.t}:${rec.total}:${rec.reply}` : ''}`;
    dog.style.left = `${Math.round(walk.x)}px`;
    if (key !== walk.key) {
        walk.key = key;
        const sprite = frame === 'walk' ? houndSvg(1, dims.scale, true)
            : houndSvg(frame === 'sleep' ? 4 : frame === 'pant' ? 3 : frame === 'sniff' ? 2 : 1, dims.scale);
        dog.classList.toggle('th-flip', walk.dir < 0);
        const num = `<span class="th-ring-num${pctClass(stage)}"${toy ? ` style="font-size:${toy.font}px"` : ''}>${label}</span>`;
        if (toy) {
            const { w, h } = rigSize(toy);
            dog.innerHTML = `<span class="th-rig" style="width:${w}px;height:${h}px">`
                + `<span class="th-walk-dog" style="bottom:${toy.dogBottom}px">${sprite}</span>`
                + `<span class="th-toy th-toy-${settings.walkToy}" style="left:${toy.left}px;bottom:${toy.bottom}px;width:${toy.size}px;height:${toy.size}px">`
                + `<span class="th-toy-spin">${donutSvg(rec, toy.size, toy.w, true)}</span>${num}</span></span>`;
        } else {
            dog.innerHTML = `<span class="th-rig" style="width:${dims.w}px;height:${dims.h}px"><span class="th-walk-dog">${sprite}</span></span>`
                + `<span class="th-walk-bubble${showBubble ? ' th-show' : ''}">${donutSvg(rec)}${num}</span>`;
        }
    }
    // The donut turns as far as the hound has walked (mirrored when walking back).
    const spin = toy && dog.querySelector('.th-toy-spin');
    if (spin) spin.style.transform = `rotate(${Math.round((walk.roll / (toy.size / 2)) * 180 / Math.PI)}deg)`;
}

function renderWalker() {
    const anchor = document.getElementById('send_form');
    if (!anchor) return;
    let lane = document.getElementById('th-lane');
    if (!lane || !lane.isConnected) {
        lane?.remove();
        lane = document.createElement('div');
        lane.id = 'th-lane';
        lane.className = 'th-lane';
        const dog = document.createElement('div');
        dog.id = 'th-walker';
        dog.className = 'th-walker';
        dog.setAttribute('role', 'button');
        dog.tabIndex = 0;
        dog.addEventListener('click', () => onHoundTap(dog));
        dog.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dog.click(); } });
        lane.appendChild(dog);
        // With the bar on too, the hound walks on top of the bar.
        const below = document.getElementById('th-bar');
        const ref = below && below.parentNode === anchor.parentNode ? below : anchor;
        anchor.parentNode.insertBefore(lane, ref);
        walk.key = '';
    }
    const rec = shown();
    const dog = document.getElementById('th-walker');
    const stage = stageOf(pctOf(rec));
    dog.title = `${t('open')} · ${t('stage_' + stage)}`;
    dog.setAttribute('aria-label', dog.title);
    // Pop the number up for a moment once a new turn's reply is in (not while it's still coming).
    if (rec && !rec.awaitingReply) {
        const recT = `${rec.t}:${rec.est ? 1 : 0}`;
        if (recT !== walk.lastT) walk.bubbleUntil = Date.now() + 4000;
        walk.lastT = recT;
    }
    walk.key = '';
    walkStep();
    if (!walk.timer && !document.hidden) walk.timer = setInterval(walkStep, 140);
}

// ---------- resting hound (a doghouse that stays put; drag to move) ----------

// Phone: 1.5x. PC: 2x (bigger screen, every dot the same size). The donut pillow grows with it.
function houseDims() {
    return isMobile() ? { scale: 1.5, donut: 26, ring: 4, pc: false } : { scale: 2, donut: 35, ring: 5, pc: true };
}
const house = { timer: null, frame: 'peek', since: 0, bubbleUntil: 0, lastT: null, key: '' };
// Peeks out, lies down, then dozes off. A finished reply wakes it up again.
const HOUSE_STEPS = [['peek', 6000], ['rest', 25000], ['sleep', 0]];

function stopHouse() {
    if (house.timer) { clearTimeout(house.timer); house.timer = null; }
    document.getElementById('th-house-lane')?.remove();
    house.key = '';
}

function houseFrame() {
    if (reducedMotion()) return 'rest';
    let left = Date.now() - house.since;
    for (const [frame, ms] of HOUSE_STEPS) {
        if (!ms || left < ms) return frame;
        left -= ms;
    }
    return 'sleep';
}

function scheduleHouse() {
    if (house.timer) clearTimeout(house.timer);
    house.timer = null;
    if (reducedMotion()) return;
    const now = Date.now();
    let at = house.since;
    let next = null;
    for (const [, ms] of HOUSE_STEPS) {
        if (!ms) break;
        at += ms;
        if (at > now) { next = at; break; }
    }
    if (house.bubbleUntil > now) next = next ? Math.min(next, house.bubbleUntil) : house.bubbleUntil;
    if (next) house.timer = setTimeout(() => { house.timer = null; drawHouse(); scheduleHouse(); }, next - now + 30);
}

function drawHouse() {
    const el = document.getElementById('th-house');
    if (!el) return;
    const rec = shown();
    const pct = pctOf(rec);
    const stage = stageOf(pct);
    const frame = houseFrame();
    const donut = settings.houseNum === 'donut';
    const bubble = !donut && Date.now() < house.bubbleUntil;
    const label = rec ? `${pct}${rec.est ? '~' : ''}` : '—';
    const dims = houseDims();
    const key = `${frame}:${donut}:${bubble}:${dims.scale}:${label}:${stage}:${rec ? `${rec.t}:${rec.total}:${rec.reply}` : ''}`;
    if (key === house.key) return;
    house.key = key;
    el.title = `${t('open')} · ${t('stage_' + stage)}`;
    el.setAttribute('aria-label', el.title);
    const num = `<span class="th-ring-num${pctClass(stage)}">${label}</span>`;
    let html = `<span class="th-house-art">${houseSvg(frame, dims.scale)}`;
    if (!donut) html += `<span class="th-house-sign${pctClass(stage)}">${rec ? `${pct}%${rec.est ? '~' : ''}` : '—'}</span>`;
    html += '</span>';
    if (donut) html += `<span class="th-house-donut" style="width:${dims.donut}px;height:${dims.donut}px">${donutSvg(rec, dims.donut, dims.ring, true)}${num}</span>`;
    else html += `<span class="th-walk-bubble th-house-bubble${bubble ? ' th-show' : ''}">${donutSvg(rec)}${num}</span>`;
    el.className = `th-house${dims.pc ? ' th-house-pc' : ''}${donut ? ' th-house-withdonut' : ''}${el.classList.contains('th-dragging') ? ' th-dragging' : ''}`;
    el.innerHTML = html;
}

// The doghouse sits on the same line as the wandering hound (the top edge of the
// input, or on the bar). Drag it left or right; the spot is kept per device.
function houseX(lane, el) {
    const max = Math.max(4, lane.clientWidth - (el.offsetWidth || 50) - 4);
    let ratio = null;
    try {
        const p = JSON.parse(localStorage.getItem(HOUSE_POS_KEY) || 'null');
        if (p && Number.isFinite(p.x)) ratio = p.x;
    } catch { /* ignore */ }
    // Same formula as the one used when the house is dropped (see bindHouseDrag).
    return ratio === null ? 4 : Math.min(max, Math.max(4, 4 + ratio * (max - 4)));
}

function bindHouseDrag(el) {
    let drag = null;
    let moved = false;
    const lane = () => el.parentNode;
    const end = () => {
        if (drag && moved && lane()) {
            const max = Math.max(4, lane().clientWidth - el.offsetWidth - 4);
            const x = parseFloat(el.style.left) || 4;
            try { localStorage.setItem(HOUSE_POS_KEY, JSON.stringify({ x: max > 4 ? (x - 4) / (max - 4) : 0 })); } catch { /* ignore */ }
        }
        drag = null;
        el.classList.remove('th-dragging');
    };
    el.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, left: parseFloat(el.style.left) || 4 };
        moved = false;
        try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    el.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id || !lane()) return;
        const dx = e.clientX - drag.sx;
        if (!moved && Math.hypot(dx, e.clientY - drag.sy) < 6) return;
        if (!moved) closeCard();
        moved = true;
        el.classList.add('th-dragging');
        const max = Math.max(4, lane().clientWidth - el.offsetWidth - 4);
        el.style.left = `${Math.round(Math.min(max, Math.max(4, drag.left + dx)))}px`;
    });
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
    window.addEventListener('blur', end);
    window.addEventListener('pagehide', end);
    document.addEventListener('visibilitychange', () => { if (document.hidden) end(); });
    el.addEventListener('click', (e) => {
        if (moved) { moved = false; e.preventDefault(); return; }
        onHoundTap(el);
    });
}

function renderHouse() {
    const anchor = document.getElementById('send_form');
    if (!anchor) return;
    let lane = document.getElementById('th-house-lane');
    let el = document.getElementById('th-house');
    // With the bar on, the house sits on top of the bar.
    const below = document.getElementById('th-bar');
    const ref = below && below.parentNode === anchor.parentNode ? below : anchor;
    if (!lane || !lane.isConnected || !el) {
        lane?.remove();
        lane = document.createElement('div');
        lane.id = 'th-house-lane';
        lane.className = 'th-lane';
        el = document.createElement('div');
        el.id = 'th-house';
        el.className = 'th-house';
        el.setAttribute('role', 'button');
        el.tabIndex = 0;
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onHoundTap(el); } });
        lane.appendChild(el);
        bindHouseDrag(el);
        house.since = Date.now();
        house.key = '';
    }
    if (lane.nextSibling !== ref) anchor.parentNode.insertBefore(lane, ref);
    // A finished reply wakes the hound: it peeks out and shows the number for a moment.
    const rec = shown();
    if (rec && !rec.awaitingReply) {
        const recT = `${rec.t}:${rec.est ? 1 : 0}`;
        if (house.lastT !== null && recT !== house.lastT) {
            house.since = Date.now();
            house.bubbleUntil = Date.now() + 4000;
        }
        house.lastT = recT;
    }
    drawHouse();
    if (!el.classList.contains('th-dragging')) el.style.left = `${Math.round(houseX(lane, el))}px`;
    scheduleHouse();
}

function onMainScreen() {
    try { return !ctx().getCurrentChatId?.(); } catch { return false; }
}

function renderDisplay() {
    // "Walk around the main screen too" off: outside a chat the hound stays out of sight.
    const away = !settings.mainWalk && onMainScreen();
    const mode = settings.enabled && !away ? settings.display : 'menu';
    const barOn = settings.enabled && settings.barOn && !away;
    if (!barOn) document.getElementById('th-bar')?.remove();
    if (mode !== 'button') document.getElementById('th-fab')?.remove();
    if (mode !== 'walk') stopWalker();
    if (mode !== 'house') stopHouse();
    if (barOn) renderBar();
    if (mode === 'button') renderFab();
    else if (mode === 'walk') renderWalker();
    else if (mode === 'house') renderHouse();
}

function applyTheme() {
    for (const id of ['th-window', 'th-card']) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.classList.toggle('th-light', settings.theme === 'light');
        el.classList.toggle('th-dark', settings.theme === 'dark');
    }
}

function render() {
    try { renderDisplay(); } catch (e) { console.warn('[Tokenhound] display', e); }
    try { renderWindow(); } catch (e) { console.warn('[Tokenhound] window', e); }
    try { renderCard(); } catch (e) { console.warn('[Tokenhound] card', e); }
}

// ---------- SillyTavern extension settings panel ----------

function panelHtml() {
    const chk = (id, label) => `<label class="checkbox_label" for="${id}"><input type="checkbox" id="${id}"><span>${esc(label)}</span></label>`;
    return `<div id="th-panel" class="th-panel"><div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b class="th-panel-name">${houndImg(1)}Tokenhound</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content">
${chk('th-p-enabled', t('set_enabled'))}
<label for="th-p-display">${esc(t('set_display'))}</label>
<select id="th-p-display" class="text_pole">${displayOptions().map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>
<label for="th-p-toy">${esc(t('set_walk_toy'))}</label>
<select id="th-p-toy" class="text_pole">${toyOptions().map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>
<label for="th-p-housenum">${esc(t('set_house_num'))}</label>
<select id="th-p-housenum" class="text_pole">${houseNumOptions().map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>
<label for="th-p-fabstyle">${esc(t('set_fab_style'))}</label>
<select id="th-p-fabstyle" class="text_pole">${fabStyleOptions().map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>
<label for="th-p-tap">${esc(t('set_tap'))}</label>
<select id="th-p-tap" class="text_pole">${tapOptions().map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>
${chk('th-p-mainwalk', t('set_main_walk'))}
${chk('th-p-bar', t('set_bar'))}
${chk('th-p-barhound', t('set_bar_hound'))}
<label for="th-p-bartap">${esc(t('set_bar_tap'))}</label>
<select id="th-p-bartap" class="text_pole">${tapOptions().map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>
<small class="th-p-hint">${esc(t('set_display_hint'))}</small>
<div class="th-p-row"><div id="th-p-resetpos" class="menu_button">${esc(t('set_reset_pos'))}</div></div>
${chk('th-p-usage', t('set_usage'))}
<small class="th-p-hint">${esc(t('set_usage_hint'))}</small>
${chk('th-p-estimate', t('set_estimate'))}
<label for="th-p-theme">${esc(t('set_theme'))}</label>
<select id="th-p-theme" class="text_pole">${themeOptions().map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>
<label for="th-p-lang">${esc(t('set_lang'))}</label>
<select id="th-p-lang" class="text_pole">${langOptions().map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>
<label for="th-p-logsize">${esc(t('set_log_size'))}</label>
<select id="th-p-logsize" class="text_pole"><option value="20">20</option><option value="50">50</option><option value="100">100</option></select>
<label>${esc(t('set_stage'))}</label>
<div class="th-p-stages"><input id="th-p-s1" class="text_pole" type="number" min="1" max="100" inputmode="numeric"><input id="th-p-s2" class="text_pole" type="number" min="1" max="100" inputmode="numeric"><input id="th-p-s3" class="text_pole" type="number" min="1" max="100" inputmode="numeric"></div>
<small class="th-p-hint">${esc(t('set_stage_hint'))}</small>
<label>${esc(t('exp_title'))}</label>
<div class="th-p-stages"><select id="th-p-exscope" class="text_pole" title="${esc(t('exp_scope'))}" aria-label="${esc(t('exp_scope'))}">${exportScopeOptions().map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select><select id="th-p-exwhat" class="text_pole" title="${esc(t('exp_what'))}" aria-label="${esc(t('exp_what'))}">${exportWhatOptions().map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></div>
${chk('th-p-exnames', t('exp_names'))}
${chk('th-p-exmodels', t('exp_models'))}
<div class="th-p-row"><div id="th-p-export" class="menu_button">${esc(t('exp_btn'))}</div></div>
<small class="th-p-hint">${esc(t('exp_hint'))}</small>
<div class="th-p-row"><div id="th-p-clear" class="menu_button">${esc(t('set_clear_chat'))}</div><div id="th-p-clearall" class="menu_button">${esc(t('set_clear_all'))}</div></div>
${chk('th-p-sync', t('set_sync'))}
<small class="th-p-hint">${esc(t('set_sync_hint'))}</small>
<small class="th-p-hint"><span id="th-p-storage"></span> · ${esc(t('set_version', { v: VERSION }))}</small>
</div></div></div>`;
}

function syncPanel() {
    const $ = (id) => document.getElementById(id);
    if (!$('th-p-enabled')) return;
    $('th-p-enabled').checked = settings.enabled;
    $('th-p-display').value = settings.display;
    $('th-p-bar').checked = settings.barOn;
    $('th-p-barhound').checked = settings.barHound;
    $('th-p-fabstyle').value = settings.fabStyle;
    $('th-p-tap').value = settings.tapOpens;
    $('th-p-bartap').value = settings.barTap;
    $('th-p-toy').value = settings.walkToy;
    $('th-p-housenum').value = settings.houseNum;
    $('th-p-mainwalk').checked = settings.mainWalk;
    $('th-p-sync').checked = settings.serverSync;
    $('th-p-storage').textContent = settings.serverSync ? t('set_storage_server') : t('set_storage_note');
    $('th-p-usage').checked = settings.readUsage;
    $('th-p-estimate').checked = settings.showEstimate;
    $('th-p-theme').value = settings.theme;
    $('th-p-lang').value = settings.lang;
    $('th-p-logsize').value = String(settings.logSize);
    $('th-p-exscope').value = settings.exportScope;
    $('th-p-exwhat').value = settings.exportWhat;
    $('th-p-exnames').checked = settings.exportNames;
    $('th-p-exmodels').checked = settings.exportModels;
    $('th-p-s1').value = settings.stages[0];
    $('th-p-s2').value = settings.stages[1];
    $('th-p-s3').value = settings.stages[2];
}

function buildPanel() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;
    document.getElementById('th-panel')?.remove();
    const wrap = document.createElement('div');
    wrap.innerHTML = panelHtml();
    host.appendChild(wrap.firstElementChild);
    syncPanel();
    const panel = document.getElementById('th-panel');
    panel.addEventListener('change', (e) => {
        const el = e.target;
        switch (el.id) {
            case 'th-p-enabled': settings.enabled = el.checked; break;
            case 'th-p-display': settings.display = el.value; break;
            case 'th-p-bar': settings.barOn = el.checked; break;
            case 'th-p-barhound': settings.barHound = el.checked; break;
            case 'th-p-fabstyle': settings.fabStyle = el.value; break;
            case 'th-p-tap': settings.tapOpens = el.value; closeCard(); break;
            case 'th-p-bartap': settings.barTap = el.value; closeCard(); break;
            case 'th-p-toy': settings.walkToy = el.value; break;
            case 'th-p-housenum': settings.houseNum = el.value; break;
            case 'th-p-mainwalk': settings.mainWalk = el.checked; break;
            case 'th-p-sync':
                settings.serverSync = el.checked;
                syncPanel();
                if (el.checked) { syncWarned = false; pullLog(true).then(() => schedulePush()); }
                break;
            case 'th-p-usage': settings.readUsage = el.checked; break;
            case 'th-p-estimate': settings.showEstimate = el.checked; break;
            case 'th-p-theme': settings.theme = el.value; break;
            case 'th-p-lang': settings.lang = el.value; saveSettings(); buildPanel(); rebuildMenu(); render(); return;
            case 'th-p-logsize': settings.logSize = Number(el.value) || 50; saveLog(); break;
            case 'th-p-exscope': settings.exportScope = el.value; break;
            case 'th-p-exwhat': settings.exportWhat = el.value; break;
            case 'th-p-exnames': settings.exportNames = el.checked; break;
            case 'th-p-exmodels': settings.exportModels = el.checked; break;
            case 'th-p-s1': case 'th-p-s2': case 'th-p-s3': {
                const vals = ['th-p-s1', 'th-p-s2', 'th-p-s3'].map(id => Math.min(100, Math.max(1, Number(document.getElementById(id).value) || 0)));
                vals.sort((a, b) => a - b);
                settings.stages = vals;
                syncPanel();
                break;
            }
            default: return;
        }
        saveSettings();
        render();
    });
    panel.addEventListener('click', async (e) => {
        const id = e.target?.closest?.('.menu_button')?.id;
        if (id === 'th-p-resetpos') {
            try { localStorage.removeItem(POS_KEY); localStorage.removeItem(HOUSE_POS_KEY); } catch { /* ignore */ }
            const fab = document.getElementById('th-fab');
            if (fab) placeFab(fab);
            const home = document.getElementById('th-house');
            if (home) home.style.left = '4px';
            toast('success', t('pos_reset'));
            return;
        }
        if (id === 'th-p-export') { exportCsv(); return; }
        if (id !== 'th-p-clear' && id !== 'th-p-clearall') return;
        const c = ctx();
        const msg = id === 'th-p-clear' ? t('confirm_clear_chat') : t('confirm_clear_all');
        let ok = false;
        try {
            ok = c.callGenericPopup ? await c.callGenericPopup(msg, c.POPUP_TYPE?.CONFIRM ?? 2) : window.confirm(msg);
        } catch { ok = false; }
        if (!ok) return;
        if (id === 'th-p-clear') clearChatLog(); else clearAllLogs();
        toast('success', t('cleared'));
        render();
    });
}

// The wand menu draws the hound as a plain image: iPhone Safari sometimes skips
// painting an inline SVG with a filter inside the blurred, see-through menu.
// Drawn at 1x with the empty edge cut off (23 x 14): shrinking the dots below 1px broke the picture on PC.
function houndImg(stage) {
    const w = 23;
    const h = 14;
    const svg = houndSvg(stage, 1)
        .replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')
        .replace('viewBox="0 0 28 16" width="28" height="16"', `viewBox="2 1 ${w} ${h}" width="${w}" height="${h}"`);
    return `<img class="th-menu-img" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}" width="${w}" height="${h}" alt="" draggable="false">`;
}

function rebuildMenu() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    document.getElementById('th-menu')?.remove();
    const item = document.createElement('div');
    item.id = 'th-menu';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = `<div class="th-menu-icon extensionsMenuExtensionButton">${houndImg(1)}</div><span>${esc(t('title'))}</span>`;
    item.addEventListener('click', () => openWindow());
    menu.appendChild(item);
}

// ---------- start ----------

function onResize() {
    const active = document.activeElement;
    const typing = active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);
    if (!typing) state.baseHeight = window.innerHeight;
    if (state.open) sizeWindow();
    const fab = document.getElementById('th-fab');
    if (fab && !fab.classList.contains('th-dragging')) placeFab(fab);
    const home = document.getElementById('th-house');
    if (home && home.parentNode && !home.classList.contains('th-dragging')) home.style.left = `${Math.round(houseX(home.parentNode, home))}px`;
}

// iPhone Safari can keep using an old copy of style.css after an update while
// the script is already new. Load our own stylesheet again with the version in
// the address, so every update brings its styles along.
function refreshStyle() {
    try {
        const url = new URL('./style.css', import.meta.url);
        const want = `${url.origin}${url.pathname}?v=${VERSION}`;
        const old = [...document.querySelectorAll('link[rel="stylesheet"]')].filter((l) => {
            try { return new URL(l.href, location.href).pathname === url.pathname; } catch { return false; }
        });
        if (old.some(l => l.href === want)) return;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = want;
        link.id = 'th-style';
        link.addEventListener('load', () => { for (const l of old) l.disabled = true; });
        if (old.length) old[old.length - 1].after(link);
        else document.head.appendChild(link);
    } catch { /* keep whatever SillyTavern loaded */ }
}

async function init() {
    try {
        refreshStyle();
        loadSettings();
        bindEvents();
        installFetchWatch();
        loadStExtensions();
        buildPanel();
        rebuildMenu();
        window.addEventListener('resize', onResize);
        document.addEventListener('visibilitychange', () => { if (!document.hidden && (settings.display === 'walk' || settings.display === 'house')) render(); });
        state.chatId = ctx().getCurrentChatId?.() || null;
        state.log = loadLog(state.chatId);
        state.side = loadSide(state.chatId);
        state.latest = lastShown();
        render();
        pullLog(true);
    } catch (e) {
        console.error('[Tokenhound] failed to start', e);
    }
}

// Expose a tiny hook for the test page only.
export const __test = { state, analyze, cacheDiff, normUsage, pickUsage, mergeUsage, stageOf: (p) => stageOf(p) };

if (typeof jQuery === 'function') {
    jQuery(() => { init(); });
} else {
    init();
}
