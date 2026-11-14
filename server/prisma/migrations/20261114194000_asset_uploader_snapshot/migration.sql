ALTER TABLE "supplier_assets"
  ADD COLUMN "uploader_id" UUID,
  ADD COLUMN "uploader_name" VARCHAR(254);

UPDATE "supplier_assets" AS asset
SET "uploader_id" = asset."uploaded_by_id",
    "uploader_name" = COALESCE(NULLIF(TRIM(u."display_name"), ''), u."email")
FROM "users" AS u
WHERE asset."uploaded_by_id" = u."id";
