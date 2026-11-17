import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ loadImage: vi.fn() }));
vi.mock("@napi-rs/canvas", () => ({ loadImage: mocks.loadImage }));

import { MAX_PRODUCT_IMAGE_BYTES, validateProductImage } from "./product-image.js";

function pngHeader(width: number, height: number, size = 24): Buffer {
  const buffer = Buffer.alloc(size);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

describe("product image limits", () => {
  beforeEach(() => {
    mocks.loadImage.mockReset();
    mocks.loadImage.mockImplementation(async (buffer: Buffer) => ({
      width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20),
    }));
  });

  it("accepts exactly 5 MiB and rejects a larger upload", async () => {
    await expect(validateProductImage(pngHeader(8, 8, MAX_PRODUCT_IMAGE_BYTES), "image/png")).resolves.toBeUndefined();
    await expect(validateProductImage(pngHeader(8, 8, MAX_PRODUCT_IMAGE_BYTES + 1), "image/png")).rejects.toMatchObject({ statusCode: 413 });
    expect(mocks.loadImage).toHaveBeenCalledTimes(1);
  });

  it("checks pixel and dimension limits before decoding", async () => {
    await expect(validateProductImage(pngHeader(5000, 5000), "image/png")).resolves.toBeUndefined();
    await expect(validateProductImage(pngHeader(5001, 5000), "image/png")).rejects.toMatchObject({ statusCode: 400 });
    await expect(validateProductImage(pngHeader(8192, 1), "image/png")).resolves.toBeUndefined();
    await expect(validateProductImage(pngHeader(8193, 1), "image/png")).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.loadImage).toHaveBeenCalledTimes(2);
  });
});
