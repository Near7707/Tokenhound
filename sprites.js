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

    // Sleepy: flat on the ground, head on the paws, eye shut, zz above the head.
    const s4 = [
        '........................ggg.',
        '..........................g.',
        '.........................g..',
        '........................ggg.',
        '...................gggg.....',
        '......................g.....',
        '.....................g......',
        '....................gggg....',
        '.................kkkk.......',
        '.....kkkkkkkk...kwwwwk......',
        '....kwwwwwwwwkkkwwwwwwkk....',
        '...kwwkkkwwwwkkkkwkkwwwwk...',
        '..kwwkkkkwwwwkkkkkwwwwwwkk..',
        '..kwwwkkwwwwwwkkkkwwwkkkk...',
        'kkkwwwwwwwwwwwwwkkkwwwwwwk..',
        '.kkkkkkkkkkkkkkkkkkkkkkkk...',
    ].map(r => r.padEnd(W, '.'));

    return [s1, s2, s3, s4];
}

// Walking: the standing hound mid-stride (legs spread), used by the wandering mode.
function buildWalk() {
    const w = STAND.slice();
    w[12] = '...kwk.kwk...kwk.kwk'.padEnd(W, '.');
    w[13] = '..kwk...kwk.kwk...kwk'.padEnd(W, '.');
    w[14] = '..kkk...kkk.kkk...kkk'.padEnd(W, '.');
    return w;
}


// Resting hound: a doghouse with the hound peeking from behind it, lying in front,
// or asleep in front (zz). Same 28 x 16 grid and colors as the hound.
const HOUSE = {
    peek: [
        '......kk....................',
        '......kk....................',
        '....kkwwkk..................',
        '..kkwwwwwwkk................',
        'kkwwwwwwwwwwkkkkk...........',
        'kkkkkkkkkkkkkkwwwk..........',
        '.kwwwwwwwwwwkkwwwwk.........',
        '.kwwwwwwwwwwkkwkwwwwkk......',
        '.kwwwkkkkwwwkkwwwwwwwk......',
        '.kwwkkkkkkwwkkwwwwkkk.......',
        '.kwwkkkkkkwwkkkwwk..........',
        '.kwwkkkkkkwwkkkwwk..........',
        '.kwwkkkkkkwwkwwwwk..........',
        '.kwwkkkkkkwwkwwwk...........',
        '.kwwkkkkkkwwkk.kwk..........',
        'kkkkkkkkkkkkkk..............',
    ],
    rest: [
        '......kk....................',
        '......kk....................',
        '....kkwwkk..................',
        '..kkwwwwwwkk................',
        'kkwwwwwwwwwwkk..............',
        'kkkkkkkkkkkkkk..............',
        '.kwwwwwwwwwwk...............',
        '.kwwwwwwwwwwk...............',
        '.kwwwkkkkwwwk.kkkk..........',
        '.kwwkkkkkkwwkkwwwwk.........',
        '.kwwkkkkkkwkkwwwwwwkk.......',
        '.kwwkkkkkkwkkkwwkwwwwk......',
        '.kwwkkkkkkwkkkkwwwwwwkk.....',
        '.kwwkkkkkkwkkkkwwwkkkk......',
        '.kwwkkkkkkwwwkkkwwwwwwk.....',
        'kkkkkkkkkkkkkkkkkkkkkk......',
    ],
    sleep: [
        '......kk.............ggg....',
        '......kk...............g....',
        '....kkwwkk............g.....',
        '..kkwwwwwwkk.........ggg....',
        'kkwwwwwwwwwwkk..gggg........',
        'kkkkkkkkkkkkkk.....g........',
        '.kwwwwwwwwwwk.....g.........',
        '.kwwwwwwwwwwk....gggg.......',
        '.kwwwkkkkwwwk.kkkk..........',
        '.kwwkkkkkkwwkkwwwwk.........',
        '.kwwkkkkkkwkkwwwwwwkk.......',
        '.kwwkkkkkkwkkkwkkwwwwk......',
        '.kwwkkkkkkwkkkkwwwwwwkk.....',
        '.kwwkkkkkkwkkkkwwwkkkk......',
        '.kwwkkkkkkwwwkkkwwwwwwk.....',
        'kkkkkkkkkkkkkkkkkkkkkk......',
    ],
};

// Header hound extras: a tail-swing frame, the sniff arcs alone, and the sleepy hound split into body and zz.
function buildParts(stages) {
    const wag = STAND.slice();
    [[1, 2], [2, 2], [3, 3], [4, 3], [5, 3]].forEach(([r, c]) => set(wag, r, c, '.'));
    [[3, 1], [4, 1], [5, 2]].forEach(([r, c]) => set(wag, r, c, 'k'));
    const sniff = stages[1].map((line, r) => [...line].map((ch, c) => (ch === 'g' && STAND[r][c] === '.' ? 'g' : '.')).join(''));
    const sleepBody = stages[3].map(line => line.replace(/g/g, '.'));
    const sleepZ = stages[3].map(line => line.replace(/[kw]/g, '.'));
    return { wag, sniff, sleepBody, sleepZ };
}

const STAGES = build();
const WALK = buildWalk();
const PARTS = buildParts(STAGES);

// The doghouse alone, so the hound can hop while the house stays put.
const HOUSE_EMPTY = [
    '......kk',
    '......kk',
    '....kkwwkk',
    '..kkwwwwwwkk',
    'kkwwwwwwwwwwkk',
    'kkkkkkkkkkkkkk',
    '.kwwwwwwwwwwk',
    '.kwwwwwwwwwwk',
    '.kwwwkkkkwwwk',
    '.kwwkkkkkkwwk',
    '.kwwkkkkkkwwk',
    '.kwwkkkkkkwwk',
    '.kwwkkkkkkwwk',
    '.kwwkkkkkkwwk',
    '.kwwkkkkkkwwk',
    'kkkkkkkkkkkkkk',
].map(r => r.padEnd(W, '.'));

// The hound's dots in a doghouse scene: whatever differs from the empty house,
// plus its back edge where it lies against the wall (same color as the wall).
function houseDog(frame) {
    const rows = HOUSE[frame] || HOUSE.rest;
    return rows.map((line, r) => [...line.padEnd(W, '.')].map((ch, c) => {
        if (ch === '.') return '.';
        const lying = frame !== 'peek' && c === 12 && r >= 10 && r <= 13;
        return ch !== HOUSE_EMPTY[r][c] || lying ? ch : '.';
    }).join(''));
}
const HOUSE_DOG = { peek: houseDog('peek'), rest: houseDog('rest'), sleep: houseDog('sleep') };
const cache = new Map();

/**
 * Returns an SVG string of the hound for a mood (1-4) at a pixel scale.
 * @param {number} stage 1..4
 * @param {number} scale pixels per grid cell
 * @param {boolean} walking draw the mid-stride frame instead of a mood
 */
export function houndSvg(stage = 1, scale = 1, walking = false) {
    const idx = Math.min(4, Math.max(1, stage)) - 1;
    return draw(`${walking ? 'w' : idx}:${scale}`, walking ? WALK : STAGES[idx], scale);
}

/**
 * Returns an SVG string of one header-hound part.
 * @param {'wag'|'sniff'|'sleepBody'|'sleepZ'} part
 * @param {number} scale pixels per grid cell
 */
export function houndPartSvg(part, scale = 1) {
    const rows = PARTS[part] || STAND;
    return draw(`p${part}:${scale}`, rows, scale);
}

/**
 * Returns an SVG string of the doghouse with the resting hound.
 * @param {'peek'|'rest'|'sleep'} frame
 * @param {number} scale pixels per grid cell
 */
export function houseSvg(frame = 'rest', scale = 1) {
    const rows = HOUSE[frame] || HOUSE.rest;
    return draw(`h${frame}:${scale}`, rows, scale);
}

/**
 * Returns the doghouse scene in two layers (house, hound) so the hound can hop alone.
 * @param {'peek'|'rest'|'sleep'} frame
 * @param {number} scale pixels per grid cell
 */
export function houseLayersSvg(frame = 'rest', scale = 1) {
    const f = HOUSE_DOG[frame] ? frame : 'rest';
    return { house: draw(`he:${scale}`, HOUSE_EMPTY, scale), dog: draw(`hd${f}:${scale}`, HOUSE_DOG[f], scale) };
}

function draw(key, rows, scale) {
    if (cache.has(key)) return cache.get(key);
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
