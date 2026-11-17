import { loadImage } from "@napi-rs/canvas";
import { AppError, errors } from "../errors.js";

export const MAX_PRODUCT_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PIXELS = 25_000_000;
const MAX_DIMENSION = 8192;

function jpegDimensions(buffer: Buffer): [number, number] | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset++] !== 0xff) return null;
    while (buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    if (marker === undefined || marker === 0xda || marker === 0xd9) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) return null;
      return [buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3)];
    }
    offset += length;
  }
  return null;
}

function dimensions(buffer: Buffer, mimeType: string): [number, number] | null {
  if (mimeType === "image/png") {
    if (buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      buffer.readUInt32BE(8) !== 13 || buffer.toString("ascii", 12, 16) !== "IHDR") return null;
    return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
  }
  if (mimeType === "image/jpeg") return jpegDimensions(buffer);
  if (mimeType !== "image/webp" || buffer.length < 25 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP" ||
    buffer.readUInt32LE(4) + 8 !== buffer.length) return null;
  const kind = buffer.toString("ascii", 12, 16);
  if (kind === "VP8X" && buffer.length >= 30) return [1 + buffer.readUIntLE(24, 3), 1 + buffer.readUIntLE(27, 3)];
  if (kind === "VP8L" && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  if (kind === "VP8 " && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return [buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff];
  }
  return null;
}

export async function validateProductImage(buffer: Buffer, mimeType: string): Promise<void> {
  if (buffer.length > MAX_PRODUCT_IMAGE_BYTES) throw new AppError(413, "PAYLOAD_TOO_LARGE", "The image exceeds 5 MiB.");
  if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType)) {
    throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Use a JPEG, PNG, or WebP image.");
  }
  const size = dimensions(buffer, mimeType);
  if (!size) throw errors.validation([{ field: "file", message: "The image is invalid or does not match its MIME type." }]);
  const [width, height] = size;
  if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    throw errors.validation([{ field: "file", message: "The image dimensions exceed the allowed limit." }]);
  }
  try {
    const image = await loadImage(buffer);
    if (image.width !== width || image.height !== height) throw new Error("Image dimensions do not match.");
  } catch {
    throw errors.validation([{ field: "file", message: "The image could not be decoded." }]);
  }
}
