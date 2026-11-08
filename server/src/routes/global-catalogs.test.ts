import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db.js";
import {
  ADMIN,
  READER,
  TEST_ORIGIN,
  createTestApp,
  createTestDatabase,
  loginCookie,
  resetDatabase,
  seedUser,
  unsafeHeaders,
} from "../test/helpers.js";

const PDF = Buffer.from("%PDF-1.4 global catalog\n%%EOF\n");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CatalogItem {
  name: string;
  version: string | null;
  originalFileName: string;
  supplierName: string;
  supplierCategoryNames: string[];
  createdAt: string;
}

describe("global catalogs list", () => {
  let db: Database;
  let app: FastifyInstance;
  let uploadDir: string;
  let adminCookie: string;
  let readerCookie: string;

  beforeAll(async () => {
    db = createTestDatabase();
    uploadDir = await mkdtemp(path.join(tmpdir(), "global-catalogs-"));
    app = await createTestApp(db, { uploadDir, maxUploadMb: 1 });
  });

  afterAll(async () => {
    await app.close();
    await rm(uploadDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetDatabase(db);
    await seedUser(db, ADMIN, "admin");
    await seedUser(db, READER, "standard");
    adminCookie = await loginCookie(app, ADMIN);
    readerCookie = await loginCookie(app, READER);
  });

  async function makeCategory(name: string): Promise<{ id: string }> {
    const res = await request(app.server)
      .post("/api/v1/categories")
      .set(unsafeHeaders(adminCookie))
      .send({ name });
    const { category } = res.body as { category: { id: string } };
    if (res.status !== 201) throw new Error(`category create failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { id: category.id };
  }

  async function makeSupplier(name: string, categoryIds: string[] = []): Promise<{ id: string }> {
    const res = await request(app.server)
      .post("/api/v1/suppliers")
      .set(unsafeHeaders(adminCookie))
      .send({ name, categories: categoryIds.map((id) => ({ id })) });
    const { supplier } = res.body as { supplier: { id: string } };
    if (res.status !== 201) throw new Error(`supplier create failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { id: supplier.id };
  }

  async function uploadCatalog(
    supplierId: string,
    name: string,
    options: { version?: string; filename?: string } = {},
  ): Promise<CatalogItem> {
    const req = request(app.server)
      .post(`/api/v1/suppliers/${supplierId}/catalogs`)
      .set(unsafeHeaders(adminCookie))
      .field("name", name);
    if (options.version !== undefined) req.field("version", options.version);
    const res = await req.attach("file", PDF, { filename: options.filename ?? "catalog.pdf" });
    const { catalog } = res.body as { catalog: CatalogItem };
    if (res.status !== 201) throw new Error(`catalog upload failed: ${res.status} ${JSON.stringify(res.body)}`);
    return catalog;
  }

  async function listCatalogs(query = ""): Promise<{ total: number; items: CatalogItem[] }> {
    const res = await request(app.server)
      .get(`/api/v1/catalogs${query}`)
      .set("Cookie", readerCookie);
    if (res.status !== 200) throw new Error(`list failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { total: number; items: CatalogItem[] };
  }

  it("lists catalogs across all suppliers with supplier and category tags", async () => {
    const tools = await makeCategory("Tools");
    const paint = await makeCategory("Paint");
    const acme = await makeSupplier("Acme", [tools.id]);
    const bolt = await makeSupplier("Bolt", [paint.id, tools.id]);
    await uploadCatalog(acme.id, "Acme catalog", { filename: "acme.pdf" });
    await uploadCatalog(bolt.id, "Bolt catalog", { filename: "bolt.pdf" });

    const { total, items } = await listCatalogs("?page=1&pageSize=25");
    expect(total).toBe(2);
    expect(items).toHaveLength(2);
    const acmeItem = items.find((i) => i.supplierName === "Acme");
    const boltItem = items.find((i) => i.supplierName === "Bolt");
    expect(acmeItem?.supplierCategoryNames).toEqual(["Tools"]);
    expect(boltItem?.supplierCategoryNames).toEqual(["Paint", "Tools"]);
    expect(acmeItem?.originalFileName).toBe("acme.pdf");
    // Version omitted on upload -> null (optional since FR-CLG-01 relaxation).
    expect(acmeItem?.version).toBeNull();
  });

  it("sorts newest first (last added)", async () => {
    const acme = await makeSupplier("Acme");
    await uploadCatalog(acme.id, "First catalog");
    await sleep(20);
    const lastAdded = await uploadCatalog(acme.id, "Second catalog");

    const { items } = await listCatalogs();
    expect(items[0]?.name).toBe("Second catalog");
    expect(items.map((i) => i.name)).toEqual(["Second catalog", "First catalog"]);
    expect(new Date(items[0]?.createdAt ?? 0).getTime()).toBe(new Date(lastAdded.createdAt).getTime());
  });

  it("searches by catalog name, version, and supplier name via q", async () => {
    const acme = await makeSupplier("Acme");
    const bolt = await makeSupplier("Bolt");
    await uploadCatalog(acme.id, "zeta paper", { version: "v1" });
    await uploadCatalog(bolt.id, "gamma paper", { version: "v2" });
    await uploadCatalog(acme.id, "another", { version: "v3" });

    const bySupplierName = await listCatalogs("?q=bolt");
    expect(bySupplierName.items.map((i) => i.name)).toEqual(["gamma paper"]);

    const byName = await listCatalogs("?q=gamma");
    expect(byName.items.map((i) => i.name)).toEqual(["gamma paper"]);

    const byVersion = await listCatalogs("?q=v3");
    expect(byVersion.items.map((i) => i.name)).toEqual(["another"]);
  });

  it("filters by one or more categories, combining with q", async () => {
    const tools = await makeCategory("Tools");
    const paint = await makeCategory("Paint");
    const acme = await makeSupplier("Acme", [tools.id]);
    const bolt = await makeSupplier("Bolt", [paint.id]);
    await uploadCatalog(acme.id, "Acme prices");
    await uploadCatalog(bolt.id, "Bolt prices");

    const byTools = await listCatalogs(`?category=${tools.id}`);
    expect(byTools.items.map((i) => i.supplierName)).toEqual(["Acme"]);

    const byBoth = await listCatalogs(`?category=${tools.id}&category=${paint.id}`);
    expect(new Set(byBoth.items.map((i) => i.supplierName))).toEqual(new Set(["Acme", "Bolt"]));

    const combined = await listCatalogs(`?category=${tools.id}&category=${paint.id}&q=bolt`);
    expect(combined.items.map((i) => i.supplierName)).toEqual(["Bolt"]);
  });

  it("paginates with totals", async () => {
    const acme = await makeSupplier("Acme");
    await uploadCatalog(acme.id, "Page catalog 1");
    await sleep(20);
    await uploadCatalog(acme.id, "Page catalog 2");
    await sleep(20);
    await uploadCatalog(acme.id, "Page catalog 3");

    const first = await listCatalogs("?page=1&pageSize=2");
    expect(first.total).toBe(3);
    expect(first.items.map((i) => i.name)).toEqual(["Page catalog 3", "Page catalog 2"]);

    const second = await listCatalogs("?page=2&pageSize=2");
    expect(second.items.map((i) => i.name)).toEqual(["Page catalog 1"]);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await request(app.server)
      .get("/api/v1/catalogs")
      .set("Origin", TEST_ORIGIN);
    expect(res.status).toBe(401);
  });

  it("audits the listing", async () => {
    await listCatalogs();
    expect(await db.auditLog.count({ where: { action: "CATALOG_LIST" } })).toBe(1);
  });
});