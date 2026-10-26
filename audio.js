/* ===========================================================================
   음원 키 바꾸기

   속도는 그대로 두고 음높이만 올리거나 내린다. SoundTouch 의 시간 늘이기와
   다시 뽑기(resampling)를 엮은 방식이라, 반음 두어 개까지는 연습용으로 쓸 만
   하고 그보다 많이 옮기면 소리가 뭉개지는 티가 난다. 원리상 피할 수 없다.

   파일은 이 기기 안에서만 다룬다. 어디로도 올라가지 않는다.
   =========================================================================== */

let _st = null;

async function loadSoundTouch() {
  if (!_st) _st = await import('./soundtouch.min.js');
  return _st;
}

/* 오디오 파일을 읽어 소리 데이터로 만든다 */
async function decodeAudio(file) {
  const buf = await file.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    return await ctx.decodeAudioData(buf);
  } finally {
    if (ctx.close) ctx.close();
  }
}

/* 음높이만 semitones 만큼 옮긴 소리 데이터를 돌려준다.

   처리기는 안쪽에 소리를 조금 머금고 있어서 그냥 돌리면 끝부분 0.2초쯤이
   빠져나오지 못한다. 길이가 밀리는 것이 아니라 꼬리만 잘리는 것인데,
   뒤에 잠깐의 무음을 붙여 밀어낸 뒤 원래 길이로 잘라 맞춘다. */
async function shiftPitch(audioBuffer, semitones, onProgress) {
  const { SoundTouch, SimpleFilter, WebAudioBufferSource } = await loadSoundTouch();

  const sr = audioBuffer.sampleRate;
  const chCount = audioBuffer.numberOfChannels;
  const tail = Math.ceil(sr * 0.6);
  let padded = audioBuffer;
  try {
    padded = new AudioBuffer({ length: audioBuffer.length + tail,
                               numberOfChannels: chCount, sampleRate: sr });
    for (let c = 0; c < chCount; c++) padded.copyToChannel(audioBuffer.getChannelData(c), c, 0);
  } catch (e) { /* 못 만들면 원본 그대로 — 끝 0.2초가 짧아질 뿐이다 */ }

  const st = new SoundTouch();
  st.pitchSemitones = semitones;
  st.tempo = 1;                       // 빠르기는 건드리지 않는다

  const source = new WebAudioBufferSource(padded);
  const filter = new SimpleFilter(source, st);

  const channels = Math.min(chCount, 2);
  const CHUNK = 8192;
  const interleaved = new Float32Array(CHUNK * 2);
  const left = [], right = [];
  let total = 0;
  const expected = padded.length;

  for (;;) {
    const got = filter.extract(interleaved, CHUNK);
    if (got <= 0) break;
    const l = new Float32Array(got), r = new Float32Array(got);
    for (let i = 0; i < got; i++) {
      l[i] = interleaved[i * 2];
      r[i] = interleaved[i * 2 + 1];
    }
    left.push(l); right.push(r);
    total += got;
    if (onProgress && (left.length % 8 === 0)) {
      onProgress(Math.min(0.99, total / expected));
      await new Promise(r2 => setTimeout(r2, 0));   // 화면이 멈추지 않도록
    }
  }
  if (onProgress) onProgress(1);

  // 원래 길이에 맞춰 자른다 (붙여 둔 무음을 덜어낸다)
  const want = Math.min(total, audioBuffer.length);
  const merge = (parts) => {
    const out = new Float32Array(want);
    let at = 0;
    for (const p of parts) {
      if (at >= want) break;
      const take = Math.min(p.length, want - at);
      out.set(take === p.length ? p : p.subarray(0, take), at);
      at += take;
    }
    return out;
  };
  return {
    sampleRate: sr,
    channels: channels === 1 ? 1 : 2,
    data: channels === 1 ? [merge(left)] : [merge(left), merge(right)],
    length: want,
  };
}

/* 소리 데이터를 WAV 파일 바이트로 */
function toWav(res) {
  const { sampleRate, channels, data, length } = res;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = length * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };

  str(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);                       // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, 8 * bytesPerSample, true);
  str(36, 'data');
  v.setUint32(40, dataSize, true);

  let off = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < channels; c++) {
      let s = data[c][i];
      s = s < -1 ? -1 : s > 1 ? 1 : s;            // 넘치면 깎는다
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Uint8Array(buf);
}

function formatTime(sec) {
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
