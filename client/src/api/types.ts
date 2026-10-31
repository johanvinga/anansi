export type UserRole = "admin" | "standard";

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string | null;
  role: UserRole;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AuditLogSummary {
  id: string;
  occurredAt: string;
  actorUserId: string | null;
  actorEmail: string;
  action: string;
  outcome: "success" | "failure";
  entityType: string | null;
  entityId: string | null;
  ipAddress: string | null;
  requestId: string;
}

export interface CategoryRef {
  id: string;
  name: string;
}

export interface Category extends CategoryRef {
  createdAt: string;
}

export interface Supplier {
  id: string;
  name: string;
  street: string | null;
  city: string | null;
  stateRegion: string | null;
  postalCode: string | null;
  country: string | null;
  categories: CategoryRef[];
  createdAt: string;
  updatedAt: string;
}

export interface SupplierAsset {
  id: string;
  supplierId: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  title: string | null;
  description: string | null;
  uploadedById: string | null;
  createdAt: string;
}

export interface AuditLogDetail extends AuditLogSummary {
  changes: Record<string, { before: unknown; after: unknown }> | null;
}
