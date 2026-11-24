-- Drop the unique constraint; PostgreSQL removes its backing index automatically.
ALTER TABLE "categories"
DROP CONSTRAINT "categories_parent_name_key";
