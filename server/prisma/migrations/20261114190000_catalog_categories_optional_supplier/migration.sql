ALTER TABLE "catalogs" DROP CONSTRAINT "catalogs_supplier_id_fkey";
ALTER TABLE "catalogs" ALTER COLUMN "supplier_id" DROP NOT NULL;
ALTER TABLE "catalogs" ADD CONSTRAINT "catalogs_supplier_id_fkey"
  FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "catalog_categories" (
  "catalog_id" UUID NOT NULL,
  "category_id" UUID NOT NULL,
  CONSTRAINT "catalog_categories_pkey" PRIMARY KEY ("catalog_id", "category_id"),
  CONSTRAINT "catalog_categories_catalog_id_fkey" FOREIGN KEY ("catalog_id") REFERENCES "catalogs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "catalog_categories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "catalog_categories_category_id_idx" ON "catalog_categories"("category_id");
