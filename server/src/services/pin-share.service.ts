import type { Database } from "../db.js";
import { PinnedItemType } from "../generated/prisma/client.js";
import { errors } from "../errors.js";
import { AuditAction, recordAudit, type AuditRequestContext } from "./audit.service.js";

export type PinShareItemType = "catalog" | "supplier" | "product";

export interface PinShareItemInput {
  itemType: PinShareItemType;
  itemId: string;
}

interface DashboardItem {
  itemType: PinShareItemType;
  itemId: string;
  name: { en: string; fr: string };
  shareId: string | null;
  pinnedAt: string | null;
  sharedAt: string | null;
  sender: { id: string; displayName: string | null; email: string } | null;
  note: string | null;
  hidden: boolean;
  recipients: Array<{ id: string; shareId: string; displayName: string | null; email: string; hidden: boolean }>;
}

async function assertItemExists(db: Database, itemType: PinShareItemType, itemId: string): Promise<void> {
  const row =
    itemType === "catalog"
      ? await db.catalog.findUnique({ where: { id: itemId }, select: { id: true } })
      : itemType === "supplier"
        ? await db.supplier.findUnique({ where: { id: itemId }, select: { id: true } })
        : await db.product.findUnique({ where: { id: itemId }, select: { id: true } });
  if (!row) throw errors.notFound(`${itemType[0]?.toUpperCase()}${itemType.slice(1)}`);
}

async function itemNames(db: Database, itemType: PinShareItemType, itemIds: string[]) {
  if (itemIds.length === 0) return new Map<string, { en: string; fr: string }>();
  if (itemType === "catalog") {
    const rows = await db.catalog.findMany({ where: { id: { in: itemIds } }, select: { id: true, name: true } });
    return new Map(rows.map((row) => [row.id, { en: row.name, fr: row.name }]));
  }
  if (itemType === "supplier") {
    const rows = await db.supplier.findMany({ where: { id: { in: itemIds } }, select: { id: true, name: true } });
    return new Map(rows.map((row) => [row.id, { en: row.name, fr: row.name }]));
  }
  const rows = await db.product.findMany({ where: { id: { in: itemIds } }, select: { id: true, nameEn: true, nameFr: true } });
  return new Map(rows.map((row) => [row.id, { en: row.nameEn, fr: row.nameFr }]));
}

async function dashboardNames(db: Database, items: Array<{ itemType: PinShareItemType; itemId: string }>) {
  const names = new Map<string, { en: string; fr: string }>();
  for (const itemType of ["catalog", "supplier", "product"] as PinShareItemType[]) {
    const ids = items.filter((item) => item.itemType === itemType).map((item) => item.itemId);
    const found = await itemNames(db, itemType, [...new Set(ids)]);
    for (const [id, name] of found) names.set(`${itemType}:${id}`, name);
  }
  return names;
}

export async function getPinStatus(db: Database, request: AuditRequestContext, input: PinShareItemInput): Promise<boolean> {
  await assertItemExists(db, input.itemType, input.itemId);
  const row = await db.pinnedItem.findUnique({
    where: {
      userId_itemType_itemId: {
        userId: request.actor.userId!,
        itemType: PinnedItemType[input.itemType],
        itemId: input.itemId,
      },
    },
    select: { id: true },
  });
  return row !== null;
}

export async function pinItem(db: Database, request: AuditRequestContext, input: PinShareItemInput): Promise<void> {
  await assertItemExists(db, input.itemType, input.itemId);
  await db.pinnedItem.upsert({
    where: { userId_itemType_itemId: { userId: request.actor.userId!, itemType: PinnedItemType[input.itemType], itemId: input.itemId } },
    create: { userId: request.actor.userId!, itemType: PinnedItemType[input.itemType], itemId: input.itemId },
    update: {},
  });
}

export async function unpinItem(db: Database, request: AuditRequestContext, input: PinShareItemInput): Promise<void> {
  await db.pinnedItem.deleteMany({
    where: { userId: request.actor.userId!, itemType: PinnedItemType[input.itemType], itemId: input.itemId },
  });
}

export async function listActiveShareUsers(db: Database, actorUserId: string, query: string) {
  const users = await db.user.findMany({
    where: {
      isActive: true,
      id: { not: actorUserId },
      OR: query
        ? [
            { email: { contains: query, mode: "insensitive" } },
            { displayName: { contains: query, mode: "insensitive" } },
          ]
        : undefined,
    },
    orderBy: [{ displayName: "asc" }, { email: "asc" }],
    take: 100,
    select: { id: true, email: true, displayName: true },
  });
  return users;
}

export async function getPinDashboard(db: Database, request: AuditRequestContext, filters: {
  q?: string;
  pinType?: PinShareItemType;
  shareType?: PinShareItemType;
  senderId?: string;
  hidden?: boolean;
}) {
  const userId = request.actor.userId!;
  const pinWhere = {
    userId,
    ...(filters.pinType ? { itemType: PinnedItemType[filters.pinType] } : {}),
  };
  const receivedWhere = {
    recipientId: userId,
    ...(filters.shareType ? { itemType: PinnedItemType[filters.shareType] } : {}),
    ...(filters.senderId ? { senderId: filters.senderId } : {}),
    ...(filters.hidden !== undefined ? { hiddenByRecipient: filters.hidden } : {}),
  };
  const sentWhere = {
    senderId: userId,
    ...(filters.shareType ? { itemType: PinnedItemType[filters.shareType] } : {}),
  };

  const [pinRows, receivedRows, sentRows] = await Promise.all([
    db.pinnedItem.findMany({ where: pinWhere, orderBy: [{ pinnedAt: "desc" }, { id: "desc" }] }),
    db.sharedItem.findMany({
      where: receivedWhere,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      include: { sender: { select: { id: true, displayName: true, email: true } } },
    }),
    db.sharedItem.findMany({
      where: sentWhere,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      include: { recipient: { select: { id: true, displayName: true, email: true } } },
    }),
  ]);

  const allItems = [
    ...pinRows.map((row) => ({ itemType: row.itemType as PinShareItemType, itemId: row.itemId })),
    ...receivedRows.map((row) => ({ itemType: row.itemType as PinShareItemType, itemId: row.itemId })),
    ...sentRows.map((row) => ({ itemType: row.itemType as PinShareItemType, itemId: row.itemId })),
  ];
  const names = await dashboardNames(db, allItems);

  const normalizeQuery = filters.q?.trim().toLowerCase();
  const matchesSearch = (item: DashboardItem) =>
    !normalizeQuery ||
    item.itemType.includes(normalizeQuery) ||
    item.name.en.toLowerCase().includes(normalizeQuery) ||
    item.name.fr.toLowerCase().includes(normalizeQuery) ||
    item.note?.toLowerCase().includes(normalizeQuery) ||
    item.sender?.displayName?.toLowerCase().includes(normalizeQuery) ||
    item.sender?.email.toLowerCase().includes(normalizeQuery);

  const pins: DashboardItem[] = pinRows.map((row) => {
    const itemType = row.itemType as PinShareItemType;
    return {
      itemType,
      itemId: row.itemId,
      name: names.get(`${itemType}:${row.itemId}`) ?? { en: itemType, fr: itemType },
      shareId: null,
      pinnedAt: row.pinnedAt.toISOString(),
      sharedAt: null,
      sender: null,
      note: null,
      hidden: false,
      recipients: [],
    };
  }).filter(matchesSearch);

  const received: DashboardItem[] = receivedRows.map((row) => {
    const itemType = row.itemType as PinShareItemType;
    return {
      itemType,
      itemId: row.itemId,
      name: names.get(`${itemType}:${row.itemId}`) ?? { en: itemType, fr: itemType },
      shareId: row.id,
      pinnedAt: null,
      sharedAt: row.updatedAt.toISOString(),
      sender: row.sender,
      note: row.note,
      hidden: row.hiddenByRecipient,
      recipients: [],
    };
  }).filter(matchesSearch);

  const sentMap = new Map<string, DashboardItem>();
  for (const row of sentRows) {
    const itemType = row.itemType as PinShareItemType;
    const key = `${itemType}:${row.itemId}`;
    const existing = sentMap.get(key);
    const recipient = {
      id: row.recipient.id,
      shareId: row.id,
      displayName: row.recipient.displayName,
      email: row.recipient.email,
      hidden: row.hiddenByRecipient,
    };
    if (existing) {
      existing.recipients.push(recipient);
      existing.sharedAt =
        row.updatedAt.toISOString() > existing.sharedAt! ? row.updatedAt.toISOString() : existing.sharedAt;
    } else {
      sentMap.set(key, {
        itemType,
        itemId: row.itemId,
        name: names.get(key) ?? { en: itemType, fr: itemType },
        shareId: null,
        pinnedAt: null,
        sharedAt: row.updatedAt.toISOString(),
        sender: null,
        note: row.note,
        hidden: false,
        recipients: [recipient],
      });
    }
  }
  const sent = [...sentMap.values()].filter(matchesSearch)
    .sort((a, b) => (b.sharedAt ?? "").localeCompare(a.sharedAt ?? ""));

  return {
    pins: { items: pins, total: pins.length },
    received: { items: received, total: received.length },
    sent: { items: sent, total: sent.length },
  };
}

export async function shareItem(
  db: Database,
  request: AuditRequestContext,
  input: PinShareItemInput & { recipientIds: string[]; note: string | null },
) {
  await assertItemExists(db, input.itemType, input.itemId);
  const actorId = request.actor.userId!;
  const recipientSet = new Set(input.recipientIds);
  if (recipientSet.has(actorId)) {
    throw errors.validation([{ field: "recipientIds", message: "An item cannot be shared with yourself." }]);
  }
  const uniqueIds = [...recipientSet];
  const recipients = await db.user.findMany({
    where: { id: { in: uniqueIds }, isActive: true },
    select: { id: true },
  });
  if (recipients.length !== uniqueIds.length) throw errors.validation([{ field: "recipientIds", message: "One or more recipients are inactive or unknown." }]);

  await db.$transaction(async (tx) => {
    await tx.sharedItem.deleteMany({
      where: {
        senderId: actorId,
        itemType: PinnedItemType[input.itemType],
        itemId: input.itemId,
        recipientId: { notIn: uniqueIds },
      },
    });
    for (const recipientId of uniqueIds) {
      await tx.sharedItem.upsert({
        where: {
          senderId_recipientId_itemType_itemId: {
            senderId: actorId,
            recipientId,
            itemType: PinnedItemType[input.itemType],
            itemId: input.itemId,
          },
        },
        create: {
          senderId: actorId,
          recipientId,
          itemType: PinnedItemType[input.itemType],
          itemId: input.itemId,
          note: input.note,
          hiddenByRecipient: false,
        },
        update: { note: input.note, hiddenByRecipient: false },
      });
      await recordAudit(tx, request, {
        action: AuditAction.SHARED_ITEM_SHARE,
        outcome: "success",
        entityType: `${input.itemType[0]?.toUpperCase()}${input.itemType.slice(1)}`,
        entityId: input.itemId,
        changes: { recipients: { before: null, after: recipientId }, note: { before: null, after: input.note } },
      });
    }
  });
}

export async function hideSharedItem(db: Database, request: AuditRequestContext, shareId: string, hidden: boolean) {
  const recipientId = request.actor.userId;
  if (!recipientId) throw errors.forbidden("Authentication required.");
  const row = await db.sharedItem.findFirst({ where: { id: shareId, recipientId } });
  if (!row) throw errors.notFound("Shared item");
  await db.sharedItem.update({ where: { id: shareId }, data: { hiddenByRecipient: hidden } });
}

export async function revokeSharedItem(db: Database, request: AuditRequestContext, shareId: string) {
  const senderId = request.actor.userId;
  if (!senderId) throw errors.forbidden("Authentication required.");
  const row = await db.sharedItem.findFirst({ where: { id: shareId, senderId } });
  if (!row) throw errors.notFound("Shared item");
  await db.$transaction(async (tx) => {
    await tx.sharedItem.delete({ where: { id: shareId } });
    await recordAudit(tx, request, {
      action: AuditAction.SHARED_ITEM_REVOKE,
      outcome: "success",
      entityType: `${row.itemType[0]?.toUpperCase()}${row.itemType.slice(1)}`,
      entityId: row.itemId,
      changes: { recipientId: { before: row.recipientId, after: null } },
    });
  });
}
