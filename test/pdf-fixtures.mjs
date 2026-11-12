import { deflateSync } from 'node:zlib';

// Small valid PDFs with deterministic, asymmetric text and physical page order.
export function pdf(pages, fontSize = 16) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (const lines of pages) {
    const id = objects.length + 1;
    kids.push(`${id} 0 R`);
    // null creates a raster-only page; [] creates an empty page.
    const [, , width = 612, height = 792] = lines?.box?.split(' ').map(Number) || [];
    const raster = lines?.rgb ? `q ${width} 0 0 ${height} 0 0 cm BI /W ${lines.width} /H ${lines.height} /CS /RGB /BPC 8 /F [/AHx /Fl] ID ${deflateSync(lines.rgb).toString('hex')}> EI Q\n`.repeat(lines.repeat || 1) : '';
    const textLines = lines?.rgb ? (lines.lines || []) : lines;
    const stream = lines === null
      ? 'q 200 0 0 100 40 600 cm BI /W 2 /H 2 /CS /RGB /BPC 8 /F /AHx ID FF000000FF000000FFFFFFFF> EI Q'
      : raster + textLines.map((line, i) => `BT /F1 ${fontSize} Tf 40 ${740 - i * fontSize * 1.5} Td (${line.replace(/[\\()]/g, '\\$&')}) Tj ET`).join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [${lines?.box || '0 0 612 792'}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(' ')}] >>`;
  let result = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(result);
  result += `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(result);
}

export const reportPdf = pdf([
  ['Harbour project H-731', 'North depot: 7 crates at $13.40 each.'],
  ['South depot: 3 crates at $21.15 each.', 'Delivery: $8.60.'],
  ['Reference code: KOWHAI-92.', 'Approval remains pending.'],
]);

// Generated 1-bit CCITT Group 3 stripes, not a giant RGB allocation or a
// committed scan. Each row is independently encoded; all run lengths use the
// standard T.4 makeup/terminating codes (width is a multiple of 2560).
export function largeScanPdf({ width = 7680, height = 6400, copies = 1, sameImage = false, softMask = false, formGroup = false, decodeRows = height } = {}) {
  const white = '000000011111'.repeat(width / 2560) + '00110101';
  const black = '00110101' + '000000011111'.repeat(width / 2560) + '0000110111';
  let bits = '';
  for (let y = 0; y < height; y++) bits += Math.floor(y / 400) % 2 ? black : white;
  bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
  const bytes = Buffer.alloc(bits.length / 8);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const data = bytes.toString('hex');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> /XObject << /Scan 6 0 R /Other 7 0 R ${formGroup ? '/GroupA 8 0 R /GroupB 9 0 R' : ''} >> >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const content = 'BT /F1 16 Tf 40 760 Td (Native header, image body follows.) Tj ET\n' +
    Array.from({ length: copies }, (_, i) => formGroup
      ? `/${i ? 'GroupB' : 'GroupA'} Do`
      : `q 532 0 0 650 40 60 cm /${i && !sameImage ? 'Other' : 'Scan'} Do Q`).join('\n');
  objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const image = `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter [/ASCIIHexDecode /CCITTFaxDecode] /DecodeParms [null << /K 0 /Columns ${width} /Rows ${decodeRows} /EndOfBlock false >>] /Length ${data.length + 1} >>\nstream\n${data}>\nendstream`;
  objects.push(softMask ? image.replace('/Subtype /Image', '/Subtype /Image /SMask 7 0 R') : image, image);
  if (formGroup) {
    for (const name of ['Scan', 'Other']) {
      const stream = `q 532 0 0 650 40 60 cm /${name} Do Q`;
      objects.push(`<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Group << /S /Transparency >> /Resources << /XObject << /Scan 6 0 R /Other 7 0 R >> >> /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    }
  }
  let result = '%PDF-1.4\n';
  const offsets = [];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(result));
    result += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(result);
}
