// Tokenhound — black-and-white pixel hound (side view), four moods.
// Grid is 28 x 16. '.' = empty, k = black, w = white, g = gray.

const PALETTE = { k: '#141414', w: '#FAFAF7', g: '#8A8A85' };
const W = 28;
const H = 16;

const STAND = [
    '........................',
    '..k............kkkk.....',
    '..k...........kwwwwk....',
    '...k.........kkkwwwwk...',
    '...k.........kkkwkwwwwkk',
    '...k.........kkkwwwwwwwk',
    '...kkkkkkkkkkkkkwwwwkkk.',
    '..kwwwwkkwwwwkkkkwwk....',
    '..kwwwkkkkwwwwwkkwwk....',
    '..kwwwwkkwwwwwwwwwwk....',
    '...kwwwwwwwwwwwwwwk.....',
    '...kwk.kwk...kwk.kwk....',
    '...kwk.kwk...kwk.kwk....',
    '...kwk.kwk...kwk.kwk....',
    '...kkk.kkk...kkk.kkk....',
    '........................',
].map(r => r.padEnd(W, '.'));

function set(rows, r, c, s) {
    rows[r] = rows[r].slice(0, c) + s + rows[r].slice(c + s.length);
}

function build() {
    const s1 = STAND.slice();

    // Sniffing: little "sniff" arcs in front of the nose (nose level, not the mouth).
    const s2 = STAND.slice();
    [[3, 24], [4, 25], [5, 24], [2, 26], [3, 27], [4, 27], [5, 27], [6, 26]].forEach(([r, c]) => set(s2, r, c, 'g'));

    // Panting: open mouth with tongue, a sweat drop above the head.
    const s3 = STAND.slice();
    set(s3, 7, 20, 'kk');
    set(s3, 8, 20, 'gk');
    set(s3, 9, 20, 'k');
    set(s3, 0, 22, 'g');
    set(s3, 1, 21, 'gg');
    set(s3, 2, 21, 'gg');

    // Sleepy: lying down, eye closed, zz.
    const blank = '.'.repeat(W);
    const s4 = [blank, blank, blank].concat(STAND.slice(0, 11));
    set(s4, 7, 16, 'kk');
    s4.push('...kkkkkkkkkkkkkkkkk'.padEnd(W, '.'));
    s4.push(blank);
    set(s4, 0, 21, 'gggg');
    set(s4, 1, 23, 'g');
    set(s4, 2, 22, 'g');
    set(s4, 3, 21, 'gggg');
    set(s4, 0, 26, 'gg');
    set(s4, 1, 27, 'g');
    set(s4, 2, 26, 'gg');

    return [s1, s2, s3, s4];
}

const STAGES = build();
const cache = new Map();

/**
 * Returns an SVG string of the hound for a mood (1-4) at a pixel scale.
 * @param {number} stage 1..4
 * @param {number} scale pixels per grid cell
 */
export function houndSvg(stage = 1, scale = 1) {
    const idx = Math.min(4, Math.max(1, stage)) - 1;
    const key = `${idx}:${scale}`;
    if (cache.has(key)) return cache.get(key);
    const rows = STAGES[idx];
    let rects = '';
    for (let y = 0; y < H; y++) {
        const line = rows[y] || '';
        for (let x = 0; x < W; x++) {
            const c = line[x];
            if (c && c !== '.') rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${PALETTE[c]}"/>`;
        }
    }
    const svg = `<svg class="th-hound" viewBox="0 0 ${W} ${H}" width="${W * scale}" height="${H * scale}" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${rects}</svg>`;
    cache.set(key, svg);
    return svg;
}
