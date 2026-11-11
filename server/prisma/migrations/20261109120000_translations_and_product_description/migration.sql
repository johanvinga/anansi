-- FR-I18N: translatable names get one column per locale.
-- Existing values are kept as English and copied into the French column, so every row has both values.

-- Categories
ALTER TABLE "categories" RENAME COLUMN "name" TO "name_en";
ALTER TABLE "categories" ADD COLUMN "name_fr" VARCHAR(100);
UPDATE "categories" SET "name_fr" = "name_en";
ALTER TABLE "categories" ALTER COLUMN "name_fr" SET NOT NULL;

-- Attribute sets
ALTER TABLE "attribute_sets" RENAME COLUMN "name" TO "name_en";
ALTER TABLE "attribute_sets" ADD COLUMN "name_fr" VARCHAR(100);
UPDATE "attribute_sets" SET "name_fr" = "name_en";
ALTER TABLE "attribute_sets" ALTER COLUMN "name_fr" SET NOT NULL;

-- Attribute fields
ALTER TABLE "attribute_fields" RENAME COLUMN "name" TO "name_en";
ALTER TABLE "attribute_fields" ADD COLUMN "name_fr" VARCHAR(100);
UPDATE "attribute_fields" SET "name_fr" = "name_en";
ALTER TABLE "attribute_fields" ALTER COLUMN "name_fr" SET NOT NULL;

-- Attribute options (unique index follows the English label, FR-I18N-09)
ALTER TABLE "attribute_options" RENAME COLUMN "label" TO "label_en";
ALTER TABLE "attribute_options" ADD COLUMN "label_fr" VARCHAR(100);
UPDATE "attribute_options" SET "label_fr" = "label_en";
ALTER TABLE "attribute_options" ALTER COLUMN "label_fr" SET NOT NULL;
ALTER INDEX "attribute_options_attribute_field_id_label_key" RENAME TO "attribute_options_attribute_field_id_label_en_key";

-- Products: translated name and new optional description (FR-PRD-10)
ALTER TABLE "products" RENAME COLUMN "name" TO "name_en";
ALTER TABLE "products" ADD COLUMN "name_fr" VARCHAR(200);
UPDATE "products" SET "name_fr" = "name_en";
ALTER TABLE "products" ALTER COLUMN "name_fr" SET NOT NULL;
ALTER TABLE "products" ADD COLUMN "description_en" TEXT, ADD COLUMN "description_fr" TEXT;
ALTER INDEX "products_name_idx" RENAME TO "products_name_en_idx";
