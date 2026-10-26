/* ===========================================================================
   이조한 악보 미리보기

   내려받기 전에 결과를 눈으로 확인할 수 있게 쪽을 그려 준다.
   그리는 라이브러리(pdf.js)는 1MB 가 넘으므로, 미리보기를 처음 누를 때에만
   불러온다. 쓰지 않는 사람은 받지 않는다.
   =========================================================================== */

let _pdfjs = null;

function loadPdfJs() {
  if (_pdfjs) return _pdfjs;
  _pdfjs = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = './pdf.min.js';
    s.onload = () => {
      const lib = window.pdfjsLib;
      if (!lib) { reject(new Error('미리보기 도구를 불러오지 못했습니다.')); return; }
      lib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.js';
      resolve(lib);
    };
    s.onerror = () => reject(new Error('미리보기 도구를 불러오지 못했습니다.'));
    document.head.appendChild(s);
  });
  return _pdfjs;
}

/* bytes 를 container 안에 쪽마다 그린다 */
async function renderPreview(bytes, container, onPage) {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({ data: bytes.slice() }).promise;
  container.textContent = '';

  const wide = Math.min(container.clientWidth || 640, 900);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = wide / base.width;
    const vp = page.getViewport({ scale });

    const wrap = document.createElement('div');
    wrap.className = 'pv-page';
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width * dpr);
    canvas.height = Math.round(vp.height * dpr);
    canvas.style.width = '100%';
    canvas.style.aspectRatio = `${vp.width} / ${vp.height}`;
    const label = document.createElement('span');
    label.className = 'pv-num';
    label.textContent = `${i} / ${doc.numPages}`;
    wrap.append(canvas, label);
    container.appendChild(wrap);

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, vp.width, vp.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    if (onPage) onPage(i, doc.numPages);
  }
  return doc.numPages;
}
