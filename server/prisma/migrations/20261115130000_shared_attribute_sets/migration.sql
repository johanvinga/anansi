CREATE TABLE "attribute_set_fields" (
  "attribute_set_id" UUID NOT NULL,
  "attribute_field_id" UUID NOT NULL,
  "is_required" BOOLEAN NOT NULL DEFAULT false,
  "is_archived" BOOLEAN NOT NULL DEFAULT false,
  "sort_order" INTEGER NOT NULL,
  CONSTRAINT "attribute_set_fields_pkey" PRIMARY KEY ("attribute_set_id", "attribute_field_id"),
  CONSTRAINT "attribute_set_fields_attribute_set_id_fkey" FOREIGN KEY ("attribute_set_id") REFERENCES "attribute_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "attribute_set_fields_attribute_field_id_fkey" FOREIGN KEY ("attribute_field_id") REFERENCES "attribute_fields"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "attribute_set_fields_attribute_field_id_idx" ON "attribute_set_fields"("attribute_field_id");
