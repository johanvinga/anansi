import type { FastifyInstance } from "fastify";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db.js";
import {
  ADMIN,
  READER,
  createTestApp,
  createTestDatabase,
  loginCookie,
  resetDatabase,
  seedUser,
  unsafeHeaders,
} from "../test/helpers.js";

describe("pinned and shared items", () => {
  let db: Database;
  let app: FastifyInstance;
  let adminCookie: string;
  let readerCookie: string;

  beforeAll(async () => {
    db = createTestDatabase();
    app = await createTestApp(db);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    await seedUser(db, ADMIN, "admin");
    await seedUser(db, READER, "standard");
    adminCookie = await loginCookie(app, ADMIN);
    readerCookie = await loginCookie(app, READER);
  });

  async function createSupplier() {
    const row = await db.supplier.create({
      data: { name: "Pinned Supplier", nameKey: "pinned supplier" },
    });
    return row;
  }

  it("allows a standard user to pin and unpin a supplier", async () => {
    const supplier = await createSupplier();
    const pin = await request(app.server)
      .post("/api/v1/pins")
      .set(unsafeHeaders(readerCookie))
      .send({ itemType: "supplier", itemId: supplier.id });
    expect(pin.status).toBe(200);
    expect(await db.pinnedItem.count({ where: { userId: (await db.user.findUniqueOrThrow({ where: { email: READER.email } })).id } })).toBe(1);

    const status = await request(app.server)
      .get(`/api/v1/pins/supplier/${supplier.id}/status`)
      .set("Cookie", readerCookie);
    expect(status.status).toBe(200);
    expect(status.body.pinned).toBe(true);

    const unpin = await request(app.server)
      .delete("/api/v1/pins")
      .set(unsafeHeaders(readerCookie))
      .send({ itemType: "supplier", itemId: supplier.id });
    expect(unpin.status).toBe(200);
  });

  it("lists pinned items first, most recently pinned first, across pages", async () => {
    const reader = await db.user.findUniqueOrThrow({ where: { email: READER.email } });
    const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
    const suppliers = [];
    for (const name of names) {
      suppliers.push(await db.supplier.create({ data: { name, nameKey: name.toLowerCase() } }));
    }
    const [alpha, , charlie, , echo] = suppliers;
    const pin = (itemId: string, pinnedAt: Date) =>
      db.pinnedItem.create({ data: { userId: reader.id, itemType: "supplier", itemId, pinnedAt } });
    await pin(echo!.id, new Date("2026-01-01T00:00:00Z"));
    await pin(alpha!.id, new Date("2026-01-02T00:00:00Z"));
    await pin(charlie!.id, new Date("2026-01-03T00:00:00Z"));

    const fetchPage = async (page: number, query = "") => {
      const response = await request(app.server)
        .get(`/api/v1/suppliers?page=${page}&pageSize=2${query}`)
        .set("Cookie", readerCookie);
      expect(response.status).toBe(200);
      return response.body as { items: { name: string; pinned: boolean }[]; total: number };
    };

    const first = await fetchPage(1);
    const second = await fetchPage(2);
    const third = await fetchPage(3);
    expect(first.total).toBe(5);
    expect([...first.items, ...second.items, ...third.items].map((item) => item.name)).toEqual([
      "Charlie", "Alpha", "Echo", "Bravo", "Delta",
    ]);
    expect([...first.items, ...second.items].map((item) => item.pinned)).toEqual([true, true, true, false]);

    const filtered = await fetchPage(1, "&q=a");
    expect(filtered.items.map((item) => item.name)).toEqual(["Charlie", "Alpha"]);

    const adminView = await request(app.server).get("/api/v1/suppliers?pageSize=2").set("Cookie", adminCookie);
    expect(adminView.body.items.map((item: { name: string }) => item.name)).toEqual(["Alpha", "Bravo"]);
  });

  it("shares an item, supports hidden restore, and audits share and revoke", async () => {
    const supplier = await createSupplier();
    const share = await request(app.server)
      .post("/api/v1/shares")
      .set(unsafeHeaders(adminCookie))
      .send({
        itemType: "supplier",
        itemId: supplier.id,
        recipientIds: [(await db.user.findUniqueOrThrow({ where: { email: READER.email } })).id],
        note: "Review this supplier",
      });
    expect(share.status).toBe(200);

    const row = await db.sharedItem.findFirstOrThrow({ where: { itemId: supplier.id } });
    const hide = await request(app.server)
      .patch(`/api/v1/shares/${row.id}`)
      .set(unsafeHeaders(readerCookie))
      .send({ hidden: true });
    expect(hide.status).toBe(200);
    expect((await db.sharedItem.findUniqueOrThrow({ where: { id: row.id } })).hiddenByRecipient).toBe(true);

    const restore = await request(app.server)
      .patch(`/api/v1/shares/${row.id}`)
      .set(unsafeHeaders(readerCookie))
      .send({ hidden: false });
    expect(restore.status).toBe(200);

    const revoke = await request(app.server)
      .delete(`/api/v1/shares/${row.id}`)
      .set(unsafeHeaders(adminCookie));
    expect(revoke.status).toBe(204);
    expect(await db.auditLog.count({ where: { action: "SHARED_ITEM_SHARE", entityId: supplier.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: "SHARED_ITEM_REVOKE", entityId: supplier.id } })).toBe(1);
  });

  it("rejects self-sharing and inactive recipients", async () => {
    const supplier = await createSupplier();
    const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN.email } });
    const reader = await db.user.findUniqueOrThrow({ where: { email: READER.email } });
    await db.user.update({ where: { id: reader.id }, data: { isActive: false } });

    const self = await request(app.server)
      .post("/api/v1/shares")
      .set(unsafeHeaders(adminCookie))
      .send({ itemType: "supplier", itemId: supplier.id, recipientIds: [admin.id], note: null });
    expect(self.status).toBe(400);

    const inactive = await request(app.server)
      .post("/api/v1/shares")
      .set(unsafeHeaders(adminCookie))
      .send({ itemType: "supplier", itemId: supplier.id, recipientIds: [reader.id], note: null });
    expect(inactive.status).toBe(400);
  });

  it("requires authentication", async () => {
    const supplier = await createSupplier();
    const res = await request(app.server)
      .post("/api/v1/pins")
      .set(unsafeHeaders())
      .send({ itemType: "supplier", itemId: supplier.id });
    expect(res.status).toBe(401);
  });
});
