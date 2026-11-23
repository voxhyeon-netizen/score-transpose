/* ===========================================================================
   그림 악보에서 음표를 찾아 옮긴다 (브라우저판)

   이조는 모든 음을 오선 위에서 같은 거리만큼 미는 일이다. 이 한 가지
   성질 덕에 그림 악보도 다룰 수 있다 — 빔으로 묶인 음도 이음줄이 걸린
   음도 덩어리째 밀면 그대로 맞는다. 그래서 음표 하나하나가 무슨 음인지
   다 알아낼 필요가 없고, "무엇이 음높이에 매여 있고 무엇이 오선에 매여
   있는가" 만 가리면 된다.

   움직이지 않는 것: 음자리표, 조표, 박자표, 세로줄, 쉼표.
   움직이는 것: 음표 머리와 거기 딸린 기둥·빔·꼬리, 이음줄, 점.

   맥용(scorelib/imgnotes.py)과 짝이다. 고칠 때는 양쪽을 같이 고쳐야 한다.
   =========================================================================== */

const IMG_LETTERS = 'CDEFGAB';

/* 조표에서 ♯·♭ 이 놓이는 자리 (높은음자리표, 맨 아랫줄 = 0) */
const IMG_SHARP_STEPS = [8, 5, 9, 6, 3, 7, 4];      // F C G D A E B
const IMG_FLAT_STEPS = [4, 7, 3, 6, 2, 5, 1];       // B E A D G C F

function stepLetter(step) {
  const i = (IMG_LETTERS.indexOf('E') + step) % 7;
  return IMG_LETTERS[(i + 7) % 7];
}

/* 오선이 가로로 어디서 어디까지 그어져 있는지 (오선을 지우기 전 그림) */
function staffXrange(orig, lineY) {
  const y = Math.round(lineY);
  let best = [0, 0];
  for (const [a, b] of orig.runs(y)) {
    if (b - a > best[1] - best[0]) best = [a, b];
  }
  return best;
}

// --------------------------------------------------------- 보표 앞머리

/* 음자리표부터 박자표까지. 이 구역은 음높이가 아니라 오선에 매여 있으므로
   옮기지 않는다. 조표는 새 조에 맞춰 다시 그려야 하니 어디부터 어디까지인지
   정확히 알아 둘 필요가 있다. */
function findHeadRegion(bs, top, bottom, spacing, left) {
  const reg = { xEnd: left, clef: null, keysig: [], timesig: [] };
  const h = bottom - top;
  // 세로로 바싹 붙은 것만 본다. 구간 이름 상자('Verse')가 오선 왼쪽 위에
  // 걸터앉아 있어서, 넉넉히 잡으면 그것을 음자리표로 잘못 본다.
  const lo = top - spacing * 2.9, hi = bottom + spacing * 2.5;
  const near = bs.filter(b => b.x0 >= left - spacing * 0.5 &&
    b.x0 < left + spacing * 7 && b.y0 > lo && b.y1 < hi);
  if (!near.length) return reg;

  near.sort((a, b) => a.x0 - b.x0);
  let clef = null;
  for (const b of near.slice(0, 4)) if (!clef || b.h > clef.h) clef = b;
  if (!clef || clef.h < h * 0.8) return reg;
  reg.clef = clef;
  let edge = clef.x1;

  const rest = bs.filter(b => b.x0 >= Math.max(edge - spacing * 0.2,
    left - spacing * 0.5) && b.y0 > lo && b.y1 < hi)
    .sort((a, b) => a.x0 - b.x0);
  for (const b of rest) {
    if (b.x0 > edge + spacing * 1.3) break;
    const tall = b.h >= spacing * 1.1 && b.h <= spacing * 3.2;
    if (tall && b.w <= spacing * 1.15) {
      reg.keysig.push(b);
      edge = Math.max(edge, b.x1);
    }
  }

  // 박자표 — 4/4 처럼 포개진 꼴이라 덩어리가 둘이다. 창을 먼저 정해 놓고
  // 한꺼번에 고른다.
  const w0 = edge, w1 = edge + spacing * 2.0;
  for (const b of rest) {
    if (!(b.x0 > w0 && b.x0 <= w1)) continue;
    if (b.y0 >= top - spacing * 0.5 && b.y1 <= bottom + spacing * 0.5 &&
        b.w <= spacing * 1.6) {
      reg.timesig.push(b);
      edge = Math.max(edge, b.x1);
    }
  }
  reg.xEnd = Math.round(edge);
  return reg;
}

/* 조표는 단마다 같은 자리에 같은 모양으로 되풀이된다. 가장 또렷하게 잡힌
   단 하나에서 자리를 재어 두고 나머지 단에 그대로 옮겨 쓴다. 단마다 따로
   더듬으면 한두 단이 꼭 어긋난다. */
function planKeysig(regions, lefts) {
  let best = null, bestLeft = 0;
  regions.forEach((reg, i) => {
    if (reg.keysig.length && (!best || reg.keysig.length > best.keysig.length)) {
      best = reg; bestLeft = lefts[i];
    }
  });
  if (!best) return { ok: false, dx0: 0, dx1: 0, count: 0 };
  const x0 = Math.min(...best.keysig.map(b => b.x0));
  const x1 = Math.max(...best.keysig.map(b => b.x1));
  return { ok: true, dx0: Math.round(x0 - bestLeft),
           dx1: Math.round(x1 - bestLeft), count: best.keysig.length };
}

// ------------------------------------------------------------ 음표 머리

/* 오선에 걸쳐 있는 덩어리만 1 로 칠한 판.

   음표는 오선에 붙어 있다. 가사와 코드 글자는 오선에서 떨어진 외딴
   덩어리라 여기서 걸러진다. */
function staffMask(bm, bs, top, bottom) {
  const m = new Uint8Array(bm.w * bm.h);
  for (const b of bs) {
    if (b.y1 <= top || b.y0 >= bottom) continue;
    for (const [y, a, c] of b.runs) m.fill(1, y * bm.w + a, y * bm.w + c);
  }
  return m;
}

/* 음표 머리일 법한 가로 구간 후보들.

   속이 빈 머리는 가운데가 하얘서 한 줄에 토막이 둘로 나온다. 그렇다고
   가까운 토막을 무턱대고 이어 붙이면 바로 왼쪽의 임시표까지 한 덩어리가
   된다. 그래서 하나짜리와 둘·셋 이어 붙인 것을 모두 후보로 내놓는다. */
function* candidates(bm, y, x0, x1, gap) {
  const rs = bm.runs(y, x0, x1);
  for (let i = 0; i < rs.length; i++) {
    const [a, b] = rs[i];
    yield [a, b];
    let acc = b;
    for (let j = i + 1; j <= i + 2 && j < rs.length; j++) {
      if (rs[j][0] - acc > gap) break;
      acc = rs[j][1];
      yield [a, acc];
    }
  }
}

/* 그 가로 범위에서 잉크가 걸쳐 있는 세로 구간.
   기둥을 피하려고 가운데 절반만 본다. */
function vextent(bm, x0, x1, ylo, yhi) {
  const m = ((x1 - x0) / 4) | 0;
  const a = x0 + m, b = x1 - m;
  let top = -1, bot = -1;
  const lo = Math.max(0, ylo | 0), hi = Math.min(bm.h, yhi | 0);
  for (let y = lo; y < hi; y++) {
    const base = y * bm.w;
    let any = false;
    for (let x = a; x < b; x++) if (bm.px[base + x]) { any = true; break; }
    if (any) { if (top < 0) top = y; bot = y + 1; }
  }
  return top >= 0 ? [top, bot] : [0, 0];
}

/* 음표는 줄 위나 칸 안에만 놓이므로 반칸 격자의 y 에서만 찾으면 된다.
   빔을 음표로 잘못 보지 않도록 가로 길이와 세로 길이를 함께 잰다. */
function findHeads(bm, lines, spacing, x0, x1, mask, above, below) {
  const half = spacing / 2;
  const bottom = lines[4];
  const wmin = spacing * 0.92, wmax = spacing * 1.95;
  const hmin = spacing * 0.62, hmax = spacing * 1.45;
  const gap = (spacing * 0.62) | 0;
  const up = above === undefined ? 8 : above;
  const dn = below === undefined ? 8 : below;

  const out = [];
  const top5 = Math.round((lines[4] - lines[0]) / half);
  for (let step = -dn; step <= top5 + up; step++) {
    const y = Math.round(bottom - step * half);
    if (y < 1 || y >= bm.h - 1) continue;
    for (const [a, b] of candidates(bm, y, x0, x1, gap)) {
      if (b - a < wmin || b - a > wmax) continue;
      const cx = (a + b) >> 1;
      if (mask && !mask[y * bm.w + cx] && !mask[y * bm.w + a + 2]) continue;
      const [t, bo] = vextent(bm, a, b, y - spacing * 1.1, y + spacing * 1.1);
      if (bo - t < hmin || bo - t > hmax) continue;
      if (Math.abs((t + bo) / 2 - y) > spacing * 0.42) continue;
      const ink = bm.inkIn(a, y - half * 0.85, b, y + half * 0.85);
      const dens = ink / Math.max(1, (b - a) * half * 1.7);
      if (dens < 0.45) continue;        // 빔 모서리처럼 듬성한 곳은 아니다
      out.push({ x: cx, y, step, filled: dens > 0.74, x0: a, x1: b,
                 w: b - a });
    }
  }
  return dedupeHeads(out, spacing);
}

function dedupeHeads(heads, spacing) {
  heads.sort((p, q) => (p.x - q.x) || (p.y - q.y));
  const kept = [];
  for (const h of heads) {
    let hit = -1;
    for (let i = 0; i < kept.length; i++) {
      if (Math.abs(kept[i].x - h.x) < spacing * 0.8 &&
          Math.abs(kept[i].y - h.y) < spacing * 0.6) { hit = i; break; }
    }
    if (hit < 0) kept.push(h);
    else if (h.w > kept[hit].w) kept[hit] = h;
  }
  return kept;
}

// ------------------------------------------------------- 움직일 것 가리기

const MOVE = 'move', STAY = 'stay';

function imgClassify(bs, heads, spacing, top, bottom) {
  const out = new Array(bs.length);
  const lo = top - spacing * 0.5, hi = bottom + spacing * 0.5;
  const spans = heads.map(h => [h.x0 - spacing * 1.6, h.x1 + spacing * 1.6, h.y]);

  const besideNote = b => spans.some(([a, c, hy]) =>
    b.x1 > a && b.x0 < c && Math.abs((b.y0 + b.y1) / 2 - hy) < spacing * 3);

  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    if (heads.some(h => b.x0 <= h.x && h.x < b.x1 && b.y0 <= h.y && h.y < b.y1)) {
      out[i] = MOVE;                    // 음표가 든 덩어리
      continue;
    }
    if (b.y1 > lo && b.y0 < hi) {
      // 오선에 걸친 것 중 음표가 없는 것은 모두 제자리다 —
      // 음자리표, 조표, 박자표, 세로줄, 쉼표.
      out[i] = STAY;
      continue;
    }
    // 오선 밖. 가사와 코드가 여기 있으므로 기본은 제자리이고, 음표 바로
    // 곁에 붙은 것(이음줄, 점)만 따라 옮긴다.
    if (!besideNote(b)) { out[i] = STAY; continue; }
    const gap = Math.min(Math.abs(b.y1 - lo), Math.abs(b.y0 - hi));
    if (gap > spacing * 2.2) { out[i] = STAY; continue; }
    const fillRatio = b.area / Math.max(1, b.w * b.h);
    const tiny = b.w <= spacing * 0.55 && b.h <= spacing * 0.55;
    const arc = b.w >= spacing * 2.2 && b.h <= spacing * 2.6 && fillRatio <= 0.34;
    out[i] = (tiny || arc) ? MOVE : STAY;
  }
  return out;
}

// ----------------------------------------------------------------- 밀기

function ledgerSteps(step) {
  const out = [];
  if (step > 8) for (let s = 10; s <= step; s += 2) out.push(s);
  else if (step < 0) for (let s = -2; s >= step; s -= 2) out.push(s);
  return out;
}

/* 덧줄을 지운다. 음을 옮기면 필요한 덧줄이 달라지므로 다시 그려야 한다. */
function eraseLedgers(bm, heads, lines, spacing, thick) {
  const half = spacing / 2, bottom = lines[4];
  for (const h of heads) {
    for (const st of ledgerSteps(h.step)) {
      const y = Math.round(bottom - st * half);
      for (let dy = -thick; dy <= thick; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= bm.h) continue;
        for (const [a, b] of bm.runs(yy, h.x0 - spacing, h.x1 + spacing)) {
          if (b - a > spacing * 3) continue;
          const [t, bo] = bm.vrun((a + b) >> 1, yy, thick * 3);
          if (bo - t <= thick * 2 + 1) bm.fill(a, t, b, bo, 0);
        }
      }
    }
  }
}

function drawLedgers(bm, heads, lines, spacing, thick, dySteps) {
  const half = spacing / 2, bottom = lines[4];
  const over = (spacing * 0.30) | 0;
  for (const h of heads) {
    for (const st of ledgerSteps(h.step + dySteps)) {
      const y = Math.round(bottom - st * half) - (thick >> 1);
      bm.hline(y, h.x0 - over, h.x1 + over, thick);
    }
  }
}

/* 옮길 덩어리를 통째로 민다. 먼저 다 지우고 나서 다시 찍는다 —
   지우기와 찍기를 섞으면 먼저 찍은 것을 뒤에 지우는 일이 생긴다. */
function shiftMusic(bm, bs, kinds, dy) {
  const moving = bs.filter((_, i) => kinds[i] === MOVE);
  for (const b of moving) {
    for (const [y, a, c] of b.runs) bm.px.fill(0, y * bm.w + a, y * bm.w + c);
  }
  for (const b of moving) {
    for (const [y, a, c] of b.runs) {
      const ny = y + dy;
      if (ny >= 0 && ny < bm.h) bm.px.fill(1, ny * bm.w + a, ny * bm.w + c);
    }
  }
}

function drawStaff(bm, lines, thick, x0, x1) {
  for (const ly of lines) bm.hline(Math.round(ly) - (thick >> 1), x0, x1, thick);
}

// ------------------------------------------------------------- 기호 본뜨기

/* 덩어리 하나만 오려 낸 작은 그림. 악보에 있는 ♯ 을 그대로 쓰려는 것이다. */
function blobStamp(b) {
  const out = new Bitmap(b.w, b.h);
  for (const [y, a, c] of b.runs) {
    out.px.fill(1, (y - b.y0) * out.w + (a - b.x0),
                (y - b.y0) * out.w + (c - b.x0));
  }
  return out;
}

/* 악보에 없는 기호는 글꼴에서 찍어 온다. 글꼴에 그 글자가 없으면 null. */
function fontStamp(ch, pxHeight) {
  const size = Math.max(12, Math.round(pxHeight * 1.9));
  const cv = document.createElement('canvas');
  cv.width = size * 2; cv.height = size * 2;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#000';
  ctx.font = `${size}px "Apple Symbols", "Arial Unicode MS", serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(ch, size * 0.5, size * 1.4);
  const bm = Bitmap.fromImageData(ctx.getImageData(0, 0, cv.width, cv.height));
  const bs = blobs(bm, 0, bm.h);
  if (!bs.length) return null;
  const x0 = Math.min(...bs.map(b => b.x0)), x1 = Math.max(...bs.map(b => b.x1));
  const y0 = Math.min(...bs.map(b => b.y0)), y1 = Math.max(...bs.map(b => b.y1));
  if (x1 - x0 < 2 || y1 - y0 < 4) return null;
  const out = new Bitmap(x1 - x0, y1 - y0);
  for (let y = y0; y < y1; y++) {
    out.px.set(bm.px.subarray(y * bm.w + x0, y * bm.w + x1), (y - y0) * out.w);
  }
  return out;
}

/* 작은 그림을 (x, yAnchor) 에 찍는다. anchor 는 세로 기준점의 비율. */
function stamp(bm, s, x, yAnchor, anchor) {
  const y0 = Math.round(yAnchor - s.h * (anchor === undefined ? 0.5 : anchor));
  for (let yy = 0; yy < s.h; yy++) {
    const ty = y0 + yy;
    if (ty < 0 || ty >= bm.h) continue;
    const base = ty * bm.w;
    for (let xx = 0; xx < s.w; xx++) {
      if (s.px[yy * s.w + xx]) {
        const tx = x + xx;
        if (tx >= 0 && tx < bm.w) bm.px[base + tx] = 1;
      }
    }
  }
}

/* 악보 안에서 ♯ 이나 ♭ 처럼 생긴 덩어리를 하나 찾아 본뜬다 */
function findAccidentalStamp(bs, spacing, wantFlat) {
  let best = null;
  for (const b of bs) {
    if (b.h < spacing * 1.1 || b.h > spacing * 2.8) continue;
    if (b.w < spacing * 0.35 || b.w > spacing * 1.05) continue;
    const ratio = b.w / Math.max(1, b.h);
    const f = b.area / Math.max(1, b.w * b.h);
    const good = wantFlat ? (ratio < 0.52 && f > 0.25 && f < 0.62)
                          : (ratio > 0.45 && ratio < 0.95 && f > 0.2 && f < 0.6);
    if (good && (!best || b.area > best.area)) best = b;
  }
  return best ? blobStamp(best) : null;
}

/* 한 단의 조표를 지우고 새 조의 것을 그린다.
   오선을 이미 지워 둔 그림이라, 조표 자리에는 조표 말고 아무것도 없다. */
function applyKeysig(bm, plan, left, lines, spacing, newFifths, sharp, flat) {
  const want = Math.abs(newFifths);
  const glyph = newFifths > 0 ? sharp : flat;
  if (!plan.ok) return false;
  if (want && !glyph) return false;

  const pad = Math.max(2, (spacing * 0.2) | 0);
  bm.fill(left + plan.dx0 - pad, lines[0] - spacing * 3.0,
          left + plan.dx1 + pad, lines[4] + spacing * 2.6, 0);
  if (!want) return true;

  const half = spacing / 2, bottom = lines[4];
  const steps = newFifths > 0 ? IMG_SHARP_STEPS : IMG_FLAT_STEPS;
  const anchor = newFifths > 0 ? 0.5 : 0.72;   // ♭ 은 아래쪽 배가 기준
  const stepX = glyph.w + Math.max(2, (spacing * 0.12) | 0);
  let x = left + plan.dx0;
  for (let i = 0; i < want; i++) {
    stamp(bm, glyph, x, Math.round(bottom - steps[i] * half), anchor);
    x += stepX;
  }
  return true;
}

// ------------------------------------------------------------- 임시표

/* 덩어리 모양으로 ♯·♭·♮ 을 가린다. ♭ 은 아래쪽에만 배가 불룩해 무게
   중심이 아래로 쏠린다. */
function accKind(b, spacing) {
  if (b.h < spacing * 1.0 || b.h > spacing * 3.5) return null;
  if (b.w < spacing * 0.28 || b.w > spacing * 1.35) return null;
  const mid = (b.y0 + b.y1) / 2;
  let lower = 0;
  for (const [y, a, c] of b.runs) if (y >= mid) lower += c - a;
  if (lower / Math.max(1, b.area) > 0.68) return -1;
  return b.w > spacing * 0.42 ? 1 : 0;
}

/* 음표 바로 왼쪽에 붙은 ♯·♭·♮ 을 찾아 그 음에 매단다 */
function findAccidentals(bs, heads, spacing) {
  const out = [];
  const used = new Set();
  for (const h of heads) {
    let best = null, bestd = 1e9, besti = -1;
    for (let i = 0; i < bs.length; i++) {
      if (used.has(i)) continue;
      const b = bs[i];
      if (b.x1 > h.x0 + spacing * 0.15 || b.x1 < h.x0 - spacing * 2.4) continue;
      if (Math.abs((b.y0 + b.y1) / 2 - h.y) > spacing * 0.75) continue;
      if (accKind(b, spacing) === null) continue;
      const d = h.x0 - b.x1;
      if (d < bestd) { best = b; bestd = d; besti = i; }
    }
    if (best) {
      used.add(besti);
      out.push({ blob: best, head: h, alter: accKind(best, spacing) });
    }
  }
  return out;
}

/* 세로줄의 x 자리들. 임시표가 어느 마디까지 살아 있는지 알려면 필요하다. */
function findBarlines(bs, spacing, top, bottom) {
  const h = bottom - top;
  return bs.filter(b => b.w <= spacing * 0.55 && b.h >= h * 0.85 &&
    b.y0 <= top + spacing * 0.6 && b.y1 >= bottom - spacing * 0.6)
    .map(b => (b.x0 + b.x1) >> 1).sort((a, b) => a - b);
}

/* 음마다 새 조에서 어떤 임시표가 필요한지 정한다.

   같은 자리를 밀어 올리는 것만으로는 모자라다. 조가 바뀌면 조표가 돌봐
   주는 음이 달라지기 때문이다. 다 장조의 F♯ 을 2도 올리면 라 장조의
   G♯ 이라 똑같이 ♯ 이 붙지만, 다 장조의 B♭ 을 2도 올리면 라 장조의
   C 가 되어 ♮ 이 필요해진다. */
function planAccidentals(heads, accs, barlines, oldFifths, newFifths, iv) {
  const byHead = new Map(accs.map(a => [a.head, a.alter]));
  const marks = [...heads].sort((a, b) => a.x - b.x);
  const measureOf = x => barlines.reduce((n, bx) => n + (x > bx ? 1 : 0), 0);

  const carried = new Map();      // 한 마디 안에서 울리는 변화표
  const written = new Map();
  const out = [];
  for (const h of marks) {
    const m = measureOf(h.x);
    const letter = stepLetter(h.step);
    let alter;
    if (byHead.has(h)) {
      alter = byHead.get(h);
      carried.set(m + ':' + h.step, alter);
    } else if (carried.has(m + ':' + h.step)) {
      alter = carried.get(m + ':' + h.step);
    } else {
      alter = keyAlter(oldFifths, letter);
    }
    const [nl, na] = transposePitch(letter, alter, iv, true);
    const newStep = h.step + iv.steps;
    let want = na !== keyAlter(newFifths, nl) ? na : null;
    const key = m + ':' + newStep;
    if (want !== null && written.get(key) === want) want = null;
    else if (want !== null) written.set(key, want);
    out.push([h, want]);
  }
  return out;
}
