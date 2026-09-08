/**
 * Builds a minimal, structurally valid single- or multi-page PDF from raw
 * content-stream bodies, with a byte-accurate xref. Used to make test fixtures
 * for the ingestion pipeline (WikiBookLM backend/test/ingest).
 *
 * `options.encrypt` — a dictionary body string (e.g. `<< /Filter /Standard ... >>`)
 * to attach to the trailer so pdf.js applies the security handler to it.
 */
export function buildMinimalPdf(pages: string[], options: { encrypt?: string } = {}) {
  const objects: string[] = [];
  // Object numbering: catalog=1, pages=2, page*, content*, font*, [encrypt].
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  const firstPage = 3;
  const firstContent = firstPage + pages.length;
  const firstFont = firstContent + pages.length;

  objects.push(
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${firstPage + i} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  );
  pages.forEach((stream, i) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${firstContent + i} 0 R /Resources << /Font << /F1 ${firstFont + i} 0 R >> >> >>`,
    );
  });
  pages.forEach((stream) => {
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  pages.forEach(() => {
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  });

  const encryptIndex = options.encrypt ? objects.length + 1 : null;
  if (options.encrypt) objects.push(options.encrypt);

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets[i] = Buffer.byteLength(body, 'utf8');
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, 'utf8');
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    body += `${String(offsets[i - 1]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryptIndex ? ` /Encrypt ${encryptIndex} 0 R` : ''} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'utf8');
}