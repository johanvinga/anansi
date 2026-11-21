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

const NIL_UUID = "9f1c2a4e-1111-4222-8333-444455556666";

describe("supplier contacts (FR-SCT)", () => {
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
    const response = await request(app.server)
      .post("/api/v1/suppliers")
      .set(unsafeHeaders(adminCookie))
      .send({ name: "Contact Supplier" });
    expect(response.status).toBe(201);
    return response.body.supplier.id as string;
  }

  it("creates and lists normalized contacts newest first for any authenticated user", async () => {
    const supplierId = await createSupplier();
    const first = await request(app.server)
      .post(`/api/v1/suppliers/${supplierId}/contacts`)
      .set(unsafeHeaders(adminCookie))
      .send({ firstName: "  Ada  ", email: "  ada@example.com " });
    const second = await request(app.server)
      .post(`/api/v1/suppliers/${supplierId}/contacts`)
      .set(unsafeHeaders(adminCookie))
      .send({});

    expect(first.status).toBe(201);
    expect(first.body.contact).toMatchObject({
      firstName: "Ada",
      lastName: null,
      email: "ada@example.com",
    });
    expect(second.status).toBe(201);
    expect(second.body.contact).toMatchObject({
      firstName: null,
      lastName: null,
      email: null,
      phoneNumber: null,
      weChatId: null,
    });

    const listed = await request(app.server)
      .get(`/api/v1/suppliers/${supplierId}/contacts`)
      .set("Cookie", readerCookie);
    expect(listed.status).toBe(200);
    expect(listed.body.contacts.map((contact: { id: string }) => contact.id)).toEqual([
      second.body.contact.id,
      first.body.contact.id,
    ]);
    expect(await db.auditLog.count({ where: { action: "SUPPLIER_CONTACT_LIST" } })).toBe(1);
  });

  it("validates optional fields while allowing duplicates and free-form phone numbers", async () => {
    const supplierId = await createSupplier();
    const invalidEmail = await request(app.server)
      .post(`/api/v1/suppliers/${supplierId}/contacts`)
      .set(unsafeHeaders(adminCookie))
      .send({ email: "not-an-email" });
    expect(invalidEmail.status).toBe(400);
    expect(invalidEmail.body.error.details[0].field).toBe("email");

    const tooLong = await request(app.server)
      .post(`/api/v1/suppliers/${supplierId}/contacts`)
      .set(unsafeHeaders(adminCookie))
      .send({ firstName: "x".repeat(101) });
    expect(tooLong.status).toBe(400);

    const body = { phoneNumber: "+86 10 5555 1234 ext. 7", weChatId: "shared" };
    const one = await request(app.server)
      .post(`/api/v1/suppliers/${supplierId}/contacts`)
      .set(unsafeHeaders(adminCookie))
      .send(body);
    const two = await request(app.server)
      .post(`/api/v1/suppliers/${supplierId}/contacts`)
      .set(unsafeHeaders(adminCookie))
      .send(body);
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
  });

  it("updates all fields, clears omitted values, and audits before and after", async () => {
    const supplierId = await createSupplier();
    const created = await request(app.server)
      .post(`/api/v1/suppliers/${supplierId}/contacts`)
      .set(unsafeHeaders(adminCookie))
      .send({ firstName: "Grace", email: "grace@example.com", phoneNumber: "+1 555" });

    const updated = await request(app.server)
      .put(`/api/v1/suppliers/${supplierId}/contacts/${created.body.contact.id}`)
      .set(unsafeHeaders(adminCookie))
      .send({ lastName: "Hopper" });

    expect(updated.status).toBe(200);
    expect(updated.body.contact).toMatchObject({
      firstName: null,
      lastName: "Hopper",
      email: null,
      phoneNumber: null,
    });
    const audit = await db.auditLog.findFirstOrThrow({
      where: {
        action: "SUPPLIER_CONTACT_UPDATE",
        entityId: created.body.contact.id,
      },
    });
    expect(audit.changes).toMatchObject({
      firstName: { before: "Grace", after: null },
      lastName: { before: null, after: "Hopper" },
      email: { before: "grace@example.com", after: null },
    });
  });

  it("enforces admin authorization and supplier ownership on mutations", async () => {
    const supplierId = await createSupplier();
    const created = await request(app.server)
      .post(`/api/v1/suppliers/${supplierId}/contacts`)
      .set(unsafeHeaders(adminCookie))
      .send({});
    const otherSupplier = await request(app.server)
      .post("/api/v1/suppliers")
      .set(unsafeHeaders(adminCookie))
      .send({ name: "Other Supplier" });

    const denied = await request(app.server)
      .post(`/api/v1/suppliers/${supplierId}/contacts`)
      .set(unsafeHeaders(readerCookie))
      .send({});
    expect(denied.status).toBe(403);

    const mismatched = await request(app.server)
      .delete(
        `/api/v1/suppliers/${otherSupplier.body.supplier.id}/contacts/${created.body.contact.id}`,
      )
      .set(unsafeHeaders(adminCookie));
    expect(mismatched.status).toBe(404);
    expect(mismatched.body.error.code).toBe("NOT_FOUND");

    const deleted = await request(app.server)
      .delete(`/api/v1/suppliers/${supplierId}/contacts/${created.body.contact.id}`)
      .set(unsafeHeaders(adminCookie));
    expect(deleted.status).toBe(204);
    expect(
      await db.auditLog.count({
        where: { action: "SUPPLIER_CONTACT_DELETE", entityId: created.body.contact.id },
      }),
    ).toBe(1);
  });

  it("rejects anonymous access and cascades contacts when the supplier is deleted", async () => {
    const supplierId = await createSupplier();
    await request(app.server)
      .post(`/api/v1/suppliers/${supplierId}/contacts`)
      .set(unsafeHeaders(adminCookie))
      .send({});

    const anonymous = await request(app.server)
      .get(`/api/v1/suppliers/${supplierId}/contacts`)
      .set("Origin", "http://localhost:5173");
    expect(anonymous.status).toBe(401);

    const missing = await request(app.server)
      .get(`/api/v1/suppliers/${NIL_UUID}/contacts`)
      .set("Cookie", readerCookie);
    expect(missing.status).toBe(404);

    const deleted = await request(app.server)
      .delete(`/api/v1/suppliers/${supplierId}`)
      .set(unsafeHeaders(adminCookie));
    expect(deleted.status).toBe(204);
    expect(await db.supplierContact.count({ where: { supplierId } })).toBe(0);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { action: "SUPPLIER_DELETE", entityId: supplierId },
    });
    expect(audit.changes).toMatchObject({ contactCount: { before: 1, after: 0 } });
  });
});
