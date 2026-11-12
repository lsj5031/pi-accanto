// PDF.js starts image decoding while building its operator list. Enforce the
// aggregate budget there, before decoding, not after receiving the list.
// Keep this narrow patch pinned to the installed PDF.js source, failing closed
// if an upstream change needs review. No dependency files are modified.
export function boundedPdfWorker(source) {
  const method = '  async buildPaintImageXObject({';
  if (source.split(method).length !== 2) throw new Error('Review PDF.js image-error patch for this version.');
  source = source.replace(method, `  async buildPaintImageXObject(options) {
    try {
      return await this.accantoBuildPaintImageXObject(options);
    } catch {
      // Preserve failures from small inline images and masks too, even if
      // PDF.js resolves a partial display list before reporting stream errors.
      options.operatorList.addOp(OPS.paintImageXObject, ["accanto_decode_error", 0, 0]);
    }
  }
  async accantoBuildPaintImageXObject({`);
  const anchor = '    const imageRef = dict.objId;\n    const w = dict.get("W", "Width");\n    const h = dict.get("H", "Height");';
  if (source.split(anchor).length !== 2) throw new Error('Review PDF.js image-budget patch for this version.');
  source = source.replace(anchor, `${anchor}
    // 64 Mi source pixels includes ordinary ~48MP bilevel document scans.
    // Charge every decoded image against a per-page 256 MiB RGBA-equivalent
    // budget, including images inside forms. Cached/repeated paints reuse data.
    const budget = operatorList.accantoBudget ||= { pixels: 0, count: 0 };
    const pixels = w * h;
    const used = budget.pixels + pixels;
    budget.count++;
    if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) ||
        w <= 0 || h <= 0 || !Number.isSafeInteger(used) ||
        used > 64 * 1024 * 1024 || budget.count > 4096) {
      // PDF.js may flush and resolve a partial operator list before rejecting
      // its stream. A sentinel survives that optimization; the reader rejects
      // it before rendering. Throwing here alone can produce a blank success.
      budget.pixels = Infinity;
      operatorList.addOp(OPS.paintImageXObject, ["accanto_source_limit", 0, 0]);
      return;
    }
    budget.pixels = used;
    image.accantoBudget = budget;
    image.accantoPrechargedPixels = pixels;`);
  const group = '      newOpList = new CheckedOperatorList();';
  if (source.split(group).length !== 2) throw new Error('Review PDF.js group-image budget patch for this version.');
  source = source.replace(group, `${group}
      newOpList.accantoBudget = operatorList.accantoBudget ||= { pixels: 0, count: 0 };`);
  const ccitt = '    const module = await this._getModule(jbig2);';
  if (source.split(ccitt).length !== 2) throw new Error('Review PDF.js CCITT parameter budget patch for this version.');
  source = source.replace(ccitt, `
    // CCITT's encoded row/column parameters can differ from its image
    // dictionary. Check them before entering the native/fallback decoder.
    if (CCITTOptions) {
      const columns = CCITTOptions.Columns;
      const rows = CCITTOptions.Rows || height;
      if (!Number.isSafeInteger(columns) || !Number.isSafeInteger(rows) ||
          columns <= 0 || rows <= 0 || columns * rows > 64 * 1024 * 1024) {
        throw new Jbig2Error("CCITT decode dimensions exceed the safe source budget.");
      }
    }
${ccitt}`);
  const decoded = '    this.decode = dict.getArray("D", "Decode");';
  if (source.split(decoded).length !== 2) throw new Error('Review PDF.js decoded-image budget patch for this version.');
  return source.replace(decoded, `
    // Validate actual decoder dimensions too (which may override the PDF
    // dictionary), including soft/explicit masks and high-component images.
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
        width <= 0 || height <= 0 || width * height > 64 * 1024 * 1024 ||
        ![1, 2, 4, 8, 16].includes(this.bpc) ||
        !Number.isSafeInteger(this.numComps) || this.numComps <= 0 ||
        Math.ceil(width * this.numComps * this.bpc / 8) * height > 256 * 1024 * 1024) {
      throw new Error("PDF decoded image or mask exceeds the safe source budget.");
    }
    if (image.accantoBudget) {
      const budget = image.accantoBudget;
      const cost = Math.max(width * height,
        Math.ceil(Math.ceil(width * this.numComps * this.bpc / 8) * height / 4));
      budget.pixels += cost - (image.accantoPrechargedPixels || 0);
      if (budget.pixels > 64 * 1024 * 1024) {
        throw new Error("PDF aggregate decoded image or mask budget exceeded.");
      }
      // Masks use the same page budget, not an independent full-size allowance.
      if (smask) smask.accantoBudget = budget;
      if (mask instanceof BaseStream) mask.accantoBudget = budget;
    }
${decoded}`);
}
