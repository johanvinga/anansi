CREATE TABLE "tags" (
  "id" UUID NOT NULL,
  "name_en" VARCHAR(100) NOT NULL,
  "name_fr" VARCHAR(100) NOT NULL,
  "name_key" VARCHAR(100) NOT NULL,
  "is_archived" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tags_name_key_key" ON "tags"("name_key");

CREATE TABLE "product_tags" (
  "product_id" UUID NOT NULL,
  "tag_id" UUID NOT NULL,
  CONSTRAINT "product_tags_pkey" PRIMARY KEY ("product_id", "tag_id")
);
CREATE INDEX "product_tags_tag_id_idx" ON "product_tags"("tag_id");

CREATE TABLE "catalog_tags" (
  "catalog_id" UUID NOT NULL,
  "tag_id" UUID NOT NULL,
  CONSTRAINT "catalog_tags_pkey" PRIMARY KEY ("catalog_id", "tag_id")
);
CREATE INDEX "catalog_tags_tag_id_idx" ON "catalog_tags"("tag_id");

CREATE TABLE "supplier_tags" (
  "supplier_id" UUID NOT NULL,
  "tag_id" UUID NOT NULL,
  CONSTRAINT "supplier_tags_pkey" PRIMARY KEY ("supplier_id", "tag_id")
);
CREATE INDEX "supplier_tags_tag_id_idx" ON "supplier_tags"("tag_id");

INSERT INTO "tags" ("id", "name_en", "name_fr", "name_key", "is_archived", "created_at", "updated_at")
SELECT gen_random_uuid(), c."name_en", c."name_fr",
       lower(regexp_replace(btrim(c."name_en"), '[[:space:]]+', ' ', 'g')),
       false, COALESCE(c."created_at", CURRENT_TIMESTAMP), CURRENT_TIMESTAMP
FROM "categories" c
ON CONFLICT ("name_key") DO NOTHING;

INSERT INTO "product_tags" ("product_id", "tag_id")
SELECT DISTINCT pc."product_id", t."id"
FROM "product_categories" pc
JOIN "categories" c ON c."id" = pc."category_id"
JOIN "tags" t ON t."name_key" = lower(regexp_replace(btrim(c."name_en"), '[[:space:]]+', ' ', 'g'))
ON CONFLICT DO NOTHING;

INSERT INTO "catalog_tags" ("catalog_id", "tag_id")
SELECT DISTINCT cc."catalog_id", t."id"
FROM "catalog_categories" cc
JOIN "categories" c ON c."id" = cc."category_id"
JOIN "tags" t ON t."name_key" = lower(regexp_replace(btrim(c."name_en"), '[[:space:]]+', ' ', 'g'))
ON CONFLICT DO NOTHING;

INSERT INTO "supplier_tags" ("supplier_id", "tag_id")
SELECT DISTINCT p."supplier_id", pt."tag_id"
FROM "product_tags" pt
JOIN "products" p ON p."id" = pt."product_id"
ON CONFLICT DO NOTHING;

ALTER TABLE "product_tags"
  ADD CONSTRAINT "product_tags_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "product_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "catalog_tags"
  ADD CONSTRAINT "catalog_tags_catalog_id_fkey" FOREIGN KEY ("catalog_id") REFERENCES "catalogs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "catalog_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "supplier_tags"
  ADD CONSTRAINT "supplier_tags_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP TABLE "catalog_categories";
DROP TABLE "product_categories";
DROP TABLE "supplier_categories";
DROP TABLE "categories";
