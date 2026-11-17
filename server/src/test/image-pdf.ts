import { deflateSync } from "node:zlib";

export function pdfWithImage(inForm = false): Buffer {
  const pixels = deflateSync(Buffer.from(Array.from({ length: 16 }, () => [240, 20, 20]).flat()));
  const imageContent = Buffer.from("q 100 0 0 100 20 20 cm /Im0 Do Q\n");
  const content = inForm ? Buffer.from("/Fm0 Do\n") : imageContent;
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im0 4 0 R${inForm ? " /Fm0 6 0 R" : ""} >> >> /Contents 5 0 R >>`),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${pixels.length} >>\nstream\n`), pixels, Buffer.from("\nendstream")]),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("endstream")]),
  ];
  if (inForm) objects.push(Buffer.concat([
    Buffer.from(`<< /Type /XObject /Subtype /Form /BBox [0 0 140 140] /Matrix [1 0 0 1 60 0] /Resources << /XObject << /Im0 4 0 R >> >> /Length ${imageContent.length} >>\nstream\n`),
    imageContent,
    Buffer.from("endstream"),
  ]));
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  const offsets = [0];
  let length = parts[0]!.length;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const part = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
    parts.push(part);
    length += part.length;
  }
  const xref = length;
  parts.push(Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(parts);
}
