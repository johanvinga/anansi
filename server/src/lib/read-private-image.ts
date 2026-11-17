import { AppError, errors } from "../errors.js";
import type { AssetStorage } from "./asset-storage.js";
import { MAX_PRODUCT_IMAGE_BYTES } from "./product-image.js";

export async function readPrivateImage(storage: AssetStorage, key: string, expectedSize: number): Promise<Buffer> {
  try {
    if (!(await storage.exists(key))) throw errors.notFound("Image file");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of storage.openRead(key)) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += data.length;
      if (size > MAX_PRODUCT_IMAGE_BYTES) throw errors.conflict("Stored image exceeds the size limit.");
      chunks.push(data);
    }
    if (size !== expectedSize) throw errors.conflict("Stored image size does not match its metadata.");
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new Error("Could not read the image from private storage.");
  }
}
