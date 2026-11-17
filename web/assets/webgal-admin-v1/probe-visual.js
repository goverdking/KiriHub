// A visible frame is evidence of rendering, not proof of a playable title or audio.
export function sampleGameVisual(win) {
  const doc = win.document;
  const canvas = doc.querySelector('#canvas');
  const sources = [...doc.querySelectorAll('video')].filter(v => v.readyState >= 2 && v.videoWidth > 0 && win.getComputedStyle(v).display !== 'none');
  if (canvas?.width && canvas?.height && win.getComputedStyle(canvas).display !== 'none') sources.push(canvas);
  const thumbnail = doc.createElement('canvas');
  thumbnail.width = 48; thumbnail.height = 30;
  const context = thumbnail.getContext('2d', { willReadFrequently: true });
  for (const source of sources) {
    try {
      context.clearRect(0, 0, 48, 30);
      context.drawImage(source, 0, 0, 48, 30);
      const pixels = context.getImageData(0, 0, 48, 30).data;
      let lit = 0, low = 255, high = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (!pixels[i + 3]) continue;
        const brightness = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
        if (brightness > 20) lit++;
        low = Math.min(low, brightness); high = Math.max(high, brightness);
      }
      if (lit >= 5 && high - low >= 16) return { visible: true, source: source.tagName.toLowerCase() };
    } catch { /* Context loss, a blank backbuffer or unavailable video is not a pass. */ }
  }
  return { visible: false, source: null };
}
