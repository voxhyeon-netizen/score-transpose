/* ===========================================================================
   그림 악보를 다루기 위한 바탕 연장 (브라우저판)

   쪽이 통째로 그림인 악보는 고칠 그리기 명령이 없다. 픽셀뿐이다.
   그래서 오선을 지우고, 남은 잉크를 덩어리로 나누고, 음표가 든 덩어리를
   통째로 밀어 올린 뒤 오선을 다시 긋는다.

   맥용(scorelib/imgbits.py)과 같은 일을 한다. 고칠 때는 양쪽을 같이
   고쳐야 한다.

   여기 있는 것은 셈과 모양에 관한 것뿐이고, 음악에 관한 판단은 하지 않는다.
   =========================================================================== */

/* 이보다 어두우면 잉크로 본다. 깨끗한 악보라 경계가 뚜렷해 이 값이면 충분하다 */
const INK_CUT = 200;

/* 흑백 한 장. px 의 1 이 잉크다. */
function Bitmap(w, h, px) {
  this.w = w;
  this.h = h;
  this.px = px || new Uint8Array(w * h);
}

/* 캔버스에서 읽어 온 화소를 흑백으로 바꾼다 */
Bitmap.fromImageData = function (img) {
  const { width: w, height: h, data } = img;
  const px = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < px.length; i++, j += 4) {
    const a = data[j + 3];
    // 투명한 자리는 흰 바탕으로 본다
    const v = a < 128 ? 255 : (data[j] + data[j + 1] + data[j + 2]) / 3;
    if (v < INK_CUT) px[i] = 1;
  }
  return new Bitmap(w, h, px);
};

/* 색이 도는 획(색펜 손글씨)은 지운 채로 읽어 온다.
   초록 글씨가 코드 위에 걸치면 둘이 한 덩어리로 보이기 때문이다. */
Bitmap.fromImageDataNoColor = function (img, sat) {
  const { width: w, height: h, data } = img;
  const S = sat === undefined ? 42 : sat;
  const px = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < px.length; i++, j += 4) {
    if (data[j + 3] < 128) continue;
    const r = data[j], g = data[j + 1], b = data[j + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx - mn > S) continue;              // 색이 있는 획 → 지운다
    if ((r + g + b) / 3 < INK_CUT) px[i] = 1;
  }
  return new Bitmap(w, h, px);
};

Bitmap.prototype.copy = function () {
  return new Bitmap(this.w, this.h, this.px.slice());
};

Bitmap.prototype.get = function (x, y) {
  if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
  return this.px[y * this.w + x];
};

/* 그 줄에서 잉크가 이어진 구간들 */
Bitmap.prototype.runs = function (y, x0, x1) {
  const out = [];
  if (y < 0 || y >= this.h) return out;
  const a0 = x0 === undefined ? 0 : Math.max(0, x0);
  const a1 = x1 === undefined ? this.w : Math.min(this.w, x1);
  const base = y * this.w;
  let start = -1;
  for (let x = a0; x < a1; x++) {
    if (this.px[base + x]) {
      if (start < 0) start = x;
    } else if (start >= 0) {
      out.push([start, x]);
      start = -1;
    }
  }
  if (start >= 0) out.push([start, a1]);
  return out;
};

/* (x, y) 를 지나는 세로 잉크 토막의 [위, 아래+1] */
Bitmap.prototype.vrun = function (x, y, limit) {
  const lim = limit || 400;
  if (!this.get(x, y)) return [y, y];
  let top = y;
  while (top > 0 && this.px[(top - 1) * this.w + x] && y - top < lim) top--;
  let bot = y + 1;
  while (bot < this.h && this.px[bot * this.w + x] && bot - y < lim) bot++;
  return [top, bot];
};

/* 네모 안의 잉크 수 */
Bitmap.prototype.inkIn = function (x0, y0, x1, y1) {
  // 소수점이 섞여 들어오면 배열 자리가 어긋나 늘 0 이 나온다. 반드시 정수로.
  const a = Math.max(0, Math.floor(x0)), b = Math.min(this.w, Math.ceil(x1));
  const c = Math.max(0, Math.floor(y0)), d = Math.min(this.h, Math.ceil(y1));
  let n = 0;
  for (let y = c; y < d; y++) {
    const base = y * this.w;
    for (let x = a; x < b; x++) if (this.px[base + x]) n++;
  }
  return n;
};

Bitmap.prototype.fill = function (x0, y0, x1, y1, v) {
  const a = Math.max(0, Math.floor(x0)), b = Math.min(this.w, Math.ceil(x1));
  const c = Math.max(0, Math.floor(y0)), d = Math.min(this.h, Math.ceil(y1));
  if (b <= a) return;
  const val = v === undefined ? 0 : v;
  for (let y = c; y < d; y++) this.px.fill(val, y * this.w + a, y * this.w + b);
};

Bitmap.prototype.hline = function (y, x0, x1, thick) {
  this.fill(x0, y, x1, y + (thick || 1), 1);
};

/* 캔버스에 그릴 수 있는 화소로 되돌린다 */
Bitmap.prototype.toImageData = function (ctx) {
  const img = ctx.createImageData(this.w, this.h);
  const d = img.data;
  for (let i = 0, j = 0; i < this.px.length; i++, j += 4) {
    const c = this.px[i] ? 0 : 255;
    d[j] = d[j + 1] = d[j + 2] = c;
    d[j + 3] = 255;
  }
  return img;
};

// --------------------------------------------------------------- 오선 지우기

/* 오선 한 줄의 두께. 가장 흔한 세로 토막 길이를 쓴다. */
function measureThickness(bm, lines) {
  const counts = new Map();
  for (const ly of lines) {
    const cy = Math.round(ly);
    for (let x = 0; x < bm.w; x += 7) {
      if (!bm.get(x, cy)) continue;
      const [t, b] = bm.vrun(x, cy, 12);
      const n = b - t;
      if (n <= 10) counts.set(n, (counts.get(n) || 0) + 1);
    }
  }
  let best = 1, bestN = 0;
  for (const [n, c] of counts) if (c > bestN) { best = n; bestN = c; }
  return best;
}

/* 오선 다섯 줄을 지운다. 줄에 걸친 기호는 남긴다.

   어떤 점이 오선인지 기호인지는 그 점을 지나는 세로 잉크 토막의 길이로
   가른다. 기준을 느슨하게 잡으면 안 된다 — 칸 안에 놓인 온음표는 위아래
   얇은 획이 바로 옆 오선에 닿아 있어서, 함께 지워지면 음표가 좌우 두
   조각으로 갈라진다. */
function removeStaffLines(bm, lines, thick, slack) {
  const keep = thick + (slack === undefined ? 2 : slack);
  for (const ly of lines) {
    const cy = Math.round(ly);
    for (let x = 0; x < bm.w; x++) {
      let hit = -1;
      for (let dy = -thick; dy <= thick; dy++) {
        if (bm.get(x, cy + dy)) { hit = cy + dy; break; }
      }
      if (hit < 0) continue;
      const [top, bot] = bm.vrun(x, hit, keep + 2);
      if (bot - top <= keep) {
        for (let y = top; y < bot; y++) bm.px[y * bm.w + x] = 0;
      }
    }
  }
}

// ------------------------------------------------------------ 덩어리 나누기

/* 이어진 잉크 한 덩어리 */
function Blob_() {
  this.x0 = 1 << 30; this.y0 = 1 << 30;
  this.x1 = -1; this.y1 = -1;
  this.area = 0;
  this.runs = [];
}
Object.defineProperty(Blob_.prototype, 'w', { get() { return this.x1 - this.x0; } });
Object.defineProperty(Blob_.prototype, 'h', { get() { return this.y1 - this.y0; } });

Blob_.prototype.add = function (y, a, b) {
  this.runs.push([y, a, b]);
  this.area += b - a;
  if (a < this.x0) this.x0 = a;
  if (b > this.x1) this.x1 = b;
  if (y < this.y0) this.y0 = y;
  if (y + 1 > this.y1) this.y1 = y + 1;
};

/* 그 구역 안에서 이어진 덩어리들.

   픽셀 하나하나가 아니라 줄 토막 단위로 잇는다. 토막은 픽셀보다 수백 배
   적어서 훨씬 빠르다. */
function blobs(bm, y0, y1, x0, x1) {
  const a0 = Math.max(0, y0 | 0), a1 = Math.min(bm.h, y1 | 0);
  const bx0 = x0 === undefined ? 0 : x0;
  const bx1 = x1 === undefined ? bm.w : x1;

  const parent = [];
  const runs = [];
  function find(i) {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }

  let prev = [];
  for (let y = a0; y < a1; y++) {
    const cur = [];
    for (const [a, b] of bm.runs(y, bx0, bx1)) {
      const idx = runs.length;
      runs.push([y, a, b]);
      parent.push(idx);
      for (const [pa, pb, pid] of prev) {
        if (pb < a || b < pa) continue;     // 모서리끼리 닿아도 하나로 본다
        union(idx, pid);
      }
      cur.push([a, b, idx]);
    }
    prev = cur;
  }

  const groups = new Map();
  for (let i = 0; i < runs.length; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) { g = new Blob_(); groups.set(r, g); }
    g.add(runs[i][0], runs[i][1], runs[i][2]);
  }
  return [...groups.values()];
}
