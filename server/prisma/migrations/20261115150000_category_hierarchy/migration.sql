ALTER TABLE "categories" ADD COLUMN "parent_id" UUID;
DROP INDEX "categories_name_key_key";
ALTER TABLE "categories"
  ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "categories_parent_name_key" UNIQUE NULLS NOT DISTINCT ("parent_id", "name_key") DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "categories_not_own_parent" CHECK ("parent_id" IS DISTINCT FROM "id");
CREATE INDEX "categories_name_key_idx" ON "categories"("name_key");
