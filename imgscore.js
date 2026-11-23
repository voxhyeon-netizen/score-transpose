/* ===========================================================================
   그림 악보 이조 — 전체를 엮는 부분 (브라우저판)

   쪽이 통째로 그림인 PDF 나 JPEG·PNG 를 받아, 음표와 코드를 함께 옮긴다.

     1. 쪽을 큼직하게 그려 흑백으로 바꾼다
     2. 오선을 찾는다 — 가로로 길게 이어진 줄을 다섯씩 묶는다
     3. 보표 위의 띠에서 코드 글자를 읽는다 (imgocr)
     4. 코드로 읽히는 것만 고른다 — 'Verse' 나 마디번호는 여기서 걸러진다
     5. 원래 조를 알아낸다
     6. 음표를 통째로 밀고 오선·조표·임시표·덧줄을 다시 그린다 (imgnotes)
     7. 옛 코드 글자를 지우고 그 자리에 새 코드를 쓴다

   맥용(scorelib/imgscore.py)과 짝이다.
   =========================================================================== */

/* 그림을 이 너비로 펴서 읽는다. 작게 읽으면 'F#/E' 가 'F#E' 가 되고 짧은
   코드가 통째로 빠진다. 넉넉히 키우는 편이 낫다. */
const IMG_RASTER_W = 3200;

const MAJOR_FIFTHS = {
  C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7,
  F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7,
};

// ----------------------------------------------------------- 오선 찾기

function imgFindStaves(bm, pageNo) {
  const ink = new Int32Array(bm.h);
  for (let y = 0; y < bm.h; y++) {
    let n = 0;
    const base = y * bm.w;
    for (let x = 0; x < bm.w; x++) if (bm.px[base + x]) n++;
    ink[y] = n;
  }
  let best = [];
  for (const ratio of [0.60, 0.45, 0.33, 0.25]) {
    const need = bm.w * ratio;
    const rows = [];
    for (let y = 0; y < bm.h; y++) if (ink[y] >= need) rows.push(y);
    const st = groupFive(mergeRows(rows), pageNo);
    if (st.length > best.length) best = st;
  }
  return best;
}

function mergeRows(rows, gap) {
  const g = gap === undefined ? 2 : gap;
  if (!rows.length) return [];
  const out = [];
  let start = rows[0], prev = rows[0];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i] - prev > g) { out.push((start + prev) / 2); start = rows[i]; }
    prev = rows[i];
  }
  out.push((start + prev) / 2);
  return out;
}

function groupFive(lines, pageNo, tol) {
  const t = tol === undefined ? 0.45 : tol;
  const out = [];
  let i = 0;
  while (i + 4 < lines.length) {
    const five = lines.slice(i, i + 5);
    const gaps = [0, 1, 2, 3].map(k => five[k + 1] - five[k]);
    const avg = gaps.reduce((a, b) => a + b, 0) / 4;
    if (avg > 0 && gaps.every(g => Math.abs(g - avg) <= avg * t)) {
      out.push({ page: pageNo, lines: five, spacing: avg,
                 top: five[0], bottom: five[4] });
      i += 5;
    } else i += 1;
  }
  return out;
}

/* 보표 위의 코드 띠 */
function chordBand(st, prevBottom) {
  const sp = st.spacing;
  let y0 = st.top - 3.5 * sp;
  const y1 = st.top - 0.25 * sp;
  if (prevBottom !== null) y0 = Math.max(y0, prevBottom + 2.2 * sp);
  return [y0, y1];
}

// ----------------------------------------------------------- 코드 읽기

/* 코드 뒤에 붙을 수 있는 것만 통과시킨다. 'Fine' 이 F 코드로, 'Chorus' 가
   C 코드로 둔갑하는 것을 막는 그물이다. */
const RE_SUFFIX_OK = /^(?:maj|Maj|MAJ|min|dim|aug|sus|add|alt|no|omit|M|m|°|ø|Δ|\^|\+|-|[0-9()\[\]#♯b♭,.\s])*$/;
const RE_CHORD = /^([A-G])\s*([#♯b♭]?)\s*([^/]*?)\s*(?:\/\s*([A-G])\s*([#♯b♭]?))?$/;
const RE_BASS_ONLY = /^\/\s*([A-G])\s*([#♯b♭]?)$/;

/* '/E' 처럼 베이스음만 적힌 코드를 표시해 두는 꼬리표 */
const BASS_ONLY_MARK = '\u0000/';

/* 악보에 ♭ 이 글자 'b' 가 아니라 음악 기호로 그려져 있으면 '°' 로 읽힌다.
   코드에서 '°' 는 감화음 기호이기도 하지만, 교회 악보에서 감화음은 'dim'
   으로 적는 쪽이 압도적이고 음이름 바로 뒤의 '°' 는 사실상 모두 ♭ 이었다. */
const RE_FLATTEN = /([A-G])[°˚○o]/g;

function alterOf(sign) {
  if (sign === '#' || sign === '♯') return 1;
  if (sign === 'b' || sign === '♭') return -1;
  return 0;
}

/* 코드로 읽히면 {root, rootAlter, suffix, bass, bassAlter} 를, 아니면 null */
function imgParseChord(text) {
  let s = String(text).trim()
    .replace(/♯/g, '#').replace(/♭/g, 'b').replace(/＃/g, '#')
    .replace(/[ÅÀÂïÏ§¤]/g, '#');
  s = s.replace(RE_FLATTEN, '$1b').replace(/ {2,}/g, ' ').trim();

  const mb = RE_BASS_ONLY.exec(s);
  if (mb) {
    return { root: mb[1], rootAlter: alterOf(mb[2]),
             suffix: BASS_ONLY_MARK, bass: null, bassAlter: 0 };
  }
  const m = RE_CHORD.exec(s);
  if (!m) return null;
  const suffix = (m[3] || '').trim();
  if (!RE_SUFFIX_OK.test(suffix)) return null;
  return { root: m[1], rootAlter: alterOf(m[2]), suffix,
           bass: m[4] || null, bassAlter: m[4] ? alterOf(m[5]) : 0 };
}

function chordName(c) {
  let out = noteName(c.root, c.rootAlter) + c.suffix;
  if (c.bass) out += '/' + noteName(c.bass, c.bassAlter);
  if (out.indexOf(BASS_ONLY_MARK) >= 0) out = '/' + out.split(BASS_ONLY_MARK).join('');
  return out;
}

function transposeChord(c, iv) {
  const [rl, ra] = transposePitch(c.root, c.rootAlter, iv, true);
  let bl = null, ba = 0;
  if (c.bass) { const r = transposePitch(c.bass, c.bassAlter, iv, true); bl = r[0]; ba = r[1]; }
  return { root: rl, rootAlter: ra, suffix: c.suffix, bass: bl, bassAlter: ba };
}

/* 한 토막에 코드가 여럿 붙어 나올 때가 있다 ('A/E B/D#') */
function splitTokens(tok) {
  const parts = tok.text.split(' ').filter(Boolean);
  if (parts.length <= 1) return [[tok.text.trim(), tok.x, tok.w]];
  const total = parts.reduce((a, p) => a + p.length, 0) + parts.length - 1;
  const out = [];
  let at = tok.x;
  for (const p of parts) {
    out.push([p, at, tok.w * p.length / total]);
    at += tok.w * (p.length + 1) / total;
  }
  return out;
}

// ----------------------------------------------------------- 조 알아내기

function scalePitches(fifths) {
  const out = new Set();
  for (const letter of IMG_LETTERS) out.add(pitchClass(letter, keyAlter(fifths, letter)));
  return out;
}

/* 코드들을 보고 원래 조를 어림한다.

   뿌리음과 베이스음을 모두 센다. 베이스음을 빼놓으면 E 조 악보가 D 조로
   보인다 — E 의 음은 거의 다 D 에도 있지만 B/D# 와 E/G# 의 베이스음은
   D 조에 없기 때문이다. */
/* 그 조가 이 코드들에 얼마나 들어맞는가 */
function imgKeyScore(chords, name) {
  const fifths = MAJOR_FIFTHS[name];
  const scale = scalePitches(fifths);
  let sharps = 0, flats = 0, score = 0;
  for (const c of chords) {
    if (c.rootAlter > 0 || c.bassAlter > 0) sharps++;
    if (c.rootAlter < 0 || c.bassAlter < 0) flats++;
    score += scale.has(pitchClass(c.root, c.rootAlter)) ? 1.0 : -1.5;
    if (c.bass) score += scale.has(pitchClass(c.bass, c.bassAlter)) ? 1.0 : -1.5;
  }
  const tonic = pitchClass(name[0], alterOf(name.slice(1, 2)));
  const last = chords[chords.length - 1], first = chords[0];
  if (pitchClass(last.root, last.rootAlter) === tonic) score += 3.0;
  if (pitchClass(first.root, first.rootAlter) === tonic) score += 2.0;
  if (fifths > 0) score += 0.35 * sharps - 0.35 * flats;
  else if (fifths < 0) score += 0.35 * flats - 0.35 * sharps;
  return score - Math.abs(fifths) * 0.08;
}

function imgGuessKey(chords) {
  if (!chords.length) throw new Error('코드를 하나도 읽지 못했습니다.');
  let sharps = 0, flats = 0;
  const notes = [];
  for (const c of chords) {
    if (c.rootAlter > 0 || c.bassAlter > 0) sharps++;
    if (c.rootAlter < 0 || c.bassAlter < 0) flats++;
    notes.push(pitchClass(c.root, c.rootAlter));
    if (c.bass) notes.push(pitchClass(c.bass, c.bassAlter));
  }
  let best = null, bestScore = -1e9;
  for (const name of Object.keys(MAJOR_FIFTHS)) {
    const fifths = MAJOR_FIFTHS[name];
    const scale = scalePitches(fifths);
    let score = 0;
    for (const pc of notes) score += scale.has(pc) ? 1.0 : -1.5;
    const tonic = pitchClass(name[0], alterOf(name.slice(1, 2)));
    const last = chords[chords.length - 1], first = chords[0];
    if (pitchClass(last.root, last.rootAlter) === tonic) score += 3.0;
    if (pitchClass(first.root, first.rootAlter) === tonic) score += 2.0;
    if (fifths > 0) score += 0.35 * sharps - 0.35 * flats;
    else if (fifths < 0) score += 0.35 * flats - 0.35 * sharps;
    score -= Math.abs(fifths) * 0.08;
    if (score > bestScore) { best = name; bestScore = score; }
  }
  return best;
}

// ------------------------------------------------- 코드 줄과 덩어리

function chordRowOf(tokens) {
  const ys = tokens.map(t => t.y).sort((a, b) => a - b);
  const hs = tokens.map(t => t.h).sort((a, b) => a - b);
  const ym = ys[ys.length >> 1], hm = hs[hs.length >> 1];
  return [ym - 0.3 * hm, ym + 1.05 * hm, hm];
}

function chordClusters(bm, top, bot, left, gap) {
  const t0 = Math.max(0, top | 0), t1 = Math.min(bm.h, bot | 0);
  if (t1 <= t0) return [];
  const col = new Uint8Array(bm.w);
  for (let y = t0; y < t1; y++) {
    const base = y * bm.w;
    for (let x = left; x < bm.w; x++) if (bm.px[base + x]) col[x] = 1;
  }
  const out = [];
  let start = -1, blank = 0;
  for (let x = left; x < bm.w; x++) {
    if (col[x]) { if (start < 0) start = x; blank = 0; }
    else if (start >= 0) {
      blank++;
      if (blank >= gap) { out.push([start, x - blank]); start = -1; }
    }
  }
  if (start >= 0) out.push([start, bm.w - 1]);
  return out;
}

/* 그 가로 구간에서 잉크가 가장 높이 쌓인 기둥의 높이.
   글자인지 가는 선(잇단음표 괄호 따위)인지 가른다. */
function inkHeight(bm, x0, x1, top, bot) {
  const t0 = Math.max(0, top | 0), t1 = Math.min(bm.h, bot | 0);
  let best = 0;
  for (let x = Math.max(0, x0); x < Math.min(bm.w, x1 + 1); x++) {
    let n = 0;
    for (let y = t0; y < t1; y++) if (bm.px[y * bm.w + x]) n++;
    if (n > best) best = n;
  }
  return best;
}

// ------------------------------------------------- 같은 모양 맞대 보기

function patchOf(bm, a, b, top, bot) {
  const x0 = Math.max(0, a), x1 = Math.min(bm.w, b);
  const y0 = Math.max(0, top | 0), y1 = Math.min(bm.h, bot | 0);
  if (x1 <= x0 || y1 <= y0) return null;
  const out = new Bitmap(x1 - x0, y1 - y0);
  for (let y = y0; y < y1; y++) {
    out.px.set(bm.px.subarray(y * bm.w + x0, y * bm.w + x1), (y - y0) * out.w);
  }
  return out;
}

function trimPatch(p) {
  if (!p) return null;
  let xs0 = p.w, xs1 = 0, ys0 = p.h, ys1 = 0;
  for (let y = 0; y < p.h; y++) {
    let first = -1, last = -1;
    for (let x = 0; x < p.w; x++) {
      if (p.px[y * p.w + x]) { if (first < 0) first = x; last = x; }
    }
    if (first < 0) continue;
    if (y < ys0) ys0 = y;
    ys1 = y + 1;
    if (first < xs0) xs0 = first;
    if (last + 1 > xs1) xs1 = last + 1;
  }
  if (xs1 <= xs0 || ys1 <= ys0) return null;
  const out = new Bitmap(xs1 - xs0, ys1 - ys0);
  for (let y = ys0; y < ys1; y++) {
    out.px.set(p.px.subarray(y * p.w + xs0, y * p.w + xs1), (y - ys0) * out.w);
  }
  return out;
}

/* 오려 낸 자리가 조금씩 달라도 맞대 볼 수 있도록 키를 맞춘다 */
function normPatch(p, H) {
  const h = H === undefined ? 40 : H;
  if (!p || p.h < 2 || p.w < 2) return null;
  const W = Math.max(2, Math.round(p.w * h / p.h));
  const out = new Bitmap(W, h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(p.h - 1, ((y * p.h / h) | 0));
    for (let x = 0; x < W; x++) {
      out.px[y * W + x] = p.px[sy * p.w + Math.min(p.w - 1, ((x * p.w / W) | 0))];
    }
  }
  return out;
}

function similarPatch(p, q) {
  if (!p || !q) return 0;
  if (Math.abs(p.w - q.w) > Math.max(3, p.w * 0.14)) return 0;
  const w = Math.min(p.w, q.w), h = Math.min(p.h, q.h);
  let same = 0, both = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = p.px[y * p.w + x], b = q.px[y * q.w + x];
      if (a || b) { both++; if (a && b) same++; }
    }
  }
  return both ? same / both : 0;
}

// ------------------------------------------------------------- 쪽 그리기

/* PDF 나 그림 파일을 쪽마다 큼직한 캔버스로 그린다 */
function looksLikePdf(bytes) {
  // '%PDF' 로 시작하면 PDF 다. 파일 이름이나 형식 꼬리표는 믿을 게 못 된다 —
  // 아이폰 사진은 HEIC 로 오고, 이름이 없는 채로 들어오기도 한다.
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 &&
         bytes[2] === 0x44 && bytes[3] === 0x46;
}

async function imgRenderPages(bytes, fileName) {
  const isImage = !looksLikePdf(bytes);
  const pages = [];

  if (isImage) {
    const blob = new Blob([bytes]);   // 형식은 브라우저가 알아서 가린다
    const url = URL.createObjectURL(blob);
    try {
      const im = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('그림을 열지 못했습니다.'));
        i.src = url;
      });
      const scale = Math.min(IMG_RASTER_W / im.width, 8);
      const cv = document.createElement('canvas');
      cv.width = Math.round(im.width * scale);
      cv.height = Math.round(im.height * scale);
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(im, 0, 0, cv.width, cv.height);
      pages.push({ canvas: cv, ctx, scale, srcW: im.width,
                   widthPt: im.width, heightPt: im.height });
    } finally { URL.revokeObjectURL(url); }
    return pages;
  }

  const lib = await loadPdfJs();
  const doc = await lib.getDocument({ data: bytes.slice() }).promise;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(IMG_RASTER_W / base.width, 8);
    const vp = page.getViewport({ scale });
    const cv = document.createElement('canvas');
    cv.width = Math.round(vp.width);
    cv.height = Math.round(vp.height);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    // 원본 그림의 실제 화소 너비 — 얼마나 잘겠는지 가늠하는 데 쓴다
    let srcW = 0;
    try {
      const ops = await page.getOperatorList();
      for (let k = 0; k < ops.fnArray.length; k++) {
        if (ops.fnArray[k] === lib.OPS.paintImageXObject) {
          const nm = ops.argsArray[k][0];
          // objs.get 은 아직 안 풀린 것을 달라고 하면 그대로 멈춰 선다.
          // 있는지 먼저 묻고 가져온다.
          if (!page.objs.has || !page.objs.has(nm)) continue;
          const im = page.objs.get(nm);
          if (im && im.width > srcW) srcW = im.width;
        }
      }
    } catch (e) { /* 못 알아내면 캔버스 크기로 가늠한다 */ }
    pages.push({ canvas: cv, ctx, scale, srcW: srcW || base.width,
                 widthPt: base.width, heightPt: base.height });
  }
  return pages;
}

// --------------------------------------------------------------- 모으기

/* 쪽마다 보표를 찾고, 그 위 띠에서 코드를 읽어 모은다 */
async function imgCollect(pages, onProgress) {
  const hits = [], allStaves = [], missed = [];
  const templates = [], unknown = [];

  for (let pno = 0; pno < pages.length; pno++) {
    const pg = pages[pno];
    if (onProgress) onProgress(`${pno + 1}쪽을 읽는 중…`);
    const img = pg.ctx.getImageData(0, 0, pg.canvas.width, pg.canvas.height);
    pg.bm = Bitmap.fromImageDataNoColor(img);
    pg.orig = pg.bm.copy();
    const staves = imgFindStaves(pg.bm, pno);
    pg.staves = staves;
    allStaves.push(...staves);

    let prev = null;
    for (let si = 0; si < staves.length; si++) {
      const st = staves[si];
      const [y0, y1] = chordBand(st, prev);
      prev = st.bottom;
      if (y1 - y0 < 8) continue;

      const bandH = Math.round(y1) - Math.round(y0);
      const bcv = document.createElement('canvas');
      bcv.width = pg.canvas.width; bcv.height = bandH;
      const bctx = bcv.getContext('2d', { willReadFrequently: true });
      bctx.fillStyle = '#fff'; bctx.fillRect(0, 0, bcv.width, bandH);
      bctx.drawImage(pg.canvas, 0, Math.round(y0), bcv.width, bandH,
                     0, 0, bcv.width, bandH);
      const band = Bitmap.fromImageDataNoColor(
        bctx.getImageData(0, 0, bcv.width, bandH));

      let tokens = [];
      try { tokens = await ocrCanvas(bcv, onProgress); } catch (e) { tokens = []; }
      tokens = tokens.map(t => Object.assign({}, t, { text: fixChordText(t.text) }));
      if (!tokens.length) continue;

      const first = [];
      for (const tok of tokens) {
        for (const [text, tx, tw] of splitTokens(tok)) {
          const ch = imgParseChord(text);
          if (ch) first.push({ chord: ch, text, page: pno, x: tx,
                               y: y0 + tok.y, w: tw, h: tok.h, ex0: 0, ex1: 0 });
        }
      }

      const [top, bot, hm] = chordRowOf(tokens);
      const left = Math.max(0, Math.min(...tokens.map(t => t.x)) - 4);
      const gap = Math.max(4, (st.spacing * 0.9) | 0);
      for (const [a, b] of chordClusters(band, top, bot, left, gap)) {
        if (b - a < st.spacing * 0.5) continue;
        // 글자처럼 생긴 것만 본다. 보표 위로 솟은 빔이나 잇단음표 괄호는
        // 납작하거나 지나치게 길어서 여기서 걸러진다. 이것을 거르지 않으면
        // 읽을 코드가 아닌데도 '못 읽었다' 고 세어 괜한 경고가 쏟아진다.
        if (b - a > st.spacing * 6) continue;
        if (inkHeight(band, a, b, top, bot) < hm * 0.55) continue;
        const done = first.filter(h => h.x < b + 4 && a - 4 < h.x + h.w);
        if (done.length) {
          const span = Math.max(...done.map(h => h.x + h.w)) -
                       Math.min(...done.map(h => h.x));
          if (span >= (b - a) * 0.7 || done.length > 1) continue;
          // 코드가 잘려 읽히는 것은 늘 뒤쪽이다 ('B7/D#' → 'B'). 그래서
          // 오른쪽에 남은 잉크만 본다. 왼쪽에 남은 것은 대개 다른 기호다.
          const ua = Math.round(Math.max(...done.map(h => h.x + h.w))) + 2;
          if (b - ua < hm * 0.4) continue;
          if (inkHeight(band, ua, b, top, bot) < hm * 0.45) continue;
          // 잘라 먹은 것 같으면 아예 손대지 않는다. 반쯤 지우면 원본보다
          // 나빠진다 ('B7/D#' 가 'D7/D#' 이 되는 식이다).
          first.splice(first.indexOf(done[0]), 1);
          unknown.push(unknownItem(band, a, b, top, bot, pno, y0));
          continue;
        }
        // 코드로 읽히진 않았어도 글자로 읽힌 자리라면 덮인 것이다 —
        // 마디번호나 구간 이름이 거기 있다. 못 읽은 코드로 세면 안 된다.
        const covered = tokens.some(t =>
          t.x < b + 4 && a - 4 < t.x + t.w &&
          Math.min(b, t.x + t.w) - Math.max(a, t.x) > (b - a) * 0.5);
        if (covered) continue;
        unknown.push(unknownItem(band, a, b, top, bot, pno, y0));
      }
      for (const h of first) {
        addTemplate(templates, band, h.x, h.x + h.w, top, bot, h.text);
      }
      hits.push(...first);
    }
  }

  // 못 읽은 조각을, 잘 읽힌 같은 모양과 맞대 본다. 한 악보에서 같은 코드는
  // 여러 번 되풀이되므로 이것만으로 몇 개를 건진다.
  for (const item of unknown) {
    let bestText = null, bestScore = 0.80;
    for (const [text, tpl] of templates) {
      const s = similarPatch(item.patch, tpl);
      if (s > bestScore) { bestText = text; bestScore = s; }
    }
    const ch = bestText ? imgParseChord(bestText) : null;
    if (!ch) { missed.push([item.page, (item.a + item.b) / 2, item.cy]); continue; }
    hits.push({ chord: ch, text: bestText, page: item.page, x: item.a,
                y: item.ty, w: item.b - item.a, h: item.th,
                ex0: item.a, ex1: item.b });
  }

  hits.sort((p, q) => (p.page - q.page) ||
    (Math.round(p.y / 40) - Math.round(q.y / 40)) || (p.x - q.x));
  return { hits, staves: allStaves, missed };
}

/* 덩어리 하나만 오려서 크게 다시 읽힌다.

   작은 그림에 짧은 글자 하나만 들어 있으면 글자 읽기가 훨씬 잘 맞춘다.
   띠 전체를 한 번 읽는 것만으로는 흘리는 코드가 꼭 몇 개 생긴다. */
async function rereadCluster(pg, a, b, y0, y1, hm) {
  const pad = Math.max(6, hm * 0.45);
  const sx = Math.max(0, Math.round(a - pad));
  const ex = Math.min(pg.canvas.width, Math.round(b + pad));
  const sy = Math.round(y0), ey = Math.round(y1);
  if (ex - sx < 6 || ey - sy < 6) return null;
  const cv = document.createElement('canvas');
  cv.width = (ex - sx) * 2; cv.height = (ey - sy) * 2;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
  cx.imageSmoothingEnabled = true;
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(pg.canvas, sx, sy, ex - sx, ey - sy, 0, 0, cv.width, cv.height);
  let toks = [];
  try { toks = await ocrCanvas(cv); } catch (e) { return null; }
  toks.sort((p, q) => (q.conf || 0) - (p.conf || 0));
  for (const t of toks) {
    for (const [text] of splitTokens(Object.assign({}, t,
        { text: fixChordText(t.text) }))) {
      const ch = imgParseChord(text);
      if (ch) return { chord: ch, text };
    }
  }
  return null;
}


function addTemplate(templates, band, a, b, top, bot, text) {
  let n = 0;
  for (const [t] of templates) if (t === text) n++;
  if (n >= 2) return;
  const p = normPatch(trimPatch(patchOf(band, Math.round(a) - 2, Math.round(b) + 2,
                                        top, bot)));
  if (p && p.w > 3 && p.h > 3) templates.push([text, p]);
}

function unknownItem(band, a, b, top, bot, pno, y0) {
  return {
    patch: normPatch(trimPatch(patchOf(band, Math.round(a) - 2, Math.round(b) + 2,
                                       top, bot))),
    a, b, page: pno, ty: y0 + top, th: bot - top, cy: (top + bot) / 2 + y0,
  };
}

// --------------------------------------------------------- 쪽 하나 옮기기

/* 한 쪽의 음표를 옮기고 오선·조표·임시표·덧줄을 다시 그린다 */
function imgTransposePage(pg, iv, oldFifths, newFifths) {
  const res = { notes: 0, accidentals: 0, keysigFailed: 0 };
  const staves = pg.staves;
  if (!staves.length) return res;

  const bm = pg.bm, orig = pg.orig;
  const thick = measureThickness(bm, staves[0].lines);
  for (const s of staves) removeStaffLines(bm, s.lines, thick, 2);

  const info = [];
  for (const s of staves) {
    const [sx0, sx1] = staffXrange(orig, s.lines[0]);
    const lo = Math.round(s.top - 5 * s.spacing);
    const hi = Math.round(s.bottom + 5 * s.spacing);
    const b1 = blobs(bm, lo, hi);
    const reg = findHeadRegion(b1, s.top, s.bottom, s.spacing, sx0);
    info.push({ s, sx0, sx1, lo, hi, b1, reg });
  }

  const plan = planKeysig(info.map(i => i.reg), info.map(i => i.sx0));
  let bestReg = info[0].reg;
  for (const i of info) if (i.reg.keysig.length > bestReg.keysig.length) bestReg = i.reg;
  const sp0 = staves[0].spacing;
  const sharp = bestReg.keysig.length ? blobStamp(bestReg.keysig[0])
                                     : fontStamp('♯', sp0 * 2.0);
  const flat = findAccidentalStamp(info[0].b1, sp0, true) ||
               fontStamp('♭', sp0 * 2.0);
  const nat = fontStamp('♮', sp0 * 2.0);
  const glyphs = { '1': sharp, '-1': flat, '0': nat };

  const steps = iv.steps;
  for (const it of info) {
    const { s, sx0, sx1, lo, hi, b1 } = it;
    const mask = staffMask(bm, b1, s.top - 2, s.bottom + 2);
    const xStart = sx0 + (plan.ok ? plan.dx1 : 0) + 4;
    const heads = findHeads(bm, s.lines, s.spacing, xStart, sx1, mask);
    const inner = b1.filter(b => b.x0 >= xStart);
    const accs = findAccidentals(inner, heads, s.spacing);
    const bars = findBarlines(inner, s.spacing, s.top, s.bottom);
    const wanted = planAccidentals(heads, accs, bars, oldFifths, newFifths, iv);
    res.notes += heads.length;
    res.accidentals += accs.length;

    for (const a of accs) {                       // 옛 임시표를 지운다
      for (const [y, x_, c] of a.blob.runs) bm.px.fill(0, y * bm.w + x_, y * bm.w + c);
    }
    const skip = new Set(accs.map(a => a.blob));

    eraseLedgers(bm, heads, s.lines, s.spacing, thick);
    const b2 = blobs(bm, lo, hi).filter(b => b.x0 >= xStart && !skip.has(b));
    const kinds = imgClassify(b2, heads, s.spacing, s.top, s.bottom);
    const dy = Math.round(-steps * s.spacing / 2);
    shiftMusic(bm, b2, kinds, dy);

    for (const [h, alter] of wanted) {            // 새 임시표를 찍는다
      if (alter === null) continue;
      const g = glyphs[String(alter)];
      if (!g) continue;
      stamp(bm, g, h.x0 - g.w - Math.max(2, (s.spacing * 0.22) | 0),
            h.y + dy, alter === -1 ? 0.72 : 0.5);
    }

    if (!applyKeysig(bm, plan, sx0, s.lines, s.spacing, newFifths, sharp, flat)) {
      res.keysigFailed++;
    }
    drawStaff(bm, s.lines, thick, sx0, sx1);
    drawLedgers(bm, heads, s.lines, s.spacing, thick, steps);
  }
  return res;
}

// ----------------------------------------------------------- 바깥 창구

function nativeSpacing(pg) {
  if (!pg.staves || !pg.staves.length) return 0;
  const gap = Math.min(...pg.staves.map(s => s.spacing)) / pg.scale;
  return pg.srcW ? gap * pg.srcW / pg.widthPt : gap;
}

function needWidth(pg, native) {
  if (!pg.srcW || !native) return 0;
  return Math.round(pg.srcW * 14 / native / 100) * 100;
}

/* 악보를 살피기만 한다 (바꾸지 않음) */
async function imgInspect(bytes, fileName, onProgress) {
  const pages = await imgRenderPages(bytes, fileName);
  const { hits, staves, missed } = await imgCollect(pages, onProgress);
  const out = { problems: [], warnings: [], pages, hits, staveList: staves,
                missed, staves: staves.length, notes: 0, chords: hits.length,
                chordNames: [], keyChanges: [], key: 'C', fifths: 0,
                withNotes: true };
  if (!staves.length) {
    out.problems.push('오선을 찾지 못했습니다. 악보 그림이 맞는지 확인해 주세요.');
    return out;
  }
  if (!hits.length) {
    out.problems.push('코드 기호를 하나도 읽지 못했습니다.');
    return out;
  }

  const native = nativeSpacing(pages[0]);
  out.native = native;
  const need = needWidth(pages[0], native);
  const howBig = need ? ` 지금 가로 ${pages[0].srcW}픽셀인데, ${need}픽셀쯤 되면 음표까지 다 됩니다.` : '';

  const ratio = hits.length / Math.max(1, hits.length + missed.length);
  if (ratio < 0.7) {
    out.problems.push(`코드를 ${Math.round(ratio * 100)}%밖에 읽지 못했습니다 ` +
      `(${hits.length}개 읽고 ${missed.length}곳 놓침). 바뀐 코드와 안 바뀐 ` +
      `코드가 섞여 버리므로 손대지 않았습니다.${howBig}`);
    return out;
  }
  if (native && native < 11) {
    out.problems.push(`그림이 너무 작습니다 (오선 간격 ${Math.round(native)}픽셀). ` +
      `코드 글자가 뭉개져 절반쯤밖에 읽히지 않습니다.${howBig}`);
    return out;
  }
  if (missed.length > hits.length) {
    out.problems.push('코드 줄을 제대로 찾지 못했습니다. 한 단에 보표가 하나인 ' +
      '리드시트만 다룰 수 있습니다 — 피아노 반주보나 합창 악보는 코드가 어디 ' +
      '적혔는지 가려내지 못합니다.');
    return out;
  }
  if (native && native < 14) {
    out.withNotes = false;
    out.warnings.push(`그림이 작아 (오선 간격 ${Math.round(native)}픽셀) 음표는 ` +
      '건드리지 않고 코드만 바꿉니다.');
  }

  // 곡 가운데서 조가 바뀌는 악보가 있다. 코드는 모두 같은 간격으로 옮기면
  // 되지만 음표 쪽은 단마다 조표를 달리 써야 해서 지금 방식으로는 깨진다.
  const cs = hits.map(h => h.chord);
  if (cs.length >= 12) {
    const third = Math.floor(cs.length / 3);
    const head = cs.slice(0, third), tail = cs.slice(-third);
    const headKey = imgGuessKey(head);
    const tailKey = imgGuessKey(tail);
    // 앞뒤 조가 다르게 나왔다고 곧바로 전조로 보면 안 된다. 코드 몇 개만
    // 달리 읽혀도 이웃한 조로 기울기 때문이다. 뒤쪽 코드에 대해 뒤쪽 조가
    // 앞쪽 조보다 **뚜렷하게** 나을 때만 전조로 친다.
    const margin = imgKeyScore(tail, tailKey) - imgKeyScore(tail, headKey);
    if (headKey !== tailKey && margin >= tail.length * 0.8) {
      out.keyChanges = [headKey, tailKey];
      if (out.withNotes) {
        out.withNotes = false;
        out.warnings.push(`곡 가운데서 조가 바뀌는 것 같습니다 (${headKey} → ${tailKey}). ` +
          '음표는 건드리지 않고 코드만 바꿉니다.');
      }
    }
  }

  out.key = imgGuessKey(cs);
  out.fifths = MAJOR_FIFTHS[out.key];
  out.chordNames = [...new Set(hits.map(h => chordName(h.chord)))].slice(0, 12);
  if (missed.length) {
    out.warnings.push(`읽지 못한 자리 ${missed.length}곳은 원래대로 두었습니다. ` +
      '그 코드는 옛 키 그대로이니 눈으로 확인해 주세요.');
  }
  return out;
}

/* 화면에서 고른 것({to:'G'} 또는 {by:2})을 옮길 조 이름으로 바꾼다 */
function imgTargetKey(srcKey, choice) {
  if (choice && choice.to) return choice.to;
  if (!choice || typeof choice.by !== 'number') {
    throw new Error('옮길 조를 알려 주세요.');
  }
  const [sl, sa] = parseNoteName(srcKey);
  const want = (((pitchClass(sl, sa) + choice.by) % 12) + 12) % 12;
  let best = null;
  for (const k of Object.keys(MAJOR_FIFTHS)) {
    if (pitchClass(k[0], alterOf(k.slice(1, 2))) !== want) continue;
    if (!best || Math.abs(MAJOR_FIFTHS[k]) < Math.abs(MAJOR_FIFTHS[best])) best = k;
  }
  if (!best) throw new Error('옮길 조를 찾지 못했습니다.');
  return best;
}


/* 캔버스를 PNG 바이트로 */
function canvasPng(cv) {
  return new Promise((resolve, reject) => {
    cv.toBlob(b => {
      if (!b) { reject(new Error('그림을 만들지 못했습니다.')); return; }
      b.arrayBuffer().then(a => resolve(new Uint8Array(a)), reject);
    }, 'image/png');
  });
}

/* 그림 악보를 옮겨 새 PDF 바이트를 돌려준다.

   info 는 imgInspect 가 돌려준 것이다. 쪽을 다시 그리지 않으려고 그대로
   넘겨받는다. */
async function imgTransposeScore(info, targetKey, onProgress) {
  const rep = { warnings: [], notes: 0, accidentals: 0, chords: 0,
                staves: info.staves, missed: info.missed.length };
  const srcName = info.key;
  if (!(targetKey in MAJOR_FIFTHS)) throw new Error('옮길 조로 쓸 수 없는 이름입니다.');
  if (targetKey === srcName) {
    rep.blocked = `이 악보는 이미 ${srcName} 조입니다.`;
    return { rep, bytes: null };
  }
  const [sl, sa] = parseNoteName(srcName);
  const [dl, da] = parseNoteName(targetKey);
  const iv = intervalBetween([sl, sa], [dl, da], 'near');
  const oldF = MAJOR_FIFTHS[srcName], newF = MAJOR_FIFTHS[targetKey];
  rep.sourceKey = srcName;
  rep.targetKey = targetKey;
  rep.interval = iv.describe();

  // 1) 음표를 옮긴다
  if (info.withNotes) {
    for (let i = 0; i < info.pages.length; i++) {
      if (onProgress) onProgress(`${i + 1}쪽 음표를 옮기는 중…`);
      const r = imgTransposePage(info.pages[i], iv, oldF, newF);
      rep.notes += r.notes;
      rep.accidentals += r.accidentals;
      if (r.keysigFailed) rep.keysigFailed = (rep.keysigFailed || 0) + r.keysigFailed;
    }
  }

  // 2) 옛 코드 글자를 지운다 (그림 위에서)
  const capList = info.hits
    .filter(h => /^[A-G#b/]+$/.test(h.text.trim()))
    .map(h => h.h).sort((a, b) => a - b);
  const anyList = info.hits.map(h => h.h).sort((a, b) => a - b);
  const capPx = (capList.length ? capList : anyList)[
    Math.floor((capList.length ? capList.length : anyList.length) / 2)] || 20;

  for (const h of info.hits) {
    const pg = info.pages[h.page];
    const pad = 3;
    const x0 = Math.min(h.x, h.ex0 || h.x) - pad;
    const x1 = Math.max(h.x + h.w, h.ex1 || (h.x + h.w)) + pad;
    pg.bm.fill(x0, h.y - pad, x1, h.y + h.h + pad, 0);
  }

  // 3) 바뀐 그림을 PDF 로 싸고 그 위에 새 코드를 쓴다
  if (onProgress) onProgress('새 악보를 만드는 중…');
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);

  for (let i = 0; i < info.pages.length; i++) {
    const pg = info.pages[i];
    pg.ctx.putImageData(pg.bm.toImageData(pg.ctx), 0, 0);
    const png = await doc.embedPng(await canvasPng(pg.canvas));
    const page = doc.addPage([pg.widthPt, pg.heightPt]);
    page.drawImage(png, { x: 0, y: 0, width: pg.widthPt, height: pg.heightPt });

    const size = capPx / pg.scale / 0.662;
    for (const h of info.hits) {
      if (h.page !== i) continue;
      const text = chordName(transposeChord(h.chord, iv))
        .replace(/♯/g, '#').replace(/♭/g, 'b');
      const x = Math.min(h.x, h.ex0 || h.x) / pg.scale;
      const yTop = (h.y + h.h) / pg.scale;
      page.drawText(text, { x, y: pg.heightPt - yTop, size, font,
                            color: rgb(0, 0, 0) });
      rep.chords++;
    }
  }

  if (!info.withNotes) {
    rep.warnings.push('음표는 원래 키 그대로입니다. 코드만 바뀌었습니다.');
  }
  for (const n of info.warnings) rep.warnings.push(n);
  if (rep.keysigFailed) {
    rep.warnings.push(`조표를 바꾸지 못한 단이 ${rep.keysigFailed}곳 있습니다.`);
  }
  return { rep, bytes: await doc.save() };
}
