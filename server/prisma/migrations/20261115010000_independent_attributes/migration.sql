-- Existing set fields and product values keep their identifiers and definitions.
ALTER TABLE "attribute_fields" ALTER COLUMN "attribute_set_id" DROP NOT NULL;
CREATE UNIQUE INDEX "independent_attribute_name_key"
  ON "attribute_fields" (lower(btrim("name_en")))
  WHERE "attribute_set_id" IS NULL;
