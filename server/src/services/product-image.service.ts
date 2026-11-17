import type { AssetDeps } from "./asset.service.js";
import { errors } from "../errors.js";
import { validateProductImage } from "../lib/product-image.js";
import { readPrivateImage } from "../lib/read-private-image.js";
import { AuditAction, recordAudit, type AuditRequestContext } from "./audit.service.js";
import { commitStagedImage, discardStagedImage, queueStoredFileRemoval, stageImage } from "./stored-file-cleanup.js";

function metadata(image: { mimeType: string; sizeBytes: number } | null) {
  return image ? { mimeType: image.mimeType, sizeBytes: image.sizeBytes } : null;
}

export async function uploadProductImage(
  deps: AssetDeps, request: AuditRequestContext, productId: string, buffer: Buffer, mimeType: string,
) {
  await validateProductImage(buffer, mimeType);
  const key = await stageImage(deps.db, deps.storage, buffer, mimeType);
  try {
    return await deps.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId}::uuid FOR UPDATE`;
      const product = await tx.product.findUnique({ where: { id: productId }, include: { image: true } });
      if (!product) throw errors.notFound("Product");
      const image = await tx.productImage.upsert({
        where: { productId },
        create: { productId, storageKey: key, mimeType, sizeBytes: buffer.length },
        update: { storageKey: key, mimeType, sizeBytes: buffer.length },
      });
      await commitStagedImage(tx, key);
      if (product.image) await queueStoredFileRemoval(tx, product.image.storageKey);
      await recordAudit(tx, request, {
        action: AuditAction.PRODUCT_IMAGE_UPDATE, outcome: "success", entityType: "Product", entityId: productId,
        changes: { image: { before: metadata(product.image), after: metadata(image) } },
      });
      return { image: metadata(image), cleanupPending: product.image !== null };
    });
  } catch (error) {
    await discardStagedImage(deps.db, key);
    throw error;
  }
}

export async function deleteProductImage(deps: AssetDeps, request: AuditRequestContext, productId: string): Promise<void> {
  await deps.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId}::uuid FOR UPDATE`;
    const image = await tx.productImage.findUnique({ where: { productId } });
    if (!image) throw errors.notFound("Product image");
    await tx.productImage.delete({ where: { productId } });
    await queueStoredFileRemoval(tx, image.storageKey);
    await recordAudit(tx, request, {
      action: AuditAction.PRODUCT_IMAGE_UPDATE, outcome: "success", entityType: "Product", entityId: productId,
      changes: { image: { before: metadata(image), after: null } },
    });
  });
}

export async function getProductImage(deps: AssetDeps, request: AuditRequestContext, productId: string) {
  return deps.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId}::uuid FOR UPDATE`;
    const image = await tx.productImage.findUnique({ where: { productId } });
    if (!image) throw errors.notFound("Product image");
    const buffer = await readPrivateImage(deps.storage, image.storageKey, image.sizeBytes);
    await recordAudit(tx, request, {
      action: AuditAction.PRODUCT_IMAGE_VIEW, outcome: "success", entityType: "Product", entityId: productId,
    });
    return { ...metadata(image)!, buffer };
  }, { timeout: 120_000 });
}
