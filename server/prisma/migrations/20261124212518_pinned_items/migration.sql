CREATE TYPE "PinnedItemType" AS ENUM ('catalog', 'supplier', 'product');

CREATE TABLE "pinned_items" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "item_type" "PinnedItemType" NOT NULL,
  "item_id" UUID NOT NULL,
  "pinned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pinned_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shared_items" (
  "id" UUID NOT NULL,
  "sender_id" UUID NOT NULL,
  "recipient_id" UUID NOT NULL,
  "item_type" "PinnedItemType" NOT NULL,
  "item_id" UUID NOT NULL,
  "note" VARCHAR(500),
  "hidden_by_recipient" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "shared_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pinned_items_user_id_item_type_item_id_key"
  ON "pinned_items"("user_id", "item_type", "item_id");
CREATE INDEX "pinned_items_user_id_pinned_at_idx"
  ON "pinned_items"("user_id", "pinned_at" DESC);

CREATE UNIQUE INDEX "shared_items_sender_id_recipient_id_item_type_item_id_key"
  ON "shared_items"("sender_id", "recipient_id", "item_type", "item_id");
CREATE INDEX "shared_items_recipient_id_hidden_by_recipient_updated_at_idx"
  ON "shared_items"("recipient_id", "hidden_by_recipient", "updated_at" DESC);
CREATE INDEX "shared_items_sender_id_updated_at_idx"
  ON "shared_items"("sender_id", "updated_at" DESC);
CREATE INDEX "shared_items_item_type_item_id_idx"
  ON "shared_items"("item_type", "item_id");

ALTER TABLE "pinned_items"
  ADD CONSTRAINT "pinned_items_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "shared_items"
  ADD CONSTRAINT "shared_items_sender_id_fkey"
  FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shared_items"
  ADD CONSTRAINT "shared_items_recipient_id_fkey"
  FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
