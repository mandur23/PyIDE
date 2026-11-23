// Province ids per texture pixel, decoded once from the id image (r << 16 | g << 8 | b) and kept on the CPU, so the
// province under the cursor is an array read and the GPU gets the same integers as an integer texture.
// Conquest.view.decodeIds(source, width, height, maxId) -> Promise<Uint16Array | Uint32Array>; source is an
// HTMLImageElement, ImageBitmap or canvas. Conquest.view.picker(ids, width, height) -> { ids, at(mx, my) }.
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const view = (Conquest.view = Conquest.view || {});

  async function pixels(source, width, height) {
    if (source instanceof HTMLCanvasElement && source.width === width && source.height === height) {
      return source.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data;
    }
    // An image goes through a bitmap that keeps its bytes as stored: no colour management, no premultiplying.
    const bitmap = source instanceof ImageBitmap ? source
      : await createImageBitmap(source, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const canvas = new OffscreenCanvas(width, height);
    const g = canvas.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = false;
    g.drawImage(bitmap, 0, 0, width, height);
    if (bitmap !== source) bitmap.close();
    return g.getImageData(0, 0, width, height).data;
  }

  view.decodeIds = async (source, width, height, maxId) => {
    const px = await pixels(source, width, height);
    const ids = maxId < 65536 ? new Uint16Array(width * height) : new Uint32Array(width * height);
    for (let i = 0, o = 0; i < ids.length; i++, o += 4) ids[i] = (px[o] << 16) | (px[o + 1] << 8) | px[o + 2];
    return ids;
  };

  view.picker = (ids, width, height) => ({
    ids,
    at(mx, my) {
      const x = Math.floor(mx);
      const y = Math.floor(my);
      return x < 0 || y < 0 || x >= width || y >= height ? 0 : ids[y * width + x];
    },
  });
})();
