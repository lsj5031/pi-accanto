// Small valid PDFs with deterministic, asymmetric text and physical page order.
export function pdf(pages, fontSize = 16) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (const lines of pages) {
    const id = objects.length + 1;
    kids.push(`${id} 0 R`);
    // null creates a raster-only page; [] creates an empty page.
    const stream = lines === null
      ? 'q 200 0 0 100 40 600 cm BI /W 2 /H 2 /CS /RGB /BPC 8 /F /AHx ID FF000000FF000000FFFFFFFF> EI Q'
      : lines.map((line, i) => `BT /F1 ${fontSize} Tf 40 ${740 - i * fontSize * 1.5} Td (${line.replace(/[\\()]/g, '\\$&')}) Tj ET`).join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
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
