/* ===========================================================================
   악보 이조 엔진 — 1부: PDF 그리기 명령 읽고 고치기
   (맥용 파이썬판 scorelib/pdfops.py 를 그대로 옮긴 것)

   악보 PDF 는 모든 그리기 명령이 페이지 콘텐츠 스트림에 평평하게 나열돼
   있다. 그 스트림을 토큰으로 쪼갠 뒤, 각 요소가 어떤 토큰의 y 값을 쓰는지
   기억해 둔다. 음표를 올리거나 내릴 때 그 숫자만 바꿔 다시 이어 붙이면
   원본 레이아웃을 그대로 둔 채 이조가 된다.
   =========================================================================== */

const LATIN1 = new TextDecoder('latin1');

function b2s(bytes) { return LATIN1.decode(bytes); }

function s2b(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

// ------------------------------------------------------------------ 토큰

class Token {
  constructor(kind, raw, value) {
    this.kind = kind;       // 'num' | 'name' | 'str' | 'hex' | 'delim' | 'op' | 'ws'
    this.raw = raw;         // 원본 문자열 (고치지 않으면 그대로 다시 쓴다)
    this.value = value === undefined ? null : value;
  }
  setNumber(v) {
    this.value = v;
    this.raw = formatNumber(v);
  }
}

function formatNumber(v) {
  if (Number.isInteger(v) && Math.abs(v) < 1e9) return String(v);
  let s = v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return (s === '' || s === '-') ? '0' : s;
}

// 숫자 / 이름(/TT1) / 문자열 / 16진 / 구분자 / 연산자
const TOKEN_RE = /([-+]?(?:\d+\.\d*|\.\d+|\d+))|(\/[^\s/\[\]<>(){}%]*)|(\()|(<[0-9A-Fa-f\s]*>)|([\[\]{}])|([A-Za-z'"*][A-Za-z0-9'"*]*)/g;

function readLiteralString(s, i) {
  const start = i;
  i += 1;
  let depth = 1;
  while (i < s.length && depth) {
    const c = s.charCodeAt(i);
    if (c === 0x5c) { i += 2; continue; }
    if (c === 0x28) depth += 1;
    else if (c === 0x29) depth -= 1;
    i += 1;
  }
  return [s.slice(start, i), i];
}

function tokenize(data) {
  const s = typeof data === 'string' ? data : b2s(data);
  const tokens = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    TOKEN_RE.lastIndex = i;
    const m = TOKEN_RE.exec(s);
    if (!m) { tokens.push(new Token('ws', s.slice(i))); break; }
    if (m.index > i) tokens.push(new Token('ws', s.slice(i, m.index)));
    if (m[3] !== undefined) {           // 문자열 시작
      const [raw, j] = readLiteralString(s, m.index);
      tokens.push(new Token('str', raw));
      i = j;
      continue;
    }
    const raw = m[0];
    let kind, value;
    if (m[1] !== undefined) { kind = 'num'; value = parseFloat(raw); }
    else if (m[2] !== undefined) kind = 'name';
    else if (m[4] !== undefined) kind = 'hex';
    else if (m[5] !== undefined) kind = 'delim';
    else kind = 'op';
    tokens.push(new Token(kind, raw, value));
    i = m.index + raw.length;
  }
  return tokens;
}

function serialize(tokens) {
  let out = '';
  for (const t of tokens) out += t.raw;
  return out;
}

// ------------------------------------------------------------- 그리기 요소

class Element {
  constructor(kind) {
    this.kind = kind;          // 'text' | 'stroke' | 'fill'
    this.x = 0; this.y = 0;
    this.char = '';
    this.codes = [];
    this.font = '';
    this.size = 0;
    this.pts = [];
    this.hasCurve = false;
    this.lineWidth = 0;
    this.yRefs = [];           // [[Token, 배율], …]
    this.xRefs = [];
    this.opToken = null;
    this.argToken = null;
    this.hidden = false;
    this.role = '';
    this.uni = 0;
    this.alter = null;
    this.system = -1;
  }
  get x0() { return this.pts.length ? Math.min(...this.pts.map(p => p[0])) : this.x; }
  get x1() { return this.pts.length ? Math.max(...this.pts.map(p => p[0])) : this.x; }
  get y0() { return this.pts.length ? Math.min(...this.pts.map(p => p[1])) : this.y; }
  get y1() { return this.pts.length ? Math.max(...this.pts.map(p => p[1])) : this.y; }
  get width() { return this.x1 - this.x0; }
  get height() { return this.y1 - this.y0; }

  shift(dy) {
    for (const [tok, scale] of this.yRefs) tok.setNumber(tok.value + dy * scale);
    this.y += dy;
    this.pts = this.pts.map(([px, py]) => [px, py + dy]);
  }
  shiftX(dx) {
    for (const [tok, scale] of this.xRefs) tok.setNumber(tok.value + dx * scale);
    this.x += dx;
    this.pts = this.pts.map(([px, py]) => [px + dx, py]);
  }
  /* 이 요소만 지운다. 좌표를 지면 밖으로 옮기는 방법은 쓰지 않는다. 한
     덩어리로 찍히는 글자들은 자리 숫자를 같이 쓰기 때문에, 하나를 옮기면
     옆 글자까지 딸려 간다. 대신 글자는 '보이지 않게 찍기'(Tr 3)로 바꾸고
     — 이러면 뒤 글자의 자리는 그대로다 — 선과 면은 칠하지 않는 연산자로. */
  erase() {
    if (this.hidden) return;
    if (this.kind === 'text') {
      if (!this.argToken || !this.opToken) return;
      if (!this.argToken.raw.startsWith('3 Tr ')) {
        this.argToken.raw = '3 Tr ' + this.argToken.raw;
        this.opToken.raw = this.opToken.raw + ' 0 Tr';
      }
    } else {
      if (!this.opToken) return;
      this.opToken.raw = 'n';
    }
    this.hidden = true;
  }
}

/* 여러 요소를 같은 거리만큼 옮긴다. 한 번에 찍힌 글자 묶음은 자리 숫자를
   함께 쓰므로, 숫자는 한 번씩만 고친다. */
function shiftTogether(elements, dy) {
  const done = new Set();
  for (const e of elements) {
    for (const [tok, scale] of e.yRefs) {
      if (done.has(tok)) continue;
      done.add(tok);
      tok.setNumber(tok.value + dy * scale);
    }
  }
  for (const e of elements) {
    e.y += dy;
    e.pts = e.pts.map(([px, py]) => [px, py + dy]);
  }
}

// ------------------------------------------------------------------ 행렬

function matMul(a, b) {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

function applyM(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function invert(m) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 1, 0, 0];
  return [d / det, -b / det, -c / det, a / det,
          (c * f - d * e) / det, (b * e - a * f) / det];
}

/* 스트림이 끝난 자리에서 바깥(깊이 0)에 남아 있는 변환 행렬. 어떤 PDF 는
   맨 앞에서 좌표계를 통째로 뒤집어 놓는다. 그런 문서에 그림을 덧붙이려면
   이 변환을 되돌려야 한다. */
function baseCtm(tokens) {
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let operands = [];
  for (const tok of tokens) {
    if (tok.kind === 'ws') continue;
    if (tok.kind !== 'op') { operands.push(tok); continue; }
    const op = tok.raw;
    const nums = operands.filter(t => t.kind === 'num');
    if (op === 'q') stack.push(ctm);
    else if (op === 'Q') { if (stack.length) ctm = stack.pop(); }
    else if (op === 'cm' && nums.length >= 6) {
      ctm = matMul(nums.slice(-6).map(t => t.value), ctm);
    }
    operands = [];
  }
  return stack.length ? stack[0] : ctm;
}

function qDepth(tokens) {
  let d = 0;
  for (const t of tokens) {
    if (t.kind === 'op') { if (t.raw === 'q') d++; else if (t.raw === 'Q') d--; }
  }
  return d;
}

// --------------------------------------------------------------- 요소 추출

const ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };

function unescapePdf(body) {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '\\' && i + 1 < body.length) {
      const nx = body[i + 1];
      if (ESCAPES[nx] !== undefined) { out += ESCAPES[nx]; i += 2; continue; }
      if (nx >= '0' && nx <= '7') {
        let j = i + 1, digits = '';
        while (j < body.length && digits.length < 3 && body[j] >= '0' && body[j] <= '7') {
          digits += body[j]; j++;
        }
        out += String.fromCharCode(parseInt(digits, 8) & 0xff);
        i = j; continue;
      }
      i += 1; continue;
    }
    out += c; i += 1;
  }
  return out;
}

function decodeHexStr(raw) {
  let body = raw.slice(1, -1).replace(/\s+/g, '');
  if (body.length % 2) body += '0';
  let out = '';
  for (let i = 0; i < body.length; i += 2) {
    out += String.fromCharCode(parseInt(body.slice(i, i + 2), 16));
  }
  return out;
}

function extractElements(tokens, cidFonts, widths) {
  cidFonts = cidFonts || new Set();
  widths = widths || new Map();
  const elements = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let operands = [];
  let lineWidth = 1.0;

  let pathPts = [], pathYRefs = [], pathXRefs = [], pathHasCurve = false, pathOpen = false;
  let inText = false, textFont = '', textFs = 1.0;
  let tm = [1, 0, 0, 1, 0, 0], tmTokens = null, tx = 0, charSp = 0, wordSp = 0;
  let cmYRef = null, cmXRef = null;

  const W = (font, code) => {
    const w = widths.get(font + '|' + code);
    return w === undefined ? (widths.get(font + '|-1') ?? 0.5) : w;
  };

  for (const tok of tokens) {
    if (tok.kind === 'ws') continue;
    if (tok.kind !== 'op') { operands.push(tok); continue; }
    const op = tok.raw;
    const nums = operands.filter(t => t.kind === 'num');

    if (op === 'q') {
      stack.push([ctm, cmYRef, cmXRef, lineWidth]);
    } else if (op === 'Q') {
      if (stack.length) [ctm, cmYRef, cmXRef, lineWidth] = stack.pop();
    } else if (op === 'cm' && nums.length >= 6) {
      const m = nums.slice(-6).map(t => t.value);
      const parent = ctm;
      ctm = matMul(m, ctm);
      // 이 숫자는 바깥 좌표계 단위로 적혀 있으므로, 쪽 기준 거리를 주려면
      // 바깥 변환의 배율로 나눠야 한다.
      cmYRef = [nums[nums.length - 1], parent[3] ? 1 / parent[3] : 1];
      cmXRef = [nums[nums.length - 2], parent[0] ? 1 / parent[0] : 1];
    } else if (op === 'w' && nums.length) {
      lineWidth = nums[nums.length - 1].value;
    } else if (op === 'Tc' && nums.length) {
      charSp = nums[nums.length - 1].value;
    } else if (op === 'Tw' && nums.length) {
      wordSp = nums[nums.length - 1].value;
    } else if (op === 'BT') {
      inText = true; tm = [1, 0, 0, 1, 0, 0]; tmTokens = null; tx = 0;
    } else if (op === 'Tf') {
      const names = operands.filter(t => t.kind === 'name');
      if (names.length) textFont = names[names.length - 1].raw;
      if (nums.length) textFs = nums[nums.length - 1].value;
    } else if (op === 'Tm' && nums.length >= 6) {
      tm = nums.slice(-6).map(t => t.value);
      tmTokens = nums.slice(-6);
      tx = 0;
    } else if ((op === 'Td' || op === 'TD') && nums.length >= 2) {
      tm = matMul([1, 0, 0, 1, nums[nums.length - 2].value, nums[nums.length - 1].value], tm);
      tmTokens = null; tx = 0;
    } else if (op === 'Tj' || op === 'TJ' || op === "'" || op === '"') {
      let payload = '';
      let firstArg = null;
      for (const t of operands) {
        if (firstArg === null && (t.kind === 'str' || t.kind === 'hex' || t.kind === 'delim')) firstArg = t;
        if (t.kind === 'str') payload += unescapePdf(t.raw.slice(1, -1));
        else if (t.kind === 'hex') payload += decodeHexStr(t.raw);
      }
      if (payload && inText) {
        let codes;
        if (cidFonts.has(textFont)) {
          codes = [];
          for (let k = 0; k + 1 < payload.length; k += 2) {
            codes.push((payload.charCodeAt(k) << 8) | payload.charCodeAt(k + 1));
          }
        } else {
          codes = [];
          for (let k = 0; k < payload.length; k++) codes.push(payload.charCodeAt(k));
        }
        const size = Math.abs(tm[0] || tm[1]) * Math.abs(ctm[0] || ctm[1]) * textFs;
        for (const c of codes) {
          const full = matMul(matMul([1, 0, 0, 1, tx, 0], tm), ctm);
          const el = new Element('text');
          el.x = full[4]; el.y = full[5];
          el.char = String.fromCharCode(c);
          el.codes = [c];
          el.font = textFont;
          el.size = size;
          el.opToken = tok;
          el.argToken = firstArg;
          if (tmTokens && (tm[4] || tm[5])) {
            if (ctm[3]) el.yRefs.push([tmTokens[5], 1 / ctm[3]]);
            if (ctm[0]) el.xRefs.push([tmTokens[4], 1 / ctm[0]]);
          } else {
            if (cmYRef) el.yRefs.push(cmYRef);
            if (cmXRef) el.xRefs.push(cmXRef);
          }
          elements.push(el);
          tx += W(textFont, c) * textFs + charSp + (c === 32 ? wordSp : 0);
        }
      }
    } else if (op === 'ET') {
      inText = false;
    } else if ((op === 'm' || op === 'l') && nums.length >= 2) {
      if (!pathOpen) { pathOpen = true; pathPts = []; pathYRefs = []; pathXRefs = []; pathHasCurve = false; }
      const xt = nums[nums.length - 2], yt = nums[nums.length - 1];
      pathPts.push(applyM(ctm, xt.value, yt.value));
      pathYRefs.push([yt, ctm[3] ? 1 / ctm[3] : 1]);
      pathXRefs.push([xt, ctm[0] ? 1 / ctm[0] : 1]);
    } else if (op === 'c' && nums.length >= 6) {
      if (!pathOpen) { pathOpen = true; pathPts = []; pathYRefs = []; pathXRefs = []; }
      pathHasCurve = true;
      for (const k of [0, 2, 4]) {
        const xt = nums[k], yt = nums[k + 1];
        pathPts.push(applyM(ctm, xt.value, yt.value));
        pathYRefs.push([yt, ctm[3] ? 1 / ctm[3] : 1]);
        pathXRefs.push([xt, ctm[0] ? 1 / ctm[0] : 1]);
      }
    } else if (op === 're' && nums.length >= 4) {
      if (!pathOpen) { pathOpen = true; pathPts = []; pathYRefs = []; pathXRefs = []; pathHasCurve = false; }
      const [xt, yt, wt, ht] = nums.slice(-4);
      pathPts.push(applyM(ctm, xt.value, yt.value));
      pathPts.push(applyM(ctm, xt.value + wt.value, yt.value + ht.value));
      pathYRefs.push([yt, ctm[3] ? 1 / ctm[3] : 1]);
      pathXRefs.push([xt, ctm[0] ? 1 / ctm[0] : 1]);
    } else if (['S', 's', 'f', 'F', 'f*', 'B', 'b', 'n'].includes(op)) {
      if (pathPts.length) {
        const el = new Element((op === 'S' || op === 's') ? 'stroke' : 'fill');
        el.pts = pathPts.slice();
        el.hasCurve = pathHasCurve;
        el.lineWidth = lineWidth * Math.abs(ctm[3]);
        el.yRefs = pathYRefs.slice();
        el.xRefs = pathXRefs.slice();
        el.opToken = tok;
        elements.push(el);
      }
      pathPts = []; pathYRefs = []; pathXRefs = []; pathHasCurve = false; pathOpen = false;
    }
    operands = [];
  }
  return elements;
}
/* ===========================================================================
   2부: 악보 글꼴 읽기 (scorelib/glyphs.py)

   같은 Maestro 글꼴이라도 PDF 를 만든 프로그램에 따라 글자 번호가 제멋대로
   다시 매겨진다. 그래서 번호를 외우는 대신, PDF 안의 ToUnicode 표나
   /Differences 의 글리프 이름을 읽어 유니코드로 바꾼 다음 그것으로 판단한다.
   =========================================================================== */

const SMUFL = new Map();
function smufl(role, ...codes) { for (const c of codes) SMUFL.set(c, role); }
function range(a, b) { const r = []; for (let i = a; i < b; i++) r.push(i); return r; }

smufl('clef', 0xE050, 0xE051, 0xE052, 0xE053, 0xE054, 0xE055, 0xE056,
      0xE05C, 0xE05D, 0xE062, 0xE063, 0xE064, 0xE065, 0xE066, 0xE06A);
smufl('timesig', ...range(0xE080, 0xE08A), 0xE08A, 0xE08B, 0xE09E, 0xE09F);
smufl('notehead', ...range(0xE0A0, 0xE100));
smufl('rest', ...range(0xE4E0, 0xE500));
smufl('flat', 0xE260, 0xE264);
smufl('natural', 0xE261);
smufl('sharp', 0xE262, 0xE263);
smufl('accidental_other', ...range(0xE265, 0xE280));
smufl('flag', ...range(0xE240, 0xE260));
smufl('dot', 0xE1E7);
smufl('fixed', ...range(0xE000, 0xE050));

// 옛 Maestro / Opus 문자표. 열쇠는 유니코드 글자.
const LEGACY = new Map(Object.entries({
  '&': 'clef', '?': 'clef', 'B': 'clef', 'V': 'clef',
  'œ': 'notehead',   // œ 검은 음표머리
  '˙': 'notehead',   // ˙ 흰 음표머리
  'w': 'notehead',        // 온음표
  '|': 'notehead',        // 다이아몬드
  'Ú': 'notehead', 'Ô': 'notehead',
  'Œ': 'rest',       // Œ 4분쉼표
  '‰': 'rest',       // ‰ 8분쉼표
  'Ó': 'rest',       // Ó 2분쉼표
  '∑': 'rest',       // ∑ 온쉼표
  '≈': 'rest', '®': 'rest', 'Ù': 'rest', 'ä': 'rest',
  'b': 'flat', '#': 'sharp', 'n': 'natural',
  '.': 'dot',
  'J': 'flag', 'j': 'flag', 'K': 'flag', 'k': 'flag', 'R': 'flag', 'r': 'flag',
  '0': 'timesig', '1': 'timesig', '2': 'timesig', '3': 'timesig', '4': 'timesig',
  '5': 'timesig', '6': 'timesig', '7': 'timesig', '8': 'timesig', '9': 'timesig',
  'c': 'timesig',
}));

const ALTER_OF_ROLE = { flat: -1, natural: 0, sharp: 1 };

// ---------------------------------------------------------- ToUnicode 읽기

function parseToUnicode(text) {
  const out = new Map();
  const rangeRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])/g;
  const charRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
  for (const m of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = m[1];
    rangeRe.lastIndex = 0;
    let mm;
    while ((mm = rangeRe.exec(body)) !== null) {
      const lo = parseInt(mm[1], 16), hi = parseInt(mm[2], 16), dst = mm[3];
      if (dst.startsWith('[')) {
        const vals = [...dst.matchAll(/<([0-9A-Fa-f]+)>/g)].map(v => v[1]);
        vals.forEach((v, i) => { if (lo + i <= hi) out.set(lo + i, parseInt(v.slice(0, 4), 16)); });
      } else {
        const base = parseInt(dst.slice(1, -1).slice(0, 4), 16);
        for (let i = 0; i <= hi - lo; i++) out.set(lo + i, base + i);
      }
    }
  }
  for (const m of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    charRe.lastIndex = 0;
    let mm;
    while ((mm = charRe.exec(m[1])) !== null) {
      out.set(parseInt(mm[1], 16), parseInt(mm[2].slice(0, 4), 16));
    }
  }
  return out;
}

const UNI_NAME = /^uni([0-9A-Fa-f]{4,6})$/;
const NAME_TO_CHAR = {
  ampersand: '&', question: '?', period: '.', bar: '|',
  oe: 'œ', OE: 'Œ', dotaccent: '˙', perthousand: '‰',
  Oacute: 'Ó', Ucircumflex: 'Û', summation: '∑',
  numbersign: '#', b: 'b', n: 'n', w: 'w',
  J: 'J', j: 'j', K: 'K', k: 'k', R: 'R', r: 'r',
  zero: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};

// MacRoman / WinAnsi 가운데 하나로 글자 번호를 글자로 바꾼다.
const MACROMAN_HIGH = {
  0x80:'Ä',0x81:'Å',0x82:'Ç',0x83:'É',0x84:'Ñ',0x85:'Ö',0x86:'Ü',0x87:'á',
  0x88:'à',0x89:'â',0x8a:'ä',0x8b:'ã',0x8c:'å',0x8d:'ç',0x8e:'é',0x8f:'è',
  0x90:'ê',0x91:'ë',0x92:'í',0x93:'ì',0x94:'î',0x95:'ï',0x96:'ñ',0x97:'ó',
  0x98:'ò',0x99:'ô',0x9a:'ö',0x9b:'õ',0x9c:'ú',0x9d:'ù',0x9e:'û',0x9f:'ü',
  0xa0:'†',0xa1:'°',0xa2:'¢',0xa3:'£',0xa4:'§',0xa5:'•',0xa6:'¶',0xa7:'ß',
  0xa8:'®',0xa9:'©',0xaa:'™',0xab:'´',0xac:'¨',0xad:'≠',0xae:'Æ',0xaf:'Ø',
  0xb0:'∞',0xb1:'±',0xb2:'≤',0xb3:'≥',0xb4:'¥',0xb5:'µ',0xb6:'∂',0xb7:'∑',
  0xb8:'∏',0xb9:'π',0xba:'∫',0xbb:'ª',0xbc:'º',0xbd:'Ω',0xbe:'æ',0xbf:'ø',
  0xc0:'¿',0xc1:'¡',0xc2:'¬',0xc3:'√',0xc4:'ƒ',0xc5:'≈',0xc6:'∆',0xc7:'«',
  0xc8:'»',0xc9:'…',0xca:' ',0xcb:'À',0xcc:'Ã',0xcd:'Õ',0xce:'Œ',0xcf:'œ',
  0xd0:'–',0xd1:'—',0xd2:'“',0xd3:'”',0xd4:'‘',0xd5:'’',0xd6:'÷',0xd7:'◊',
  0xd8:'ÿ',0xd9:'Ÿ',0xda:'⁄',0xdb:'€',0xdc:'‹',0xdd:'›',0xde:'ﬁ',0xdf:'ﬂ',
  0xe0:'‡',0xe1:'·',0xe2:'‚',0xe3:'„',0xe4:'‰',0xe5:'Â',0xe6:'Ê',0xe7:'Á',
  0xe8:'Ë',0xe9:'È',0xea:'Í',0xeb:'Î',0xec:'Ï',0xed:'Ì',0xee:'Ó',0xef:'Ô',
  0xf0:'',0xf1:'Ò',0xf2:'Ú',0xf3:'Û',0xf4:'Ù',0xf5:'ı',0xf6:'ˆ',0xf7:'˜',
  0xf8:'¯',0xf9:'˘',0xfa:'˙',0xfb:'˚',0xfc:'¸',0xfd:'˝',0xfe:'˛',0xff:'ˇ',
};
const CP1252_HIGH = {
  0x80:'€',0x82:'‚',0x83:'ƒ',0x84:'„',0x85:'…',0x86:'†',0x87:'‡',0x88:'ˆ',
  0x89:'‰',0x8a:'Š',0x8b:'‹',0x8c:'Œ',0x8e:'Ž',0x91:'‘',0x92:'’',0x93:'“',
  0x94:'”',0x95:'•',0x96:'–',0x97:'—',0x98:'˜',0x99:'™',0x9a:'š',0x9b:'›',
  0x9c:'œ',0x9e:'ž',0x9f:'Ÿ',
};

function codeToChar(code, encoding) {
  if (code >= 32 && code < 127) return String.fromCharCode(code);
  if (encoding === 'cp1252') {
    if (CP1252_HIGH[code] !== undefined) return CP1252_HIGH[code];
    return String.fromCharCode(code);
  }
  if (MACROMAN_HIGH[code] !== undefined) return MACROMAN_HIGH[code];
  return String.fromCharCode(code);
}

function roleOfCodepoint(cp) {
  if (cp >= 0xE000 && cp <= 0xF8FF) return SMUFL.get(cp) || null;
  return LEGACY.get(String.fromCharCode(cp)) || null;
}

// ------------------------------------------------------- PDF 사전에서 꺼내기

function balanced(text, start) {
  let depth = 0;
  for (let k = start; k < text.length; k++) {
    if (text[k] === '[') depth++;
    else if (text[k] === ']') { depth--; if (depth === 0) return text.slice(start + 1, k); }
  }
  return null;
}

/* 사전에서 key 뒤에 오는 대괄호 배열을 통째로 꺼낸다. 폭 배열은
   '[ 3 [ 500 600 ] 18 [ 300 ] ]' 처럼 괄호가 겹쳐 있고, '/W 25 0 R' 처럼
   다른 객체를 가리키기만 하는 PDF 도 있어 그럴 때는 따라간다. */
function bracketed(obj, key, pdf) {
  const i = obj.indexOf(key);
  if (i < 0) return null;
  const rest = obj.slice(i + key.length);
  let m = /^\s*\[/.exec(rest);
  if (m) return balanced(obj, i + key.length + m[0].length - 1);
  m = /^\s*(\d+)\s+(\d+)\s+R/.exec(rest);
  if (m && pdf) {
    const target = pdf.objText(parseInt(m[1]), parseInt(m[2]));
    if (!target) return null;
    const j = target.indexOf('[');
    return j >= 0 ? balanced(target, j) : null;
  }
  return null;
}

function streamOf(obj, key, pdf) {
  const m = new RegExp(key.replace('/', '\\/') + '\\s+(\\d+)\\s+(\\d+)\\s+R').exec(obj);
  if (!m || !pdf) return null;
  return pdf.streamText(parseInt(m[1]), parseInt(m[2]));
}

// ------------------------------------------------------------- 공개 함수들

function glyphRoles(pdf, pageIdx, musicFonts, usage) {
  const roles = new Map(), unis = new Map();
  usage = usage || new Map();
  for (const f of pdf.fonts(pageIdx)) {
    if (!musicFonts.has(f.res)) continue;
    const obj = f.dictText;
    const table = new Map();
    const tu = streamOf(obj, '/ToUnicode', pdf);
    if (tu) for (const [k, v] of parseToUnicode(tu)) table.set(k, v);

    const dm = /\/Differences\s*\[([\s\S]*?)\]/.exec(obj);
    if (dm) {
      let code = 0;
      for (const t of dm[1].match(/\d+|\/[^\s/\]]+/g) || []) {
        if (t[0] === '/') {
          const name = t.slice(1);
          const um = UNI_NAME.exec(name);
          if (um) { if (!table.has(code)) table.set(code, parseInt(um[1], 16)); }
          else if (NAME_TO_CHAR[name]) { if (!table.has(code)) table.set(code, NAME_TO_CHAR[name].charCodeAt(0)); }
          code++;
        } else code = parseInt(t);
      }
    }

    if (table.size) {
      for (const [code, cp] of table) {
        if (!cp) continue;
        unis.set(f.res + '|' + code, cp);
        const role = roleOfCodepoint(cp);
        if (role) roles.set(f.res + '|' + code, role);
      }
    } else {
      // 아무 정보가 없으면 악보가 말이 되는 인코딩을 고른다
      let encs = ['mac_roman', 'cp1252'];
      if (obj.includes('WinAnsi')) encs = ['cp1252'];
      else if (obj.includes('MacRoman')) encs = ['mac_roman'];
      let best = encs[0], bestScore = -1;
      for (const enc of encs) {
        let score = 0;
        for (let code = 0; code < 256; code++) {
          if (LEGACY.get(codeToChar(code, enc))) score += usage.get(f.res + '|' + code) || 0;
        }
        if (score > bestScore) { best = enc; bestScore = score; }
      }
      for (let code = 0; code < 256; code++) {
        const ch = codeToChar(code, best);
        unis.set(f.res + '|' + code, ch ? ch.charCodeAt(0) : 0);
        const role = LEGACY.get(ch);
        if (role) roles.set(f.res + '|' + code, role);
      }
    }
  }
  return { roles, unis };
}

const MUSIC_FONT_WORDS = ['maestro', 'opus', 'leland', 'bravura', 'emmentaler',
  'gonville', 'petaluma', 'november', 'sonata', 'jazz', 'inkpen', 'helsinki',
  'finale', 'engraver', 'smufl', 'ekmelos', 'mscore'];

const DISTINCTIVE = new Set(['œ', '˙', 'Œ', '‰', '∑', 'Ó', 'Û']);

/* 악보 기호용 글꼴을 고른다. 글꼴 이름만 보면 'PDF로 인쇄' 를 거쳐 이름이
   CIDFont+F1 처럼 뭉개진 악보를 놓친다. 그래서 '무엇을 그리는 글꼴인지'
   로도 가린다 — 악보 기호 전용 유니코드 영역을 쓰거나, 본문에는 나오지
   않는 옛 Maestro 글자(œ Œ ˙ ‰ ∑)를 잔뜩 쓰는 글꼴. */
function musicFontNames(pdf, pageIdx, usage) {
  const out = new Set();
  for (const f of pdf.fonts(pageIdx)) {
    const base = (f.base || '').toLowerCase();
    const paired = base.includes('chord') || base.includes('text') || base.includes('lyric');
    if (!paired && MUSIC_FONT_WORDS.some(w => base.includes(w))) { out.add(f.res); continue; }
    const tu = streamOf(f.dictText, '/ToUnicode', pdf);
    if (tu) {
      let hits = 0;
      for (const cp of parseToUnicode(tu).values()) if (cp >= 0xE000 && cp <= 0xF8FF) hits++;
      if (hits >= 3) { out.add(f.res); continue; }
    }
    if (usage) {
      let hits = 0;
      for (const [key, n] of usage) {
        const sep = key.lastIndexOf('|');
        if (key.slice(0, sep) !== f.res) continue;
        const code = parseInt(key.slice(sep + 1));
        if (DISTINCTIVE.has(codeToChar(code, 'mac_roman')) || DISTINCTIVE.has(codeToChar(code, 'cp1252'))) hits += n;
      }
      if (hits >= 5) out.add(f.res);
    }
  }
  return out;
}

const AGL = { slash: '/', numbersign: '#', parenleft: '(', parenright: ')',
  plus: '+', minus: '-', comma: ',', period: '.', space: ' ', degree: '°',
  circumflex: '^', asciicircum: '^', zero: '0', one: '1', two: '2', three: '3',
  four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz') AGL[c] = c;

/* 모든 글꼴의 '글자번호 → 글자' 표. ToUnicode 가 가장 정확하고, 없으면
   /Differences 의 글리프 이름, 그것도 없으면 글꼴이 쓴다고 적어 둔 인코딩.
   아무 정보도 없는 동아시아 CID 글꼴은 관례(CID 1 이 빈칸, 뒤로 아스키)를 쓴다. */
function decodeChars(pdf, pageIdx) {
  const out = new Map();
  for (const f of pdf.fonts(pageIdx)) {
    const obj = f.dictText;
    const isCid = f.sub === '/Type0';
    const got = new Map();
    const tu = streamOf(obj, '/ToUnicode', pdf);
    if (tu) for (const [code, cp] of parseToUnicode(tu)) if (cp) got.set(code, String.fromCharCode(cp));

    const dm = /\/Differences\s*\[([\s\S]*?)\]/.exec(obj);
    if (dm) {
      let code = 0;
      for (const t of dm[1].match(/\d+|\/[^\s/\]]+/g) || []) {
        if (t[0] === '/') {
          const name = t.slice(1);
          const um = UNI_NAME.exec(name);
          if (um) { if (!got.has(code)) got.set(code, String.fromCharCode(parseInt(um[1], 16))); }
          else if (AGL[name]) { if (!got.has(code)) got.set(code, AGL[name]); }
          code++;
        } else code = parseInt(t);
      }
    }
    if (!got.size && !isCid) {
      const enc = obj.includes('WinAnsi') ? 'cp1252' : 'mac_roman';
      for (let code = 32; code < 256; code++) got.set(code, codeToChar(code, enc));
    }
    if (!got.size && isCid) {
      for (let code = 1; code < 96; code++) got.set(code, String.fromCharCode(code + 31));
    }
    for (const [code, ch] of got) out.set(f.res + '|' + code, ch);
  }
  return out;
}

function elementText(table, font, codes) {
  return codes.map(c => table.get(font + '|' + c) || '').join('');
}

/* 글꼴마다 '글자번호 → 폭(em)'. 한 BT 블록 안에서 글자를 잇달아 찍는 PDF 는
   자리를 폭만큼 전진시켜 정하므로, 폭을 모르면 두 번째 글자부터 어긋난다. */
function fontWidths(pdf, pageIdx) {
  const out = new Map();
  for (const f of pdf.fonts(pageIdx)) {
    const obj = f.dictText;
    const res = f.res;
    if (f.sub === '/Type0') {
      const m = /\/DescendantFonts\s*\[\s*(\d+)\s+(\d+)\s+R/.exec(obj);
      const dobj = m ? (pdf.objText(parseInt(m[1]), parseInt(m[2])) || obj) : obj;
      let dw = 1000;
      const dm = /\/DW\s+(-?\d+(?:\.\d+)?)/.exec(dobj);
      if (dm) dw = parseFloat(dm[1]);
      out.set(res + '|-1', dw / 1000);
      const body = bracketed(dobj, '/W', pdf);
      if (body) parseW(body, res, out);
    } else {
      const fc = /\/FirstChar\s+(\d+)/.exec(obj);
      const body = bracketed(obj, '/Widths', pdf);
      if (!fc || !body) continue;
      const first = parseInt(fc[1]);
      const vals = (body.match(/-?\d+(?:\.\d+)?/g) || []).map(parseFloat);
      vals.forEach((v, i) => out.set(res + '|' + (first + i), v / 1000));
    }
  }
  return out;
}

function parseW(body, res, out) {
  const toks = body.match(/\[|\]|-?\d+(?:\.\d+)?/g) || [];
  let i = 0;
  while (i < toks.length) {
    if (toks[i] === '[' || toks[i] === ']') { i++; continue; }
    const start = Math.trunc(parseFloat(toks[i])); i++;
    if (i < toks.length && toks[i] === '[') {
      i++;
      let k = 0;
      while (i < toks.length && toks[i] !== ']') { out.set(res + '|' + (start + k), parseFloat(toks[i]) / 1000); k++; i++; }
      i++;
    } else if (i + 1 < toks.length) {
      const last = Math.trunc(parseFloat(toks[i]));
      const w = parseFloat(toks[i + 1]) / 1000;
      i += 2;
      if (last - start < 65536) for (let c = start; c <= last; c++) out.set(res + '|' + c, w);
    } else break;
  }
}
/* ===========================================================================
   3부: 음악 이론 (scorelib/music.py) 과 새로 그리기 (scorelib/draw.py)
   =========================================================================== */

const LETTERS = 'CDEFGAB';
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_ORDER = 'FCGDAEB';
const FLAT_ORDER = 'BEADGCF';

const MAJOR_BY_FIFTHS = { 0:'C',1:'G',2:'D',3:'A',4:'E',5:'B',6:'F#',7:'C#',
  '-1':'F','-2':'Bb','-3':'Eb','-4':'Ab','-5':'Db','-6':'Gb','-7':'Cb' };
const FIFTHS_BY_MAJOR = {};
for (const k of Object.keys(MAJOR_BY_FIFTHS)) FIFTHS_BY_MAJOR[MAJOR_BY_FIFTHS[k]] = parseInt(k);

const ACC_NAME = { '-2': 'bb', '-1': 'b', 0: '', 1: '#', 2: '##' };

function parseNoteName(name) {
  name = String(name).trim().replace(/♭/g, 'b').replace(/♯/g, '#').replace(/♮/g, '');
  if (!name) throw new Error('빈 음이름');
  const letter = name[0].toUpperCase();
  if (!(letter in LETTER_PC)) throw new Error('알 수 없는 음이름: ' + name);
  let alter = 0;
  for (const ch of name.slice(1)) {
    if (ch === 'b') alter -= 1;
    else if (ch === '#') alter += 1;
    else throw new Error('알 수 없는 음이름: ' + name);
  }
  return [letter, alter];
}

function noteName(letter, alter) {
  return letter + (ACC_NAME[alter] !== undefined ? ACC_NAME[alter] : `(${alter})`);
}

function pitchClass(letter, alter) { return (((LETTER_PC[letter] + alter) % 12) + 12) % 12; }

function keyAlter(fifths, letter) {
  if (fifths > 0) return SHARP_ORDER.slice(0, fifths).includes(letter) ? 1 : 0;
  if (fifths < 0) return FLAT_ORDER.slice(0, -fifths).includes(letter) ? -1 : 0;
  return 0;
}

function keysigLetters(fifths) {
  if (fifths > 0) return SHARP_ORDER.slice(0, fifths).split('');
  if (fifths < 0) return FLAT_ORDER.slice(0, -fifths).split('');
  return [];
}

class Interval {
  constructor(steps, semitones) { this.steps = steps; this.semitones = semitones; }
  get isUnison() { return this.steps === 0 && this.semitones === 0; }
  describe() {
    const names = { 0: '완전1도', 1: '2도', 2: '3도', 3: '4도', 4: '5도', 5: '6도', 6: '7도' };
    const up = this.semitones >= 0;
    const st = Math.abs(this.steps) % 7;
    const oct = Math.floor(Math.abs(this.steps) / 7);
    let out = `${up ? '위' : '아래'}로 ${names[st] || (st + 1) + '도'}`;
    if (oct) out += ` + ${oct}옥타브`;
    return `${out} (${this.semitones >= 0 ? '+' : ''}${this.semitones}반음)`;
  }
}

function intervalBetween(src, dst, prefer) {
  const [sl, sa] = src, [dl, da] = dst;
  const baseSteps = (((LETTERS.indexOf(dl) - LETTERS.indexOf(sl)) % 7) + 7) % 7;
  const baseSemi = (((pitchClass(dl, da) - pitchClass(sl, sa)) % 12) + 12) % 12;
  const up = new Interval(baseSteps, baseSemi);
  const down = new Interval(baseSteps - 7, baseSemi - 12);
  if (up.isUnison) return up;
  if (prefer === 'up') return up;
  if (prefer === 'down') return down;
  return Math.abs(up.semitones) <= Math.abs(down.semitones) ? up : down;
}

function transposePitch(letter, alter, iv, simplify) {
  if (simplify === undefined) simplify = true;
  const idx = (((LETTERS.indexOf(letter) + iv.steps) % 7) + 7) % 7;
  const newLetter = LETTERS[idx];
  const targetPc = (((pitchClass(letter, alter) + iv.semitones) % 12) + 12) % 12;
  let diff = (((targetPc - LETTER_PC[newLetter]) % 12) + 12) % 12;
  if (diff > 6) diff -= 12;
  const newAlter = diff;
  if (simplify && Math.abs(newAlter) > 1) {
    for (const cl of LETTERS) for (const ca of [0, 1, -1]) {
      if (pitchClass(cl, ca) === targetPc) return [cl, ca];
    }
  }
  return [newLetter, newAlter];
}

function transposeKey(fifths, iv) {
  const [letter, alter] = parseNoteName(MAJOR_BY_FIFTHS[fifths]);
  const [nl, na] = transposePitch(letter, alter, iv, false);
  const name = noteName(nl, na);
  if (FIFTHS_BY_MAJOR[name] !== undefined) {
    const f = FIFTHS_BY_MAJOR[name];
    if (f >= -7 && f <= 7) return f;
  }
  const pc = pitchClass(nl, na);
  let best = null;
  for (const cand of Object.keys(FIFTHS_BY_MAJOR)) {
    const [cl, ca] = parseNoteName(cand);
    if (pitchClass(cl, ca) === pc) {
      const f = FIFTHS_BY_MAJOR[cand];
      if (best === null || Math.abs(f) < Math.abs(best)) best = f;
    }
  }
  if (best === null) throw new Error('옮긴 조를 조표로 적을 수 없습니다');
  return best;
}

class Chord {
  constructor(rootLetter, rootAlter, suffix, bassLetter, bassAlter) {
    this.rootLetter = rootLetter;
    this.rootAlter = rootAlter || 0;
    this.suffix = suffix || '';
    this.bassLetter = bassLetter || null;
    this.bassAlter = bassAlter || 0;
  }
  name() {
    let out = noteName(this.rootLetter, this.rootAlter) + this.suffix;
    if (this.bassLetter) out += '/' + noteName(this.bassLetter, this.bassAlter);
    return out;
  }
  transposed(iv, simplify) {
    const [rl, ra] = transposePitch(this.rootLetter, this.rootAlter, iv, simplify);
    let bl = null, ba = 0;
    if (this.bassLetter) [bl, ba] = transposePitch(this.bassLetter, this.bassAlter, iv, simplify);
    return new Chord(rl, ra, this.suffix, bl, ba);
  }
}

function stepToPitch(step, clef) {
  const base = clef === 'bass' ? ['G', 2] : ['E', 4];
  const start = LETTERS.indexOf(base[0]);
  const idx = start + step;
  const letter = LETTERS[((idx % 7) + 7) % 7];
  const octave = base[1] + Math.floor(idx / 7);
  return [letter, octave];
}

/* ------------------------------------------------------------ 새로 그리기

   악보에 쓰인 글꼴은 '실제로 쓰인 글자' 만 담긴 부분집합이라, 원본에 ♯ 이
   없으면 ♯ 글리프도 없다. 그래서 ♯ 과 ♮ 은 선과 면으로 직접 그린다.
   ♭ 은 원본에 거의 항상 있으므로 있으면 글리프를 그대로 쓴다.            */

function nf(v) {
  const s = v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return s === '' || s === '-' ? '0' : s;
}

// 좌표계를 되돌리는 행렬은 조금만 어긋나도 쪽 전체가 밀리므로 넉넉하게 적는다
function nf6(v) {
  let s = v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  if (s === '' || s === '-') s = '0';
  if (s === '0' && Object.is(v, -0)) s = '-0';
  return s;
}

class Painter {
  constructor() { this.ops = []; }
  line(x0, y0, x1, y1, width) {
    this.ops.push(`q ${nf(width)} w 0 0 0 1 k 0 0 0 1 K ${nf(x0)} ${nf(y0)} m ${nf(x1)} ${nf(y1)} l S Q`);
  }
  poly(pts) {
    if (!pts.length) return;
    let d = `${nf(pts[0][0])} ${nf(pts[0][1])} m `;
    d += pts.slice(1).map(p => `${nf(p[0])} ${nf(p[1])} l`).join(' ');
    this.ops.push(`q 0 0 0 1 k ${d} f Q`);
  }
  curveShape(start, segments) {
    let d = `${nf(start[0])} ${nf(start[1])} m `;
    for (const [c1, c2, p] of segments) {
      d += `${nf(c1[0])} ${nf(c1[1])} ${nf(c2[0])} ${nf(c2[1])} ${nf(p[0])} ${nf(p[1])} c `;
    }
    this.ops.push(`q 0 0 0 1 k ${d} f Q`);
  }
  text(fontRes, size, x, y, payload, hexMode) {
    const body = hexMode ? `<${payload}>` : `(${payload})`;
    this.ops.push(`q 0 0 0 1 k 1 0 0 1 ${nf(x)} ${nf(y)} cm BT ${nf(size)} 0 0 ${nf(size)} 0 0 Tm ${fontRes} 1 Tf ${body} Tj ET Q`);
  }
  render() { return this.ops.length ? '\n' + this.ops.join('\n') + '\n' : ''; }
}

function drawSharp(p, x, y, ss) {
  const w = 0.92 * ss, stem = 0.075 * ss;
  p.line(x + 0.28 * ss, y - 1.10 * ss, x + 0.28 * ss, y + 0.88 * ss, stem);
  p.line(x + 0.62 * ss, y - 0.88 * ss, x + 0.62 * ss, y + 1.10 * ss, stem);
  for (const cy of [-0.38 * ss, 0.28 * ss]) {
    const t = 0.115 * ss, rise = 0.17 * ss;
    p.poly([[x + 0.04 * ss, y + cy - t], [x + 0.86 * ss, y + cy - t + rise],
            [x + 0.86 * ss, y + cy + t + rise], [x + 0.04 * ss, y + cy + t]]);
  }
  return w;
}

function drawNatural(p, x, y, ss) {
  const w = 0.66 * ss, stem = 0.075 * ss;
  p.line(x + 0.16 * ss, y - 0.34 * ss, x + 0.16 * ss, y + 1.14 * ss, stem);
  p.line(x + 0.52 * ss, y - 1.14 * ss, x + 0.52 * ss, y + 0.34 * ss, stem);
  for (const cy of [-0.26 * ss, 0.30 * ss]) {
    const t = 0.115 * ss, rise = 0.13 * ss;
    p.poly([[x + 0.16 * ss, y + cy - t], [x + 0.53 * ss, y + cy - t + rise],
            [x + 0.53 * ss, y + cy + t + rise], [x + 0.16 * ss, y + cy + t]]);
  }
  return w;
}

function drawFlat(p, x, y, ss) {
  const w = 0.62 * ss, sx = x + 0.14 * ss;
  p.line(sx, y - 0.40 * ss, sx, y + 1.80 * ss, 0.075 * ss);
  p.curveShape([sx, y + 0.62 * ss], [
    [[sx + 0.42 * ss, y + 0.62 * ss], [sx + 0.56 * ss, y + 0.30 * ss], [sx + 0.44 * ss, y + 0.04 * ss]],
    [[sx + 0.36 * ss, y - 0.16 * ss], [sx + 0.18 * ss, y - 0.30 * ss], [sx + 0.02 * ss, y - 0.42 * ss]],
    [[sx + 0.12 * ss, y - 0.10 * ss], [sx + 0.06 * ss, y + 0.28 * ss], [sx, y + 0.62 * ss]],
  ]);
  return w;
}

const DRAWERS = { '1': drawSharp, '0': drawNatural, '-1': drawFlat };

function drawAccidental(p, alter, x, y, ss) {
  if (DRAWERS[String(alter)]) return DRAWERS[String(alter)](p, x, y, ss);
  const sign = alter > 0 ? 1 : -1;
  let total = 0;
  for (let i = 0; i < Math.min(Math.abs(alter), 2); i++) {
    total += DRAWERS[String(sign)](p, x + total, y, ss) * 0.92;
  }
  return total;
}
/* ===========================================================================
   4부: 오선 찾기와 요소 가려내기 (scorelib/score.py)

   핵심 생각: 이조는 음높이에 매인 것만 세로로 옮기는 일이다. 그래서
   음표머리를 먼저 찾고, 거기에 붙어 있는 것(기둥·깃발·점·임시표·빔·이음줄·
   덧줄)을 따라가며 '움직일 것' 을 넓혀 나간다. 보표선·마디선·음자리표·
   박자표·쉼표·가사·코드처럼 아무 음표에도 붙지 않는 것은 자연히 제자리.
   =========================================================================== */

class Staff {
  constructor(index, page, lines, x0, x1) {
    this.index = index; this.page = page; this.lines = lines;
    this.x0 = x0; this.x1 = x1; this.chordY = null;
  }
  get top() { return this.lines[0]; }
  get bottom() { return this.lines[this.lines.length - 1]; }
  get space() { return (this.top - this.bottom) / 4; }
  get half() { return this.space / 2; }
  get middle() { return this.lines[2]; }
  stepOf(y) { return Math.round((y - this.bottom) / this.half); }
  yOf(step) { return this.bottom + step * this.half; }
}

function detectStaves(elements, page, startIndex, clefYs) {
  const lines = elements.filter(e => e.kind === 'stroke' && e.height < 0.8 && e.width > 120);
  if (!lines.length) return [];
  // y 가 같은 선이 여러 개일 수 있으니 먼저 합친다
  const ys = [];
  for (const e of lines.slice().sort((a, b) => b.y0 - a.y0)) {
    const last = ys[ys.length - 1];
    if (last && Math.abs(last[0] - e.y0) < 0.5) {
      last[1] = Math.min(last[1], e.x0);
      last[2] = Math.max(last[2], e.x1);
    } else ys.push([e.y0, e.x0, e.x1]);
  }
  const gaps = [];
  for (let i = 0; i + 1 < ys.length; i++) gaps.push(ys[i][0] - ys[i + 1][0]);
  if (!gaps.length) return [];
  const cut = Math.min(...gaps) * 2;

  const groups = [];
  let group = [ys[0]];
  for (let i = 1; i < ys.length; i++) {
    if (ys[i - 1][0] - ys[i][0] > cut) { groups.push(group); group = []; }
    group.push(ys[i]);
  }
  groups.push(group);

  const out = [];
  for (const g of groups) {
    const st = new Staff(0, page, g.map(x => x[0]),
      Math.min(...g.map(x => x[1])), Math.max(...g.map(x => x[2])));
    if (g.length === 5) out.push(st);
    else if (g.length === 4) {
      const fixed = restoreMissingLine(st, clefYs || []);
      if (fixed) out.push(fixed);
    }
  }
  out.forEach((st, i) => { st.index = startIndex + i; });
  return out;
}

/* 줄 네 개만 찾은 보표에 빠진 한 줄을 되살린다. 악보에 따라 줄 하나가
   아예 그려져 있지 않은 경우가 있다(뷰어가 알아서 메워 준다). 그럴 때는
   음자리표 높이로 가려낸다 — 높은음자리표는 밑에서 둘째 줄에 걸터앉는다. */
function restoreMissingLine(st, clefYs) {
  const gaps = [];
  for (let i = 0; i + 1 < st.lines.length; i++) gaps.push(st.lines[i] - st.lines[i + 1]);
  const space = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  for (const extra of [st.lines[st.lines.length - 1] - space, st.lines[0] + space]) {
    const lines = [...new Set([...st.lines, extra])].sort((a, b) => b - a);
    if (lines.length !== 5) continue;
    const bottom = lines[4];
    if (clefYs.some(y => Math.abs(y - (bottom + space)) < space * 0.3)) {
      return new Staff(st.index, st.page, lines, st.x0, st.x1);
    }
  }
  return null;
}

/* 보표 위에서 코드 기호가 줄지어 선 높이를 찾는다. 코드는 한 단에 여러 개가
   같은 높이로 늘어서고, 제목이나 구간 이름은 기껏해야 한두 개뿐이다. */
function findChordRow(elements, s) {
  const lo = s.top + 0.5 * s.space, hi = s.top + 6 * s.space;
  const xs0 = s.x0 + 2 * s.space, xs1 = s.x1 + s.space;
  const counts = new Map();
  for (const e of elements) {
    if (e.kind !== 'text' || e.system !== s.index) continue;
    if (!(e.y > lo && e.y < hi && e.x > xs0 && e.x < xs1)) continue;
    const key = Math.round(e.y * 2) / 2;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let bestY = null, bestN = 0;
  for (const [y, n] of counts) if (n > bestN) { bestY = y; bestN = n; }
  return bestN >= 2 ? bestY : null;
}

function inChordBand(e, s) {
  if (s.chordY === null) return false;
  if (!(e.x > s.x0 + 1 * s.space && e.x < s.x1 + s.space)) return false;
  return Math.abs(e.y - s.chordY) <= 0.9 * s.space;
}

function classify(elements, staves, cidFonts, musicFonts, italicFonts, glyphRole, glyphUni) {
  if (!staves.length) return;
  const ss = staves[0].space;
  glyphRole = glyphRole || new Map();
  glyphUni = glyphUni || new Map();

  // 1) 보표 배정
  for (const e of elements) {
    const y = e.kind === 'text' ? e.y : (e.y0 + e.y1) / 2;
    let best = -1, bestd = 1e9;
    for (const s of staves) {
      const d = (s.bottom <= y && y <= s.top) ? 0 : Math.min(Math.abs(y - s.top), Math.abs(y - s.bottom));
      if (d < bestd) { best = s.index; bestd = d; }
    }
    e.system = best;
  }
  const byIndex = new Map(staves.map(s => [s.index, s]));
  for (const s of staves) s.chordY = findChordRow(elements, s);

  // 2) 뚜렷한 것부터
  for (const e of elements) {
    const s = byIndex.get(e.system);
    if (!s) { e.role = 'other'; continue; }

    if (e.kind === 'stroke') {
      if (e.height < 0.8 && e.width > 120) e.role = 'staff_line';
      else if (e.height < 0.8 && e.width <= 20) e.role = 'ledger?';
      else if (e.width < 0.9 && e.height > 0.8) {
        // 마디선은 맨 윗줄과 맨 아랫줄에 정확히 맞춰 그어진다. 낮은 음의
        // 긴 기둥도 보표를 거의 가로지르지만 끝이 선에 딱 맞지 않는다.
        e.role = (Math.abs(e.y0 - s.bottom) < 0.7 && Math.abs(e.y1 - s.top) < 0.7) ? 'barline' : 'stem';
      } else e.role = 'other';
      continue;
    }
    if (e.kind === 'fill') { e.role = e.hasCurve ? 'slur' : 'beam'; continue; }

    // 악보 기호 글꼴을 먼저 본다. Leland·Opus 처럼 CID 글꼴로 들어 있는
    // 악보 글꼴을 가사로 오해하지 않으려면 이 차례라야 한다.
    if (musicFonts.has(e.font)) {
      const code = e.codes.length ? e.codes[0] : -1;
      e.uni = glyphUni.get(e.font + '|' + code) || 0;
      const kind = glyphRole.get(e.font + '|' + code);
      if (kind === 'notehead') e.role = 'notehead';
      else if (kind === 'clef' || kind === 'timesig' || kind === 'rest') e.role = kind;
      else if (kind in ALTER_OF_ROLE) { e.role = 'accidental'; e.alter = ALTER_OF_ROLE[kind]; }
      else if (kind === 'dot') e.role = 'dot';
      else if (kind === 'flag') e.role = 'flag';
      else e.role = 'music_other';
      continue;
    }
    if (cidFonts.has(e.font) && !inChordBand(e, s)) { e.role = 'lyric'; continue; }

    // 코드 줄에 놓인 글자는 코드 기호다. 음이름 한 글자면 루트, 나머지는 접미사.
    if (italicFonts && italicFonts.has(e.font)) e.role = 'text_other';
    else if (inChordBand(e, s)) {
      e.role = (e.char.length === 1 && 'ABCDEFG'.includes(e.char)) ? 'chord_root' : 'chord_suffix';
    } else e.role = 'text_other';
  }

  // 2-b) 마디선처럼 보이지만 음표머리가 붙어 있으면 그건 기둥이다
  const headsBySys = new Map();
  for (const e of elements) {
    if (e.role === 'notehead') {
      if (!headsBySys.has(e.system)) headsBySys.set(e.system, []);
      headsBySys.get(e.system).push(e);
    }
  }
  for (const e of elements) {
    if (e.role !== 'barline') continue;
    const s = byIndex.get(e.system);
    if (!s) continue;
    for (const h of headsBySys.get(e.system) || []) {
      const dx = e.x0 - h.x;
      if (dx >= -0.55 * s.space && dx <= 1.9 * s.space &&
          e.y0 - 0.5 * s.space <= h.y && h.y <= e.y1 + 0.5 * s.space) { e.role = 'stem'; break; }
    }
  }

  // 3) 조표 가려내기
  for (const s of staves) markKeySignature(elements, s);

  // 4) 코드 줄에 있는 임시표는 코드 기호의 일부
  for (const e of elements) {
    if (e.role !== 'accidental') continue;
    const s = byIndex.get(e.system);
    if (s && inChordBand(e, s)) e.role = 'chord_accidental';
  }
}

/* 한 보표에서 조표로 쓰인 임시표 무리를 찾는다. 조표는 줄 첫머리 음자리표
   뒤, 또는 조가 바뀌는 지점에 나타난다. 두 경우 모두 '음표머리가 가까이
   없는 임시표 무리' 라는 점은 같다. */
function markKeySignature(elements, s) {
  const ss = s.space;
  const mine = elements.filter(e => e.system === s.index);
  const accs = mine.filter(e => e.role === 'accidental' &&
    s.bottom - ss <= e.y && e.y <= s.top + ss).sort((a, b) => a.x - b.x);
  const heads = mine.filter(e => e.role === 'notehead').sort((a, b) => a.x - b.x);
  if (!accs.length) return;

  const groups = [];
  for (const a of accs) {
    const last = groups[groups.length - 1];
    if (last && a.x - last[last.length - 1].x <= 1.6 * ss) last.push(a);
    else groups.push([a]);
  }
  for (const g of groups) {
    const gx1 = g[g.length - 1].x;
    const nearest = heads.find(h => h.x > gx1) || null;
    const attached = nearest !== null && (nearest.x - gx1) < 1.9 * ss;
    if (attached && g.length === 1) continue;
    if (g.length >= 2 && attached) {
      const sameHeight = g.some(a => heads.some(h =>
        h.x - a.x > 0 && h.x - a.x < 1.9 * ss && Math.abs(h.y - a.y) < 0.6 * ss));
      if (sameHeight && g.length < 3) continue;
    }
    for (const a of g) a.role = 'keysig';
  }
}

// ------------------------------------------------------------- 음표 묶기

class Note {
  constructor(head, staff) {
    this.head = head; this.staff = staff;
    this.stem = null; this.parts = []; this.accidental = null; this.ledgers = [];
  }
  get step() { return this.staff.stepOf(this.head.y); }
}

function groupNotes(elements, staves) {
  const byIndex = new Map(staves.map(s => [s.index, s]));
  const notes = [];
  const heads = elements.filter(e => e.role === 'notehead');
  const stems = elements.filter(e => e.role === 'stem');
  const dots = elements.filter(e => e.role === 'dot');
  const flags = elements.filter(e => e.role === 'flag');
  const accs = elements.filter(e => e.role === 'accidental');
  const ledgers = elements.filter(e => e.role === 'ledger' || e.role === 'ledger?');

  /* 기둥 배정 — 빔으로 묶인 음표들은 기둥이 다닥다닥 붙어 있어서, 앞에서부터
     아무거나 집어 가면 뒤 음표가 남의 기둥을 쓰게 된다. 그래서 (음표, 기둥)
     쌍을 전부 만들어 어울리는 정도 순으로 짝지어 준다. */
  const pairs = [];
  for (const h of heads) {
    const s = byIndex.get(h.system);
    if (!s) continue;
    const ss = s.space;
    for (const st of stems) {
      if (st.system !== h.system) continue;
      const dx = (st.x0 - h.x) / ss;
      if (dx < -0.55 || dx > 1.9) continue;
      if (!(st.y0 - 0.5 * ss <= h.y && h.y <= st.y1 + 0.5 * ss)) continue;
      const reach = Math.max(st.y1 - h.y, h.y - st.y0) / ss;
      const endGap = Math.min(Math.abs(st.y0 - h.y), Math.abs(st.y1 - h.y)) / ss;
      const side = dx < 0.5 ? Math.abs(dx) : Math.abs(dx - 1.3);
      pairs.push([side * 2 + endGap - reach * 0.05, h, st]);
    }
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const stemOf = new Map(), taken = new Set();
  for (const [, h, st] of pairs) {
    if (stemOf.has(h) || taken.has(st)) continue;
    stemOf.set(h, st); taken.add(st);
  }

  for (const h of heads) {
    const s = byIndex.get(h.system);
    if (!s) continue;
    const ss = s.space;
    const n = new Note(h, s);
    n.stem = stemOf.get(h) || null;

    for (const d of dots) {
      if (d.system !== h.system) continue;
      if (d.x - h.x > 0.4 * ss && d.x - h.x < 3.2 * ss && Math.abs(d.y - h.y) <= 0.75 * ss) n.parts.push(d);
    }
    for (const a of accs) {
      if (a.system !== h.system) continue;
      if (h.x - a.x > 0 && h.x - a.x < 2.6 * ss && Math.abs(a.y - h.y) <= 0.6 * ss) {
        n.accidental = a; n.parts.push(a);
      }
    }
    for (const lg of ledgers) {
      if (lg.system !== h.system) continue;
      if (lg.x0 - 0.7 * ss <= h.x + 0.6 * ss && h.x + 0.6 * ss <= lg.x1 + 0.7 * ss &&
          Math.abs(lg.y0 - h.y) < 0.55 * ss &&
          !(s.bottom - 0.4 * ss < lg.y0 && lg.y0 < s.top + 0.4 * ss)) {
        n.ledgers.push(lg);
        lg.role = 'ledger';
      }
    }
    notes.push(n);
  }

  // 음표머리가 확인해 주지 않은 짧은 수평선은 덧줄이 아니다 (온쉼표의 막대 등)
  for (const lg of ledgers) if (lg.role === 'ledger?') lg.role = 'other';

  // 깃발은 기둥의 자유로운 끝에 붙는다
  for (const f of flags) {
    let best = null, bestd = 1e9;
    for (const n of notes) {
      if (!n.stem || n.stem.system !== f.system) continue;
      const ss = n.staff.space;
      for (const ey of [n.stem.y0, n.stem.y1]) {
        const d = Math.abs(f.x - n.stem.x0) + Math.abs(f.y - ey) * 0.5;
        if (d < bestd && Math.abs(f.x - n.stem.x0) < 1.2 * ss) { best = n; bestd = d; }
      }
    }
    if (best) best.parts.push(f);
  }
  return notes;
}
/* ===========================================================================
   5부: PDF 다루기 껍데기 + 이조 본체 (scorelib/transpose.py)

   이조는 결국 '모든 음을 같은 간격만큼 올리거나 내리는 일' 이다. 오선 위에서
   그것은 모든 음높이 요소를 같은 거리만큼 세로로 옮기는 것과 같다. 그래서
   레이아웃·가사·마디선은 손대지 않고 네 가지만 다시 계산한다.
     1. 음표·기둥·빔·이음줄·임시표를 같은 거리만큼 이동
     2. 덧줄은 새 음높이에 맞춰 다시 그림
     3. 조표는 새 조로 교체 (조가 바뀌는 자리의 제자리표까지)
     4. 코드 기호는 새 이름으로 교체
   =========================================================================== */

// ------------------------------------------------------------ PDF 껍데기

class Pdf {
  constructor(doc) {
    this.doc = doc;
    this.ctx = doc.context;
    this.L = PDFLib;
    this._fonts = new Map();
  }
  static async load(bytes) {
    const doc = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
    return new Pdf(doc);
  }
  get pageCount() { return this.doc.getPageCount(); }
  page(i) { return this.doc.getPage(i); }
  pageSize(i) { return this.page(i).getSize(); }

  _lookup(num, gen) {
    try { return this.ctx.lookup(this.L.PDFRef.of(num, gen || 0)); }
    catch (e) { return null; }
  }
  objText(num, gen) {
    const o = this._lookup(num, gen);
    if (!o) return null;
    if (o instanceof this.L.PDFRawStream) return o.dict.toString();
    return o.toString();
  }
  streamText(num, gen) {
    const o = this._lookup(num, gen);
    if (!o || !(o instanceof this.L.PDFRawStream)) return null;
    try { return b2s(this.L.decodePDFRawStream(o).decode()); }
    catch (e) { return null; }
  }
  resources(i) {
    const page = this.page(i);
    let res = page.node.get(this.L.PDFName.of('Resources'));
    res = res ? this.ctx.lookup(res) : null;
    return res;
  }
  fonts(i) {
    if (this._fonts.has(i)) return this._fonts.get(i);
    const out = [];
    const res = this.resources(i);
    const fdict = res ? this.ctx.lookup(res.get(this.L.PDFName.of('Font'))) : null;
    if (fdict) {
      for (const key of fdict.keys()) {
        const fd = this.ctx.lookup(fdict.get(key));
        if (!fd || !fd.get) continue;
        const base = String(fd.get(this.L.PDFName.of('BaseFont')) || '').replace(/^\//, '');
        out.push({
          res: key.toString(),
          base,
          sub: String(fd.get(this.L.PDFName.of('Subtype')) || ''),
          dictText: fd.toString(),
        });
      }
    }
    this._fonts.set(i, out);
    return out;
  }
  contentText(i) {
    const page = this.page(i);
    const cont = page.node.get(this.L.PDFName.of('Contents'));
    const resolved = this.ctx.lookup(cont);
    const parts = [];
    if (resolved instanceof this.L.PDFArray) {
      for (let k = 0; k < resolved.size(); k++) parts.push(this.ctx.lookup(resolved.get(k)));
    } else if (resolved) parts.push(resolved);
    return parts.map(s => {
      try { return b2s(this.L.decodePDFRawStream(s).decode()); } catch (e) { return ''; }
    }).join('\n');
  }
  setContent(i, text) {
    const stream = this.ctx.flateStream(s2b(text));
    const ref = this.ctx.register(stream);
    this.page(i).node.set(this.L.PDFName.of('Contents'), ref);
  }
  hasImages(i) {
    const res = this.resources(i);
    const xo = res ? this.ctx.lookup(res.get(this.L.PDFName.of('XObject'))) : null;
    if (!xo) return false;
    for (const key of xo.keys()) {
      const o = this.ctx.lookup(xo.get(key));
      const sub = o && o.dict ? String(o.dict.get(this.L.PDFName.of('Subtype'))) : '';
      if (sub === '/Image') return true;
    }
    return false;
  }
  async addFallbackFont(i, tag) {
    try {
      const font = await this.doc.embedStandardFont(this.L.StandardFonts.TimesRoman);
      const res = this.resources(i);
      if (!res) return false;
      let fdict = this.ctx.lookup(res.get(this.L.PDFName.of('Font')));
      if (!fdict) { fdict = this.ctx.obj({}); res.set(this.L.PDFName.of('Font'), fdict); }
      fdict.set(this.L.PDFName.of(tag), font.ref);
      this._fonts.delete(i);
      return true;
    } catch (e) { return false; }
  }
  save() { return this.doc.save({ useObjectStreams: false }); }
}

// --------------------------------------------------------------- 모델

const MOVING_ROLES = new Set(['notehead', 'stem', 'flag', 'beam', 'slur', 'accidental']);
const SHARP_STEPS = { F: 8, C: 5, G: 9, D: 6, A: 3, E: 7, B: 4 };
const FLAT_STEPS = { B: 4, E: 7, A: 3, D: 6, G: 2, C: 5, F: 1 };

function medianOf(arr, dflt) {
  if (!arr.length) return dflt;
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

async function loadScore(pdf) {
  const pages = [];
  let idx = 0;
  for (let p = 0; p < pdf.pageCount; p++) {
    const cid = new Set(pdf.fonts(p).filter(f => f.sub === '/Type0').map(f => f.res));
    const text = pdf.contentText(p);
    const toks = tokenize(text);
    const widths = fontWidths(pdf, p);
    let els = extractElements(toks, cid, widths);
    const usage = new Map();
    for (const e of els) {
      if (e.kind !== 'text') continue;
      for (const c of e.codes) {
        const k = e.font + '|' + c;
        usage.set(k, (usage.get(k) || 0) + 1);
      }
    }
    const music = musicFontNames(pdf, p, usage);
    const italic = new Set(pdf.fonts(p).filter(f =>
      f.base.includes('Italic') || f.base.includes('Oblique')).map(f => f.res));
    const { roles, unis } = glyphRoles(pdf, p, music, usage);
    const chars = decodeChars(pdf, p);
    for (const e of els) {
      if (e.kind === 'text') {
        const t = elementText(chars, e.font, e.codes);
        if (t) e.char = t;
      }
    }
    const clefYs = els.filter(e => e.kind === 'text' && e.codes.length &&
      roles.get(e.font + '|' + e.codes[0]) === 'clef').map(e => e.y);
    const staves = detectStaves(els, p, idx, clefYs);
    idx += staves.length;
    classify(els, staves, cid, music, italic, roles, unis);
    const notes = groupNotes(els, staves);
    pages.push({
      pageNo: p, tokens: toks, elements: els, staves, notes,
      cidFonts: cid, musicFonts: music, chars, widths,
      qDepth: qDepth(toks), base: baseCtm(toks),
    });
  }
  return pages;
}

/* 이 악보를 다룰 수 있는지 미리 살핀다. 못 읽는 악보를 억지로 바꾸면
   엉뚱한 결과가 나온다. 그럴 바에는 왜 안 되는지 알려 주는 편이 낫다. */
function diagnose(pdf, pages) {
  const problems = [];
  const totalStaves = pages.reduce((a, p) => a + p.staves.length, 0);
  const totalNotes = pages.reduce((a, p) => a + p.notes.length, 0);
  if (totalStaves === 0) {
    const scanned = pages.some(p => pdf.hasImages(p.pageNo) &&
      !p.elements.some(e => e.kind === 'text'));
    problems.push(scanned
      ? '스캔한 사진 악보입니다. 컴퓨터로 조판한 PDF(음표가 글자·선으로 들어 있는 악보)만 다룰 수 있습니다.'
      : '오선을 찾지 못했습니다. 악보 PDF 가 맞는지 확인해 주세요.');
    return problems;
  }
  const blind = pages.filter(p => p.staves.length && !p.notes.length).map(p => p.pageNo + 1);
  if (blind.length) {
    problems.push(`${blind.join(', ')}쪽의 음표를 읽지 못했습니다. 처음 보는 악보 글꼴이라 음높이를 알 수 없습니다.`);
  } else if (totalNotes < totalStaves * 3) {
    problems.push(`오선 ${totalStaves}단에 견주어 읽어낸 음표가 ${totalNotes}개뿐입니다. 악보를 제대로 읽지 못한 것 같습니다.`);
  }
  return problems;
}

// ------------------------------------------------------------- 조표 읽기

function collectKeyGroups(pages) {
  const groups = [];
  for (const pm of pages) {
    for (const s of pm.staves) {
      const items = pm.elements.filter(e => e.system === s.index && e.role === 'keysig')
        .sort((a, b) => a.x - b.x);
      if (!items.length) continue;
      let run = [];
      for (const e of items) {
        if (run.length && e.x - run[run.length - 1].x > 2.2 * s.space) { groups.push(makeGroup(s, run)); run = []; }
        run.push(e);
      }
      if (run.length) groups.push(makeGroup(s, run));
    }
  }
  groups.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1]);
  return groups;
}

function makeGroup(s, run) {
  const sharps = run.filter(e => e.alter === 1).length;
  const flats = run.filter(e => e.alter === -1).length;
  const x0 = Math.min(...run.map(e => e.x));
  return { staff: s, items: run, fifths: sharps ? sharps : -flats,
           order: [s.index, Math.trunc(x0)], x0, newFifths: 0 };
}

function keyAt(groups, system, x) {
  let cur = 0;
  for (const g of groups) {
    if (g.order[0] < system || (g.order[0] === system && g.x0 <= x + 0.1)) cur = g.fifths;
    else break;
  }
  return cur;
}

// ------------------------------------------------------------- 코드 읽기

/* 코드 줄의 글자들을 코드 단위로 묶는다. 가로 간격으로 자르면 'F  C/E' 처럼
   붙은 자리에서 틀리므로, 글꼴과 글자를 보고 문법으로 읽는다. */
function collectChords(pages) {
  const out = [];
  for (const pm of pages) {
    for (const s of pm.staves) {
      const row = pm.elements.filter(e => e.system === s.index &&
        ['chord_root', 'chord_suffix', 'chord_accidental'].includes(e.role))
        .sort((a, b) => a.x - b.x);
      let cur = null, afterSlash = false, accTarget = null;

      const flush = () => {
        if (cur && cur.root) {
          out.push({
            staff: s,
            chord: new Chord(cur.root[0], cur.root[1], cur.suffix.join(''),
                             cur.bass ? cur.bass[0] : null, cur.bass ? cur.bass[1] : 0),
            rootEl: cur.rootEl, rootAcc: cur.rootAcc,
            bassEl: cur.bassEl, bassAcc: cur.bassAcc,
            others: cur.others, x0: cur.x0,
          });
        }
        cur = null;
      };

      for (const e of row) {
        const ch = e.char ? e.char[0] : null;
        if (ch && e.role === 'chord_root' && 'ABCDEFG'.includes(ch)) {
          if (afterSlash && cur) { cur.bass = [ch, 0]; cur.bassEl = e; afterSlash = false; }
          else {
            flush();
            cur = { root: [ch, 0], rootEl: e, rootAcc: null, bass: null, bassEl: null,
                    bassAcc: null, suffix: [], others: [], x0: e.x };
          }
          accTarget = e;
          continue;
        }
        if (ch === '/') { if (cur) { afterSlash = true; accTarget = null; cur.others.push(e); } continue; }
        if (['♭', '♯', '♮'].includes(ch) && cur) {
          e.role = 'chord_accidental';
          e.alter = { '♭': -1, '♯': 1, '♮': 0 }[ch];
        }
        if (e.role === 'chord_accidental' && cur) {
          const alter = e.alter || 0;
          const prev = accTarget;
          if (prev && e.x - prev.x > 0 && e.x - prev.x < 2.2 * s.space) {
            accTarget = null;
            if (cur.bassEl === prev) { cur.bass = [cur.bass[0], alter]; cur.bassAcc = e; }
            else { cur.root = [cur.root[0], alter]; cur.rootAcc = e; }
          } else {
            cur.others.push(e);
            cur.suffix.push(alter < 0 ? 'b' : '#');
          }
          continue;
        }
        if (cur) { accTarget = null; cur.others.push(e); if (e.char) cur.suffix.push(e.char); }
      }
      flush();
    }
  }
  return out;
}

/* 코드 기호 속의 낯선 ♭ · ♯ 글자를 조성으로 추론한다. 악보마다 코드용
   글꼴이 달라 ♭ 이 '¨' 이기도 하고 '„' 이기도 하다. 하지만 음악 쪽에서 보면
   답이 거의 정해져 있다 — A장조 악보에서 'C' 뒤의 기호는 C♯ 일 수밖에 없다. */
function resolveUnknownAccidentals(pages, groups) {
  const votes = new Map();
  for (const pm of pages) {
    for (const s of pm.staves) {
      const row = pm.elements.filter(e => e.system === s.index &&
        ['chord_root', 'chord_suffix', 'chord_accidental'].includes(e.role))
        .sort((a, b) => a.x - b.x);
      for (let i = 1; i < row.length; i++) {
        const prev = row[i - 1], e = row[i];
        if (e.alter !== null || prev.role !== 'chord_root') continue;
        const ch = e.char ? e.char[0] : '';
        if (ch && (/[A-Za-z0-9]/.test(ch) || '/()-+, .'.includes(ch))) continue;
        if (!(e.x - prev.x > 0 && e.x - prev.x < 2.2 * s.space)) continue;
        const letter = prev.char[0];
        if (!LETTERS.includes(letter)) continue;
        const hint = keyAlter(keyAt(groups, s.index, e.x), letter);
        if (!hint) continue;
        const key = e.font + '|' + (e.codes.length ? e.codes[0] : -1);
        if (!votes.has(key)) votes.set(key, new Map());
        const t = votes.get(key);
        t.set(hint, (t.get(hint) || 0) + 1);
      }
    }
  }
  const decided = new Map(), notes = [];
  for (const [key, tally] of votes) {
    let best = null, bestN = 0, total = 0;
    for (const [a, n] of tally) { total += n; if (n > bestN) { best = a; bestN = n; } }
    if (bestN >= Math.max(2, total * 0.7)) decided.set(key, best);
  }
  if (!decided.size) return notes;
  for (const pm of pages) {
    for (const e of pm.elements) {
      const k = e.font + '|' + (e.codes.length ? e.codes[0] : -1);
      if (e.alter === null && decided.has(k) &&
          ['chord_root', 'chord_suffix', 'chord_accidental'].includes(e.role)) {
        e.alter = decided.get(k);
        e.role = 'chord_accidental';
      }
    }
  }
  for (const [, alter] of decided) {
    notes.push(`코드의 ${alter < 0 ? '내림표' : '올림표'}를 조성으로 알아냈습니다.`);
  }
  return [...new Set(notes)];
}
/* ===========================================================================
   6부: 글꼴 자료와 이조 실행
   =========================================================================== */

// 세리프 본문 글꼴의 대문자 폭 (1/1000 em). 원본에서 재지 못한 글자를
// 어림잡을 때만 쓴다.
const TIMES_WIDTH = { A: 0.722, B: 0.667, C: 0.667, D: 0.722, E: 0.611, F: 0.556, G: 0.722 };

class FontKit {
  constructor() {
    this.chordFont = '';
    this.chordSize = 11;
    this.chordFontIsCid = false;
    this.codeOfLetter = new Map();
    this.glyphWidth = new Map();     // pt
    this.accGlyph = new Map();       // alter -> [font, code, size]
    this.fallbackFont = '';
    this.widthScale = 1.2;
    this.letterKern = 0.7;
    this.accAdvance = 2.8;
    this.chordAccDy = 2.1;
    this.chordAccSize = 12.8;
    this.ledgerPadLeft = 0.9;
    this.ledgerPadRight = 8;
    this.ledgerWidth = 0.47;
    this.cidFonts = new Set();
    this.widths = new Map();
  }
  letterWidth(letter) {
    const w = this.glyphWidth.get(letter);
    if (w !== undefined) return w;
    return (TIMES_WIDTH[letter] || 0.7) * this.chordSize * this.widthScale;
  }
}

async function buildFontKits(pdf, pages, chords) {
  const kits = new Map();
  const dys = [], sizes = [], accadv = [], kerns = [];
  const lefts = [], rights = [], widths = [];
  for (const pm of pages) {
    for (const n of pm.notes) {
      for (const lg of n.ledgers) {
        lefts.push(n.head.x - lg.x0);
        rights.push(lg.x1 - n.head.x);
        widths.push(lg.lineWidth);
      }
    }
  }

  for (const pm of pages) {
    const kit = new FontKit();
    kit.widths = pm.widths;
    kit.cidFonts = pm.cidFonts;
    const mine = chords.filter(c => c.staff.page === pm.pageNo);
    if (mine.length) {
      kit.chordFont = mine[0].rootEl.font;
      kit.chordSize = mine[0].rootEl.size;
    }
    if (kit.chordFont) {
      kit.chordFontIsCid = pm.cidFonts.has(kit.chordFont);
      for (const [key, ch] of pm.chars) {
        const sep = key.lastIndexOf('|');
        if (key.slice(0, sep) !== kit.chordFont) continue;
        if (!'ABCDEFG'.includes(ch)) continue;
        const code = parseInt(key.slice(sep + 1));
        // 글꼴이 번호를 어떤 글자로 읽는지 말해 주더라도 부분집합 글꼴에는
        // 그 글자가 실제로 없을 수 있다. 폭이 잡혀 있어야 진짜 있는 글자다.
        if (!((pm.widths.get(key) || 0) > 0)) continue;
        if (!kit.codeOfLetter.has(ch)) kit.codeOfLetter.set(ch, code);
      }
      if ('ABCDEFG'.split('').some(L => !kit.codeOfLetter.has(L))) {
        if (await pdf.addFallbackFont(pm.pageNo, 'ZXTR')) kit.fallbackFont = '/ZXTR';
      }
    }
    const rank = { keysig: 0, accidental: 1, chord_accidental: 2 };
    const bestRank = new Map();
    for (const e of pm.elements) {
      const r = rank[e.role];
      if (e.alter === null || r === undefined || !e.codes.length) continue;
      if (!bestRank.has(e.alter) || r < bestRank.get(e.alter)) {
        bestRank.set(e.alter, r);
        kit.accGlyph.set(e.alter, [e.font, e.codes[0], e.size]);
      }
    }
    kits.set(pm.pageNo, kit);

    // 글자 폭은 원본에서 직접 잰다
    const obs = new Map();
    for (const c of mine) {
      for (const [letter, el, acc] of [[c.chord.rootLetter, c.rootEl, c.rootAcc],
                                       [c.chord.bassLetter, c.bassEl, c.bassAcc]]) {
        if (!el || !letter) continue;
        const nxt = [c.rootAcc, ...c.others, c.bassEl, c.bassAcc]
          .filter(e => e && e.x > el.x + 0.1).sort((a, b) => a.x - b.x);
        if (!nxt.length) continue;
        if (nxt[0].role === 'chord_accidental') continue;
        if (!obs.has(letter)) obs.set(letter, []);
        obs.get(letter).push(nxt[0].x - el.x);
      }
    }
    for (const [letter, vals] of obs) kit.glyphWidth.set(letter, medianOf(vals, 0));
    const ratios = [];
    for (const [L, w] of kit.glyphWidth) {
      if (TIMES_WIDTH[L] && kit.chordSize) ratios.push(w / (TIMES_WIDTH[L] * kit.chordSize));
    }
    if (ratios.length) kit.widthScale = medianOf(ratios, 1.2);

    for (const c of mine) {
      for (const [letter, el, acc] of [[c.chord.rootLetter, c.rootEl, c.rootAcc],
                                       [c.chord.bassLetter, c.bassEl, c.bassAcc]]) {
        if (!acc || !el || !letter) continue;
        dys.push(acc.y - el.y);
        sizes.push(acc.size);
        kerns.push(acc.x - el.x - kit.letterWidth(letter));
        const after = [...c.others, c.bassEl].filter(e => e && e.x > acc.x + 0.1)
          .sort((a, b) => a.x - b.x);
        if (after.length) accadv.push(after[0].x - acc.x);
      }
    }
  }

  for (const kit of kits.values()) {
    kit.chordAccDy = medianOf(dys, 2.1);
    kit.chordAccSize = medianOf(sizes, 12.8);
    kit.accAdvance = medianOf(accadv, 2.8);
    kit.letterKern = medianOf(kerns, 0.7);
    kit.ledgerPadLeft = medianOf(lefts, 0.9);
    kit.ledgerPadRight = medianOf(rights, 8);
    kit.ledgerWidth = medianOf(widths, 0.47);
  }
  return kits;
}

function escapePdf(ch) { return '()\\'.includes(ch) ? '\\' + ch : ch; }

function paintAccidental(p, kit, alter, x, y, ss, size) {
  const g = kit.accGlyph.get(alter);
  if (g) {
    const [font, code, gsize0] = g;
    const gsize = size || gsize0;
    const isCid = kit.cidFonts.has(font);
    p.text(font, gsize, x, y,
      isCid ? code.toString(16).toUpperCase().padStart(4, '0') : escapePdf(String.fromCharCode(code)),
      isCid);
    const w = kit.widths.get(font + '|' + code);
    return w ? w * gsize : kit.accAdvance;
  }
  return drawAccidental(p, alter, x, y, ss);
}

function clefOf(pages, s) {
  for (const pm of pages) {
    if (pm.pageNo !== s.page) continue;
    const clefs = pm.elements.filter(e => e.system === s.index && e.role === 'clef');
    if (clefs.length) {
      const cp = clefs.reduce((a, b) => (a.x <= b.x ? a : b)).uni;
      if (cp === 63 || (cp >= 0xE062 && cp <= 0xE069)) return 'bass';
      return 'treble';
    }
  }
  return 'treble';
}

function clefShift(pages, s) { return clefOf(pages, s) === 'bass' ? -2 : 0; }

// 조표가 들어갈 수 있는 가로 구간 (왼쪽 한계, 오른쪽 한계)
function keysigRoom(pages, s, g) {
  let left = s.x0 + 0.5 * s.space, right = null;
  for (const pm of pages) {
    if (pm.pageNo !== s.page) continue;
    const clefs = pm.elements.filter(e => e.system === s.index && e.role === 'clef' && e.x < g.x0 + 0.5).map(e => e.x);
    if (clefs.length) left = Math.max(...clefs) + 2.9 * s.space;
    const xs = pm.elements.filter(e => e.system === s.index &&
      ['timesig', 'notehead', 'rest', 'barline'].includes(e.role) && e.x > g.x0 + 0.5).map(e => e.x);
    if (xs.length) right = Math.min(...xs) - 0.5 * s.space;
  }
  return [left, right];
}

function intervalFromSemitones(src, semitones) {
  let best = null;
  for (let steps = -12; steps <= 12; steps++) {
    const probe = new Interval(steps, semitones);
    const [letter, alter] = transposePitch(src[0], src[1], probe, false);
    if (Math.abs(alter) > 1) continue;
    if (FIFTHS_BY_MAJOR[noteName(letter, alter)] === undefined) continue;
    const score = Math.abs(steps * 2 - semitones);
    if (best === null || score < best[0]) best = [score, probe];
  }
  if (best === null) throw new Error(`${semitones}반음으로는 적을 수 있는 조가 나오지 않습니다`);
  return best[1];
}

/* 코드 기호 하나를 지우고 새 이름으로 다시 적는다. 글자 몇 개만 바꿔 끼우지
   않고 기호 전체를 다시 그린다 — 어떤 PDF 는 한 덩어리 안에서 글자들이
   서로의 자리를 이어받기 때문에, 가운데 하나만 건드리면 뒤가 모두 어긋난다.
   접미사는 원래 글꼴·글자 그대로 다시 찍으므로 모습은 달라지지 않는다. */
function repaintChord(p, kit, c, iv, simplify, rep) {
  const nw = c.chord.transposed(iv, simplify);
  const ss = c.staff.space;
  const y = c.rootEl.y;

  const els = [c.rootEl, c.rootAcc, ...c.others, c.bassEl, c.bassAcc]
    .filter(e => e).sort((a, b) => a.x - b.x);
  const adv = new Map();
  for (let i = 0; i + 1 < els.length; i++) adv.set(els[i], els[i + 1].x - els[i].x);
  if (els.length) {
    const last = els[els.length - 1];
    const w = last.codes.reduce((a, cd) => a + (kit.widths.get(last.font + '|' + cd) ?? 0.5), 0);
    adv.set(last, w * last.size);
  }

  if (!kit.codeOfLetter.has(nw.rootLetter) && !kit.fallbackFont) {
    rep.warnings.push(`코드 글꼴에 '${nw.rootLetter}' 글자가 없어 그 코드는 그대로 두었습니다.`);
    return;
  }
  for (const e of els) e.erase();

  let cursor = c.x0;
  const putLetter = (letter) => {
    const code = kit.codeOfLetter.get(letter);
    if (code !== undefined) {
      p.text(kit.chordFont, kit.chordSize, cursor, y,
        kit.chordFontIsCid ? code.toString(16).toUpperCase().padStart(4, '0') : escapePdf(String.fromCharCode(code)),
        kit.chordFontIsCid);
    } else if (kit.fallbackFont) {
      p.text(kit.fallbackFont, kit.chordSize, cursor, y, escapePdf(letter));
    } else {
      rep.warnings.push(`'${letter}' 음이름을 찍을 글꼴을 찾지 못했습니다.`);
    }
    return kit.letterWidth(letter);
  };
  const putOriginal = (e) => {
    const isCid = kit.cidFonts.has(e.font);
    const payload = isCid
      ? e.codes.map(cd => cd.toString(16).toUpperCase().padStart(4, '0')).join('')
      : e.codes.map(cd => escapePdf(String.fromCharCode(cd))).join('');
    p.text(e.font, e.size, cursor, y + (e.y - c.rootEl.y), payload, isCid);
    return adv.get(e) ?? 0.4 * kit.chordSize;
  };

  cursor += putLetter(nw.rootLetter);
  if (nw.rootAlter) {
    cursor += kit.letterKern;
    cursor += paintAccidental(p, kit, nw.rootAlter, cursor, y + kit.chordAccDy, ss, kit.chordAccSize);
  }
  for (const e of c.others) cursor += putOriginal(e);
  if (c.bassEl && nw.bassLetter) {
    cursor += putLetter(nw.bassLetter);
    if (nw.bassAlter) {
      cursor += kit.letterKern;
      paintAccidental(p, kit, nw.bassAlter, cursor, y + kit.chordAccDy, ss, kit.chordAccSize);
    }
  }
}

// ----------------------------------------------------------- 이조 실행

async function applyTranspose(pdf, pages, opts) {
  const rep = { sourceKey: '', targetKey: '', interval: '', staves: 0, notes: 0,
                chords: 0, keysigs: 0, ledgersAdded: 0, accidentals: 0,
                blocked: false, warnings: [], chordPairs: [] };
  const groups = collectKeyGroups(pages);
  rep.warnings.push(...resolveUnknownAccidentals(pages, groups));
  const chords = collectChords(pages);
  const kits = await buildFontKits(pdf, pages, chords);

  rep.staves = pages.reduce((a, p) => a + p.staves.length, 0);
  rep.notes = pages.reduce((a, p) => a + p.notes.length, 0);
  rep.chords = chords.length;
  rep.keysigs = groups.length;

  const problems = diagnose(pdf, pages);
  if (problems.length) { rep.warnings.unshift(...problems); rep.blocked = true; return rep; }

  const srcFifths = groups.length ? groups[0].fifths : 0;
  const srcName = MAJOR_BY_FIFTHS[srcFifths];
  const src = parseNoteName(srcName);
  let iv, dst;
  if (opts.to) { dst = parseNoteName(opts.to); iv = intervalBetween(src, dst, opts.prefer || 'near'); }
  else if (opts.by !== undefined && opts.by !== null) {
    iv = intervalFromSemitones(src, opts.by);
    dst = transposePitch(src[0], src[1], iv, false);
  } else throw new Error('목표 조나 반음 수가 필요합니다');

  rep.sourceKey = srcName;
  rep.targetKey = noteName(dst[0], dst[1]);
  rep.interval = iv.describe();
  if (iv.isUnison) {
    rep.warnings.push(`이 악보는 이미 ${rep.sourceKey} 조입니다. 바꿀 것이 없습니다.`);
    rep.blocked = true;
    return rep;
  }

  const half = pages[0].staves[0].half;
  const dy = iv.steps * half;
  const simplify = opts.simplify !== false;

  // 1) 음높이에 매인 것들을 한꺼번에 옮긴다
  for (const pm of pages) {
    const seen = new Set();
    const targets = [];
    for (const e of pm.elements) {
      if (MOVING_ROLES.has(e.role) && !seen.has(e)) { seen.add(e); targets.push(e); }
    }
    for (const n of pm.notes) for (const e of n.parts) {
      if (!seen.has(e)) { seen.add(e); targets.push(e); }
    }
    shiftTogether(targets, dy);
  }

  const painters = new Map(pages.map(p => [p.pageNo, new Painter()]));

  // 2) 덧줄을 새 음높이에 맞춰 다시 놓는다
  let badSteps = 0;
  for (const pm of pages) {
    const p = painters.get(pm.pageNo);
    const kit = kits.get(pm.pageNo);
    for (const n of pm.notes) {
      const s = n.staff;
      const newStep = s.stepOf(n.head.y);
      let need = [];
      if (Math.abs(newStep) > 24) { badSteps++; need = []; }
      else if (newStep >= 10) { for (let k = 10; k <= newStep; k += 2) need.push(k); }
      else if (newStep <= -2) { for (let k = -2; k >= newStep; k -= 2) need.push(k); }
      const have = n.ledgers.slice().sort((a, b) =>
        Math.abs(a.y0 - n.head.y) - Math.abs(b.y0 - n.head.y));
      need.forEach((step, i) => {
        const yy = s.yOf(step);
        if (i < have.length) have[i].shift(yy - have[i].y0);
        else {
          p.line(n.head.x - kit.ledgerPadLeft, yy, n.head.x + kit.ledgerPadRight, yy, kit.ledgerWidth);
          rep.ledgersAdded++;
        }
      });
      have.slice(need.length).forEach(e => e.erase());
    }
  }
  if (badSteps) {
    rep.warnings.push(`보표에서 너무 멀리 떨어진 음표가 ${badSteps}개 있습니다. 결과를 확인해 주세요.`);
  }

  // 3) 조표를 새 조로 바꾼다
  for (const g of groups) g.newFifths = transposeKey(g.fifths, iv);
  const tight = [];
  let prevNew = null;
  for (const g of groups) {
    const s = g.staff, ss = s.space;
    const p = painters.get(s.page), kit = kits.get(s.page);
    const cshift = clefShift(pages, s);
    const alter = g.newFifths > 0 ? 1 : -1;

    const plan = [];
    if (prevNew !== null && prevNew !== g.newFifths) {
      for (const letter of keysigLetters(prevNew)) {
        if (keysigLetters(g.newFifths).includes(letter)) continue;
        plan.push([0, (prevNew > 0 ? SHARP_STEPS : FLAT_STEPS)[letter]]);
      }
    }
    for (const letter of keysigLetters(g.newFifths)) {
      plan.push([alter, (g.newFifths > 0 ? SHARP_STEPS : FLAT_STEPS)[letter]]);
    }

    const probe = new Painter();
    const unit = plan.length ? paintAccidental(probe, kit, alter, 0, 0, ss) : 0;
    let stepX = Math.max(unit * 1.12, 0.75 * ss);
    let width = stepX * plan.length;
    const [left, right] = keysigRoom(pages, s, g);
    let x = g.x0;
    if (right !== null && x + width > right) {
      x = Math.max(left, right - width);
      if (x + width > right && plan.length) {
        stepX = Math.max((right - x) / plan.length, unit);
        width = stepX * plan.length;
      }
    }
    if (right !== null && x + width > right + 0.3) tight.push(x + width - right);

    for (const [a, step] of plan) {
      paintAccidental(p, kit, a, x, s.yOf(step + cshift), ss);
      x += stepX;
    }
    for (const e of g.items) e.erase();
    prevNew = g.newFifths;
  }
  if (tight.length) {
    rep.warnings.push(`새 조표가 원래보다 넓은 단이 ${tight.length}곳 있습니다 (최대 ${Math.max(...tight).toFixed(1)}pt). 조표와 첫 음이 겹치지 않는지 보세요.`);
  }

  // 4) 음표에 붙은 임시표를 새 조 기준으로 다시 적는다
  for (const pm of pages) {
    const p = painters.get(pm.pageNo), kit = kits.get(pm.pageNo);
    for (const n of pm.notes) {
      if (!n.accidental || n.accidental.hidden) continue;
      const s = n.staff;
      const oldStep = s.stepOf(n.head.y) - iv.steps;
      const [letter] = stepToPitch(oldStep, clefOf(pages, s));
      const written = n.accidental.alter || 0;
      const [, newAlter] = transposePitch(letter, written, iv, false);
      rep.accidentals++;
      if (newAlter === written) continue;
      n.accidental.erase();
      paintAccidental(p, kit, newAlter, n.accidental.x, n.head.y, s.space, n.accidental.size);
    }
  }

  // 5) 코드 기호를 새 이름으로 다시 적는다
  //    어떻게 바뀌었는지 앞부분을 모아 두면 결과를 눈으로 확인하기 좋다
  const pairs = [];
  for (const c of chords) {
    const before = c.chord.name();
    const after = c.chord.transposed(iv, simplify).name();
    if (!pairs.some(p => p[0] === before)) pairs.push([before, after]);
    repaintChord(painters.get(c.staff.page), kits.get(c.staff.page), c, iv, simplify, rep);
  }
  rep.chordPairs = pairs;

  // 6) 바뀐 명령을 페이지에 써 넣는다
  for (const pm of pages) {
    let body = serialize(pm.tokens);
    const extra = painters.get(pm.pageNo).render();
    if (extra.trim()) {
      if (pm.qDepth > 0) body += '\n' + 'Q '.repeat(pm.qDepth);
      const inv = invert(pm.base);
      body += '\nq ' + inv.map(nf6).join(' ') + ' cm' + extra + '\nQ\n';
    }
    pdf.setContent(pm.pageNo, body);
  }

  rep.warnings = [...new Set(rep.warnings)];
  return rep;
}

/* 바꾸지 않고 악보만 읽어 본다 */
async function inspectScore(bytes) {
  const pdf = await Pdf.load(bytes);
  const pages = await loadScore(pdf);
  const problems = diagnose(pdf, pages);
  const groups = collectKeyGroups(pages);
  resolveUnknownAccidentals(pages, groups);
  const chords = collectChords(pages);
  const changes = [];
  let last = null;
  for (const g of groups) {
    if (last !== null && g.fifths !== last) changes.push(MAJOR_BY_FIFTHS[g.fifths]);
    last = g.fifths;
  }
  const seen = [];
  for (const c of chords) { const n = c.chord.name(); if (!seen.includes(n)) seen.push(n); }
  return {
    problems,
    key: groups.length ? MAJOR_BY_FIFTHS[groups[0].fifths] : 'C',
    fifths: groups.length ? groups[0].fifths : 0,
    staves: pages.reduce((a, p) => a + p.staves.length, 0),
    notes: pages.reduce((a, p) => a + p.notes.length, 0),
    chords: chords.length,
    chordNames: seen,
    keyChanges: changes,
  };
}

/* 실제로 이조해 새 PDF 바이트를 돌려준다 */
async function transposeScore(bytes, opts) {
  const pdf = await Pdf.load(bytes);
  const pages = await loadScore(pdf);
  const rep = await applyTranspose(pdf, pages, opts);
  if (rep.blocked) return { rep, bytes: null };
  return { rep, bytes: await pdf.save() };
}
