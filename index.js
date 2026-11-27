// Tokenhound — sniffs out where your prompt tokens go.
// Read-only: it never adds anything to the prompt and never edits chats or cards.

import { STRINGS } from './i18n.js';
import { houndSvg } from './sprites.js';

const MODULE = 'tokenhound';
const VERSION = '0.2.0';
const LOG_PREFIX = 'tokenhound:log:';
const LOG_INDEX = 'tokenhound:index';
const LOG_FORMAT = 1;
const MAX_CHATS = 100;
const POS_KEY = 'tokenhound:btnpos';
const DISPLAYS = ['button', 'bar', 'walk', 'menu'];
const SERVER_PREFIX = 'tokenhound-';
const SERVER_INDEX = 'tokenhound-index.json';
const SERVER_FORMAT = 1;

const DEFAULTS = Object.freeze({
    enabled: true,
    display: 'button',
    lang: 'auto',
    readUsage: true,
    serverSync: true,
    showEstimate: true,
    logSize: 50,
    stages: [50, 85, 95],
});

const COLORS = {
    preset: '#7F77DD',
    card: '#D4537E',
    persona: '#1D9E75',
    examples: '#5DCAA5',
    wi: '#EF9F27',
    ext: '#378ADD',
    history: '#888780',
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
    latest: null,       // last real turn
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
    if (!DISPLAYS.includes(s.display)) s.display = DEFAULTS.display;
    delete s.showBar; // 0.1.0 setting, replaced by "display"
    settings = s;
}

function saveSettings() {
    try { ctx().saveSettingsDebounced(); } catch { /* ignore */ }
}

// ---------- turn log storage (this device only) ----------

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
    for (const r of local || []) if (r && Number.isFinite(r.t)) byT.set(r.t, r);
    return [...byT.values()].filter(r => r.t > cutoff).sort((x, y) => x.t - y.t).slice(-settings.logSize);
}

const sameTurns = (x, y) => x.length === y.length && x.every((r, i) => r.t === y[i].t);

function adoptMerged(chatId, merged) {
    if (state.chatId !== chatId) return;
    const before = state.log;
    state.log = merged;
    const last = merged[merged.length - 1] || null;
    if (!state.latest || !last || last.t !== state.latest.t) state.latest = last;
    try { localStorage.setItem(LOG_PREFIX + chatId, JSON.stringify({ v: LOG_FORMAT, turns: merged })); } catch { /* ignore */ }
    if (!sameTurns(before, merged)) render();
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
        adoptMerged(chatId, merged);
        if (!sameTurns(merged, mergeTurns([], remote, cutoff))) schedulePush();
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
        await serverWrite(name, { v: SERVER_FORMAT, clearedAt: fileCut, turns: merged });
        adoptMerged(chatId, merged);
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
        await serverWrite(name, { v: SERVER_FORMAT, clearedAt: Date.now(), turns: [] });
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
    }
    state.log = [];
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
            if (k && (k.startsWith(LOG_PREFIX) || k === LOG_INDEX)) keys.push(k);
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

function extLabel(key) {
    if (KNOWN_EXT[key]) return t(KNOWN_EXT[key]);
    if (key.startsWith('DEPTH_PROMPT')) return t('ext_char_note');
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
    for (let i = 0; i < chat.length; i++) if (chat[i] && !chat[i].is_system && String(chat[i].mes ?? '').trim()) visible.push(i);
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
        hist: { inc, all: visible.length },
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
        const prevRec = state.log[state.log.length - 1] || null;
        rec.cache = rec.est ? null : cacheDiff(rec, prevTexts, prevRec);
        if (rec.est) {
            state.estimate = stripPrivate(rec);
        } else {
            state.prevPrompt.set(cur.chatId, rec._texts);
            const clean = stripPrivate(rec);
            state.log.push(clean);
            state.latest = clean;
            state.estimate = null;
            const up = cur.usagePending;
            if (up) { up.rec = clean; if (up.onRec) { up.onRec(clean); up.onRec = null; } }
            if (cur.pendingReply) { await attachReply(clean, cur.pendingReply); }
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

function installFetchWatch() {
    if (window.__tokenhoundFetchWatch) return;
    const original = window.fetch;
    if (typeof original !== 'function') return;
    const watched = function (input, init) {
        const p = original.apply(this, arguments);
        try {
            const pending = state.pendingUsage;
            if (pending && settings?.enabled && settings?.readUsage) {
                const url = typeof input === 'string' ? input : (input?.url || '');
                if (/\/api\/backends\/(chat|text)-completions\/generate/.test(url)) {
                    state.pendingUsage = null;
                    p.then(res => { try { readUsage(res.clone(), pending); } catch { /* ignore */ } }).catch(() => { /* ignore */ });
                }
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
    const rec = state.latest;
    if (rec && rec.awaitingReply && Date.now() - rec.t < 30 * 60 * 1000) {
        attachReply(rec, messageId).then(() => { saveLog(); render(); });
    } else if (state.current && state.current.done && !state.current.est) {
        state.current.pendingReply = messageId; // analysis still running
    }
}

function onGenerationDone() {
    state.generating = false;
    const rec = state.latest;
    if (rec && rec.awaitingReply) { rec.awaitingReply = false; saveLog(); render(); }
    // If the API never reported usage, stop showing "waiting".
    setTimeout(() => {
        const r = state.latest;
        if (r && r.usageState === 'waiting') { r.usageState = 'none'; saveLog(); render(); }
    }, 4000);
}

function onChatChanged() {
    state.chatId = ctx().getCurrentChatId?.() || null;
    state.log = loadLog(state.chatId);
    state.latest = state.log[state.log.length - 1] || null;
    state.estimate = null;
    state.current = null;
    state.pendingUsage = null;
    state.lastWi = [];
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
    on('SETTINGS_UPDATED', () => { renderBar(); });
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

function pctOf(rec) {
    return rec && rec.max ? Math.round((rec.total / rec.max) * 100) : 0;
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

function renderMain() {
    const rec = shown();
    if (!rec) {
        return `<div class="th-empty">${houndSvg(1, 3)}<div class="th-empty-title">${esc(t('empty_title'))}</div><div class="th-muted">${esc(t('empty_body'))}</div></div>${renderButtons()}`;
    }
    const prev = rec.est ? state.latest : state.log[state.log.length - 2];
    const pct = pctOf(rec);
    const stage = stageOf(pct);
    const free = Math.max(0, rec.max - rec.total - rec.reply);
    const meta = [rec.profile, rec.model || t('no_model')].filter(Boolean).join(' · ');
    let html = '';
    html += `<div class="th-meta th-ellipsis" title="${esc(meta)}">${esc(meta)}</div>`;
    if (rec.est) html += `<div class="th-badge">${esc(t('estimate_badge'))}</div>`;
    html += `<div class="th-total"><span class="th-big">${fmt(rec.total)}</span><span class="th-muted th-ellipsis">${esc(t('of_context', { max: fmt(rec.max), pct }))}</span></div>`;
    html += `<div class="th-stack">${barSegments(rec)}</div>`;
    html += `<div class="th-small th-muted">${esc(t('reply_free', { reply: fmt(rec.reply), free: fmt(free) }))}</div>`;
    if (stage >= 3) html += `<div class="th-warn th-stage${stage}">${esc(t('warn_high'))}</div>`;

    html += '<div class="th-rows">';
    for (const k of PART_ORDER) {
        const v = rec.parts[k] || 0;
        if (!v && (k === 'examples' || k === 'persona')) continue;
        const pp = rec.total ? Math.round((v / rec.total) * 100) : 0;
        const expandable = k === 'wi' || k === 'ext';
        const open = expandable && state.expand[k];
        html += `<div class="th-row${expandable ? ' th-click' : ''}" ${expandable ? `data-expand="${k}" role="button" tabindex="0"` : ''}>`
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
            html += `<div class="th-sub ${cut ? 'th-warntext' : 'th-muted'}">${esc(cut ? t('history_cut', { n: cut }) : t('history_all'))}</div>`;
        }
    }
    html += '</div>';

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
    const turns = state.log.slice(-20);
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
    const est = settings.showEstimate
        ? `<button class="th-btn" data-act="estimate" ${state.estimateRunning ? 'aria-busy="true"' : ''}>${esc(state.estimateRunning ? t('estimating') : t('btn_estimate'))}</button>`
        : '';
    return `<div class="th-btns"><button class="th-btn" data-act="log">${esc(t('btn_log'))}</button>${est}<button class="th-btn" data-act="copy">${esc(t('btn_copy'))}</button></div>`;
}

function renderLog() {
    if (!state.log.length) return `<div class="th-muted th-pad">${esc(t('log_empty'))}</div>`;
    return '<div class="th-log">' + state.log.slice().reverse().map(r => {
        const pct = pctOf(r);
        const time = new Date(r.t).toLocaleString(lang() === 'ko' ? 'ko-KR' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        return `<div class="th-logrow">${houndSvg(stageOf(pct), 1)}<div class="th-logmain"><div class="th-ellipsis">${esc(t('log_item', { total: fmt(r.total), pct }))}</div><div class="th-small th-muted th-ellipsis">${esc(time)} · ${esc(r.model || t('no_model'))}</div></div>`
            + `<div class="th-mini">${barSegments(r)}</div></div>`;
    }).join('') + '</div>';
}

function selectHtml(id, value, options) {
    return `<select id="${id}" class="th-select">${options.map(([v, label]) => `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
}

function displayOptions() {
    return DISPLAYS.map(d => [d, t('disp_' + d)]);
}

function langOptions() {
    return [['auto', t('lang_auto')], ['en', 'English'], ['ko', '한국어']];
}

function renderQuickSettings() {
    const check = (id, val, label) => `<label class="th-check"><input type="checkbox" id="${id}"${val ? ' checked' : ''}><span>${esc(label)}</span></label>`;
    return '<div class="th-settings">'
        + check('th-q-enabled', settings.enabled, t('set_enabled'))
        + `<label class="th-field"><span>${esc(t('set_display'))}</span>${selectHtml('th-q-display', settings.display, displayOptions())}</label>`
        + check('th-q-usage', settings.readUsage, t('set_usage'))
        + `<div class="th-small th-muted th-hint">${esc(t('set_usage_hint'))}</div>`
        + check('th-q-estimate', settings.showEstimate, t('set_estimate'))
        + `<label class="th-field"><span>${esc(t('set_lang'))}</span>${selectHtml('th-q-lang', settings.lang, langOptions())}</label>`
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
    win.innerHTML = `<div class="th-head"><button class="th-icon" data-act="back" hidden></button><span class="th-logo">${houndSvg(1, 1.25)}</span><b class="th-title th-ellipsis"></b><button class="th-icon" data-act="settings"><i class="fa-solid fa-gear"></i></button><button class="th-icon" data-act="close"><i class="fa-solid fa-xmark"></i></button></div><div class="th-body"></div>`;
    document.body.appendChild(win);
    win.addEventListener('click', onWindowClick);
    win.addEventListener('change', onWindowChange);
    win.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target?.dataset?.expand) { e.preventDefault(); e.target.click(); }
        if (e.key === 'Escape') closeWindow();
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
    win.querySelector('.th-logo').innerHTML = houndSvg(stageOf(pctOf(rec)), 1.25);
    title.textContent = state.view === 'settings' ? t('settings') : (state.view === 'log' ? t('btn_log') : t('title'));
    const scroll = body.scrollTop;
    body.innerHTML = state.view === 'settings' ? renderQuickSettings() : (state.view === 'log' ? renderLog() : renderMain());
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
    const el = e.target.closest('[data-act],[data-expand]');
    if (!el) return;
    if (el.dataset.expand) {
        state.expand[el.dataset.expand] = !state.expand[el.dataset.expand];
        render();
        return;
    }
    switch (el.dataset.act) {
        case 'close': closeWindow(); break;
        case 'settings': state.view = state.view === 'settings' ? 'main' : 'settings'; render(); break;
        case 'back': state.view = 'main'; render(); break;
        case 'log': state.view = 'log'; render(); break;
        case 'copy': copySummary(); break;
        case 'estimate': runEstimate(); break;
    }
}

function onWindowChange(e) {
    const el = e.target;
    switch (el.id) {
        case 'th-q-enabled': settings.enabled = el.checked; break;
        case 'th-q-display': settings.display = el.value; break;
        case 'th-q-usage': settings.readUsage = el.checked; break;
        case 'th-q-estimate': settings.showEstimate = el.checked; break;
        case 'th-q-lang': settings.lang = el.value; break;
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
        bar.addEventListener('click', () => (state.open ? closeWindow() : openWindow()));
        bar.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); bar.click(); } });
        anchor.parentNode.insertBefore(bar, anchor);
    }
    const rec = shown();
    const pct = pctOf(rec);
    const stage = stageOf(pct);
    bar.title = `${t('open')} · ${t('stage_' + stage)}`;
    bar.setAttribute('aria-label', bar.title);
    bar.innerHTML = `${houndSvg(stage, 1.25)}<span class="th-bar-track"><span style="width:${Math.min(100, pct)}%;background:${STAGE_COLORS[stage - 1]}"></span></span>`
        + `<span class="th-bar-text">${rec ? `${pct}% · ${short(rec.total)}${rec.est ? ' ~' : ''}` : '—'}</span>`;
}

// ---------- small button (drag to move, position kept per device) ----------

function readPos() {
    try {
        const p = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
    } catch { /* ignore */ }
    return null;
}

function placeFab(fab, left, top) {
    const vw = window.innerWidth;
    const vh = state.baseHeight || window.innerHeight;
    const w = fab.offsetWidth || 64;
    const h = fab.offsetHeight || 36;
    if (left === undefined) {
        const p = readPos();
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

function bindFabDrag(fab) {
    let drag = null;
    let moved = false;
    const end = () => {
        if (drag && moved) {
            const vh = state.baseHeight || window.innerHeight;
            const pos = { x: (parseFloat(fab.style.left) || 0) / window.innerWidth, y: (parseFloat(fab.style.top) || 0) / vh };
            try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch { /* ignore */ }
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
        state.open ? closeWindow() : openWindow();
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
        fab.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); state.open ? closeWindow() : openWindow(); } });
        document.body.appendChild(fab);
        bindFabDrag(fab);
    }
    const rec = shown();
    const pct = pctOf(rec);
    const stage = stageOf(pct);
    fab.title = `${t('open')} · ${t('stage_' + stage)}`;
    fab.setAttribute('aria-label', fab.title);
    fab.innerHTML = `${houndSvg(stage, 1)}<span class="th-fab-text">${rec ? `${pct}%${rec.est ? '~' : ''}` : '—'}</span>`;
    if (!fab.style.left) placeFab(fab);
}

// ---------- wandering hound (walks along the top edge of the input) ----------

const walk = { timer: null, x: 8, dir: 1, tick: 0, pause: 0, key: '', bubbleUntil: 0, lastT: null };
const WALK_SCALE = 1.25;

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
            const max = Math.max(8, lane.clientWidth - 28 * WALK_SCALE - 8);
            walk.x += walk.dir * speed;
            if (walk.x >= max) { walk.x = max; walk.dir = -1; }
            if (walk.x <= 8) { walk.x = 8; walk.dir = 1; }
            const step = walk.tick % 4 < 2;
            frame = step ? 'walk' : (stage === 3 ? 'pant' : 'stand');
        }
    }
    const showBubble = Date.now() < walk.bubbleUntil;
    const key = `${frame}:${walk.dir}:${showBubble}:${pct}:${rec?.est ? 1 : 0}`;
    dog.style.left = `${Math.round(walk.x)}px`;
    if (key === walk.key) return;
    walk.key = key;
    const sprite = frame === 'walk' ? houndSvg(1, WALK_SCALE, true)
        : houndSvg(frame === 'sleep' ? 4 : frame === 'pant' ? 3 : frame === 'sniff' ? 2 : 1, WALK_SCALE);
    dog.classList.toggle('th-flip', walk.dir < 0);
    dog.innerHTML = `<span class="th-walk-dog">${sprite}</span><span class="th-walk-bubble${showBubble ? ' th-show' : ''}">${rec ? `${pct}%${rec.est ? '~' : ''}` : '—'}</span>`;
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
        dog.addEventListener('click', () => (state.open ? closeWindow() : openWindow()));
        dog.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dog.click(); } });
        lane.appendChild(dog);
        anchor.parentNode.insertBefore(lane, anchor);
        walk.key = '';
    }
    const rec = shown();
    const dog = document.getElementById('th-walker');
    const stage = stageOf(pctOf(rec));
    dog.title = `${t('open')} · ${t('stage_' + stage)}`;
    dog.setAttribute('aria-label', dog.title);
    // Pop the number up for a moment when a new turn comes in.
    const recT = rec ? `${rec.t}:${rec.est ? 1 : 0}` : null;
    if (recT && recT !== walk.lastT) { walk.bubbleUntil = Date.now() + 4000; }
    walk.lastT = recT;
    walk.key = '';
    walkStep();
    if (!walk.timer && !document.hidden) walk.timer = setInterval(walkStep, 140);
}

function renderDisplay() {
    const mode = settings.enabled ? settings.display : 'menu';
    if (mode !== 'bar') document.getElementById('th-bar')?.remove();
    if (mode !== 'button') document.getElementById('th-fab')?.remove();
    if (mode !== 'walk') stopWalker();
    if (mode === 'bar') renderBar();
    else if (mode === 'button') renderFab();
    else if (mode === 'walk') renderWalker();
}

function render() {
    try { renderDisplay(); } catch (e) { console.warn('[Tokenhound] display', e); }
    try { renderWindow(); } catch (e) { console.warn('[Tokenhound] window', e); }
}

// ---------- SillyTavern extension settings panel ----------

function panelHtml() {
    const chk = (id, label) => `<label class="checkbox_label" for="${id}"><input type="checkbox" id="${id}"><span>${esc(label)}</span></label>`;
    return `<div id="th-panel" class="th-panel"><div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>Tokenhound</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content">
${chk('th-p-enabled', t('set_enabled'))}
<label for="th-p-display">${esc(t('set_display'))}</label>
<select id="th-p-display" class="text_pole">${displayOptions().map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>
<small class="th-p-hint">${esc(t('set_display_hint'))}</small>
<div class="th-p-row"><div id="th-p-resetpos" class="menu_button">${esc(t('set_reset_pos'))}</div></div>
${chk('th-p-usage', t('set_usage'))}
<small class="th-p-hint">${esc(t('set_usage_hint'))}</small>
${chk('th-p-estimate', t('set_estimate'))}
<label for="th-p-lang">${esc(t('set_lang'))}</label>
<select id="th-p-lang" class="text_pole">${langOptions().map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>
<label for="th-p-logsize">${esc(t('set_log_size'))}</label>
<select id="th-p-logsize" class="text_pole"><option value="20">20</option><option value="50">50</option><option value="100">100</option></select>
<label>${esc(t('set_stage'))}</label>
<div class="th-p-stages"><input id="th-p-s1" class="text_pole" type="number" min="1" max="100" inputmode="numeric"><input id="th-p-s2" class="text_pole" type="number" min="1" max="100" inputmode="numeric"><input id="th-p-s3" class="text_pole" type="number" min="1" max="100" inputmode="numeric"></div>
<small class="th-p-hint">${esc(t('set_stage_hint'))}</small>
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
    $('th-p-sync').checked = settings.serverSync;
    $('th-p-storage').textContent = settings.serverSync ? t('set_storage_server') : t('set_storage_note');
    $('th-p-usage').checked = settings.readUsage;
    $('th-p-estimate').checked = settings.showEstimate;
    $('th-p-lang').value = settings.lang;
    $('th-p-logsize').value = String(settings.logSize);
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
            case 'th-p-sync':
                settings.serverSync = el.checked;
                syncPanel();
                if (el.checked) { syncWarned = false; pullLog(true).then(() => schedulePush()); }
                break;
            case 'th-p-usage': settings.readUsage = el.checked; break;
            case 'th-p-estimate': settings.showEstimate = el.checked; break;
            case 'th-p-lang': settings.lang = el.value; saveSettings(); buildPanel(); rebuildMenu(); render(); return;
            case 'th-p-logsize': settings.logSize = Number(el.value) || 50; saveLog(); break;
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
            try { localStorage.removeItem(POS_KEY); } catch { /* ignore */ }
            const fab = document.getElementById('th-fab');
            if (fab) placeFab(fab);
            toast('success', t('pos_reset'));
            return;
        }
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

function rebuildMenu() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    document.getElementById('th-menu')?.remove();
    const item = document.createElement('div');
    item.id = 'th-menu';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = `<div class="th-menu-icon extensionsMenuExtensionButton">${houndSvg(1, 0.75)}</div><span>${esc(t('title'))}</span>`;
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
}

async function init() {
    try {
        loadSettings();
        bindEvents();
        installFetchWatch();
        buildPanel();
        rebuildMenu();
        window.addEventListener('resize', onResize);
        document.addEventListener('visibilitychange', () => { if (!document.hidden && settings.display === 'walk') render(); });
        state.chatId = ctx().getCurrentChatId?.() || null;
        state.log = loadLog(state.chatId);
        state.latest = state.log[state.log.length - 1] || null;
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
