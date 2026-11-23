/* ===========================================================================
   브라우저에서 코드 글자 읽기

   맥용은 맥에 들어 있는 글자 읽기(Vision)를 쓰지만 브라우저에는 그런 것이
   없다. 그래서 Tesseract 를 쓴다. 처음 쓸 때만 내려받고(5MB 남짓),
   그 뒤로는 바로 쓴다 — 미리보기가 pdf.js 를 그때 받는 것과 같은 방식이다.

   날것 그대로는 ♯ 을 'i' 로 읽고 '/' 를 흘린다. 다만 이게 중구난방이
   아니라 규칙적이라, 아래 몇 가지로 되돌릴 수 있다. 실측으로 87% 까지
   맞았다 (맥의 내장 글자 읽기는 95%).
   =========================================================================== */

const TESS_VER = '5.1.1';
const TESS_BASE = 'https://cdn.jsdelivr.net/npm/tesseract.js@' + TESS_VER + '/dist';

/* 코드 기호에 나올 수 있는 글자만 통과시킨다. 알파벳 전체를 열어 두면
   'F#' 을 'FH' 로, 'Am' 을 'Arn' 으로 읽는 일이 생긴다. */
const CHORD_CHARS = 'ABCDEFGabdefgijmnorsuΔø°+-#()/0123456789';

let _tessLib = null;
let _tessWorker = null;

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('글자 읽기 도구를 불러오지 못했습니다.'));
    document.head.appendChild(s);
  });
}

async function tessWorker(onProgress) {
  if (_tessWorker) return _tessWorker;
  if (!_tessLib) {
    if (onProgress) onProgress('글자 읽기 도구를 받는 중…');
    await loadScriptOnce(TESS_BASE + '/tesseract.min.js');
    _tessLib = window.Tesseract;
    if (!_tessLib) throw new Error('글자 읽기 도구를 불러오지 못했습니다.');
  }
  if (onProgress) onProgress('글자 읽기 준비 중…');
  _tessWorker = await _tessLib.createWorker('eng', 1, {
    workerPath: TESS_BASE + '/worker.min.js',
    corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.0',
    langPath: 'https://tessdata.projectnaptha.com/4.0.0',
  });
  await _tessWorker.setParameters({
    tessedit_char_whitelist: CHORD_CHARS,
    // PSM 4 (크기가 들쭉날쭉한 한 단) 가 코드 띠에 가장 잘 맞았다. 7 은
    // 글자는 잘 읽지만 상자가 헐거워 'A/E' 와 'B/D#' 을 한 덩어리로 묶고,
    // 11 은 엉뚱한 토막을 더 만든다.
    tessedit_pageseg_mode: '4',
  });
  return _tessWorker;
}

/* 캔버스 하나를 읽어 토막들을 돌려준다. 자리는 그 캔버스의 픽셀. */
async function ocrCanvas(canvas, onProgress) {
  const w = await tessWorker(onProgress);
  const { data } = await w.recognize(canvas);
  const out = [];
  for (const word of (data.words || [])) {
    const t = (word.text || '').trim();
    if (!t) continue;
    const bb = word.bbox || {};
    out.push({
      text: t,
      x: bb.x0 || 0,
      y: bb.y0 || 0,
      w: (bb.x1 || 0) - (bb.x0 || 0),
      h: (bb.y1 || 0) - (bb.y0 || 0),
      conf: (word.confidence || 0) / 100,
    });
  }
  return out;
}

async function ocrRelease() {
  if (_tessWorker) { try { await _tessWorker.terminate(); } catch (e) {} }
  _tessWorker = null;
}

// ------------------------------------------------------------- 바로잡기

/* 앞에 달라붙은 소문자 쓰레기 ('uC#m7' → 'C#m7').
   마디번호나 이음줄 끄트머리가 글자로 읽힌 것이다. */
const RE_JUNK = /^[a-z]+(?=[A-G])/;

/* ♯ 을 'i' 나 'l' 로 읽는다. 코드에 i·l 이 쓰일 일은 없다. */
const RE_SHARP = /([A-G])[il]/g;

/* '/' 를 흘린다. 음이름이 둘 잇달아 나올 수는 없으므로 사이에 끼운다.
   ('F#E' → 'F#/E', 'F#mE' → 'F#m/E') */
const RE_SLASH = /^([A-G][#b]?(?:m|maj|sus\d|dim|aug|add\d|\d)*)([A-G][#b]?)$/;

function fixChordText(raw) {
  let t = String(raw).trim();
  t = t.replace(RE_JUNK, '');
  t = t.replace(RE_SHARP, '$1#');
  t = t.replace(/#{2,}/g, '#');     // 'Fi#sus4' → 'F##sus4' → 'F#sus4'
  const m = RE_SLASH.exec(t);
  if (m) t = m[1] + '/' + m[2];
  return t;
}
