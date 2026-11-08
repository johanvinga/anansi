-- CreateEnum
CREATE TYPE "AttributeDataType" AS ENUM ('text', 'number', 'decimal', 'boolean', 'date', 'select');

-- CreateTable
CREATE TABLE "attribute_sets" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "name_key" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "attribute_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attribute_fields" (
    "id" UUID NOT NULL,
    "attribute_set_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "code" VARCHAR(100) NOT NULL,
    "data_type" "AttributeDataType" NOT NULL,
    "unit" VARCHAR(20),
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "attribute_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attribute_options" (
    "id" UUID NOT NULL,
    "attribute_field_id" UUID NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "attribute_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "supplier_sku" VARCHAR(100) NOT NULL,
    "sku_key" VARCHAR(100) NOT NULL,
    "min_quantity" INTEGER NOT NULL,
    "cost" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "attribute_set_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_attribute_values" (
    "product_id" UUID NOT NULL,
    "attribute_field_id" UUID NOT NULL,
    "value_text" TEXT,
    "value_number" DECIMAL(18,4),
    "value_boolean" BOOLEAN,
    "value_date" DATE,
    "option_id" UUID,

    CONSTRAINT "product_attribute_values_pkey" PRIMARY KEY ("product_id","attribute_field_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attribute_sets_name_key_key" ON "attribute_sets"("name_key");

-- CreateIndex
CREATE INDEX "attribute_fields_attribute_set_id_sort_order_idx" ON "attribute_fields"("attribute_set_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_fields_attribute_set_id_code_key" ON "attribute_fields"("attribute_set_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_options_attribute_field_id_label_key" ON "attribute_options"("attribute_field_id", "label");

-- CreateIndex
CREATE INDEX "products_supplier_id_idx" ON "products"("supplier_id");

-- CreateIndex
CREATE INDEX "products_name_idx" ON "products"("name");

-- CreateIndex
CREATE UNIQUE INDEX "products_supplier_id_sku_key_key" ON "products"("supplier_id", "sku_key");

-- CreateIndex
CREATE INDEX "product_attribute_values_attribute_field_id_idx" ON "product_attribute_values"("attribute_field_id");

-- AddForeignKey
ALTER TABLE "attribute_fields" ADD CONSTRAINT "attribute_fields_attribute_set_id_fkey" FOREIGN KEY ("attribute_set_id") REFERENCES "attribute_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribute_options" ADD CONSTRAINT "attribute_options_attribute_field_id_fkey" FOREIGN KEY ("attribute_field_id") REFERENCES "attribute_fields"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_attribute_set_id_fkey" FOREIGN KEY ("attribute_set_id") REFERENCES "attribute_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_attribute_values" ADD CONSTRAINT "product_attribute_values_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_attribute_values" ADD CONSTRAINT "product_attribute_values_attribute_field_id_fkey" FOREIGN KEY ("attribute_field_id") REFERENCES "attribute_fields"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_attribute_values" ADD CONSTRAINT "product_attribute_values_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "attribute_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Defense in depth for FR-PRD-02; the service layer validates first.
ALTER TABLE "products" ADD CONSTRAINT "products_min_quantity_check" CHECK ("min_quantity" >= 0);
ALTER TABLE "products" ADD CONSTRAINT "products_cost_check" CHECK ("cost" >= 0);

