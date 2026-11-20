-- AlterTable
ALTER TABLE "products" ADD COLUMN     "source_catalog_id" UUID,
ADD COLUMN     "source_page_numbers" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- CreateIndex
CREATE INDEX "products_source_catalog_id_idx" ON "products"("source_catalog_id");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_source_catalog_id_fkey" FOREIGN KEY ("source_catalog_id") REFERENCES "catalogs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
