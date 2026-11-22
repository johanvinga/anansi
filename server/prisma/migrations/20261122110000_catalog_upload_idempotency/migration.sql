-- AlterTable
ALTER TABLE "catalogs"
ADD COLUMN "upload_idempotency_key" VARCHAR(128),
ADD COLUMN "upload_request_hash" CHAR(64);

-- CreateIndex
CREATE UNIQUE INDEX "catalogs_uploaded_by_id_upload_idempotency_key_key"
ON "catalogs"("uploaded_by_id", "upload_idempotency_key");
