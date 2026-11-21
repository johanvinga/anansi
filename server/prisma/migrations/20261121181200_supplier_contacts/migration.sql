-- CreateTable
CREATE TABLE "supplier_contacts" (
    "id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "first_name" VARCHAR(100),
    "last_name" VARCHAR(100),
    "email" VARCHAR(254),
    "phone_number" VARCHAR(50),
    "wechat_id" VARCHAR(100),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "supplier_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplier_contacts_supplier_order_idx"
ON "supplier_contacts"("supplier_id", "created_at" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "supplier_contacts"
ADD CONSTRAINT "supplier_contacts_supplier_id_fkey"
FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
