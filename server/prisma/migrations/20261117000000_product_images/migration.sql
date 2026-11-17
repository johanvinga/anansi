CREATE TABLE "product_images" (
  "product_id" UUID NOT NULL,
  "storage_key" VARCHAR(255) NOT NULL,
  "mime_type" VARCHAR(100) NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  CONSTRAINT "product_images_pkey" PRIMARY KEY ("product_id"),
  CONSTRAINT "product_images_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "product_images_storage_key_key" ON "product_images"("storage_key");

CREATE TABLE "stored_file_cleanup" (
  "storage_key" VARCHAR(255) NOT NULL,
  "available_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "stored_file_cleanup_pkey" PRIMARY KEY ("storage_key")
);
CREATE INDEX "stored_file_cleanup_available_at_idx" ON "stored_file_cleanup"("available_at");

CREATE TABLE "catalog_image_candidates" (
  "id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "storage_key" VARCHAR(255) NOT NULL,
  "page_number" INTEGER NOT NULL,
  "mime_type" VARCHAR(100) NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  CONSTRAINT "catalog_image_candidates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "catalog_image_candidates_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "catalog_extraction_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "catalog_image_candidates_storage_key_key" ON "catalog_image_candidates"("storage_key");
CREATE INDEX "catalog_image_candidates_job_id_page_number_idx" ON "catalog_image_candidates"("job_id", "page_number");
