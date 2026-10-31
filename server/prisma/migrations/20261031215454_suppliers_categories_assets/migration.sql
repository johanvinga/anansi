-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "name_key" VARCHAR(200) NOT NULL,
    "street" VARCHAR(200),
    "city" VARCHAR(100),
    "state_region" VARCHAR(100),
    "postal_code" VARCHAR(20),
    "country" VARCHAR(100),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "name_key" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_categories" (
    "supplier_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,

    CONSTRAINT "supplier_categories_pkey" PRIMARY KEY ("supplier_id","category_id")
);

-- CreateTable
CREATE TABLE "supplier_assets" (
    "id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "original_file_name" VARCHAR(255) NOT NULL,
    "storage_key" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "title" VARCHAR(200),
    "description" TEXT,
    "uploaded_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_name_key_key" ON "suppliers"("name_key");

-- CreateIndex
CREATE UNIQUE INDEX "categories_name_key_key" ON "categories"("name_key");

-- CreateIndex
CREATE INDEX "supplier_categories_category_id_idx" ON "supplier_categories"("category_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_assets_storage_key_key" ON "supplier_assets"("storage_key");

-- CreateIndex
CREATE INDEX "supplier_assets_supplier_id_idx" ON "supplier_assets"("supplier_id");

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_categories" ADD CONSTRAINT "supplier_categories_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_categories" ADD CONSTRAINT "supplier_categories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_assets" ADD CONSTRAINT "supplier_assets_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_assets" ADD CONSTRAINT "supplier_assets_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
