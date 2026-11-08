-- CreateTable
CREATE TABLE "catalogs" (
    "id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "version" VARCHAR(50) NOT NULL,
    "original_file_name" VARCHAR(255) NOT NULL,
    "storage_key" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "uploaded_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "catalogs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "catalogs_storage_key_key" ON "catalogs"("storage_key");

-- CreateIndex
CREATE INDEX "catalogs_supplier_id_idx" ON "catalogs"("supplier_id");

-- AddForeignKey
ALTER TABLE "catalogs" ADD CONSTRAINT "catalogs_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogs" ADD CONSTRAINT "catalogs_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
