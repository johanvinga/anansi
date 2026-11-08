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

export interface Catalog {
  id: string;
  supplierId: string;
  name: string;
  version: string | null;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedById: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A catalog joined with its supplier summary, as returned by the global catalogs list. */
export interface CatalogWithSupplier extends Catalog {
  supplierName: string;
  supplierCategoryNames: string[];
}

export type AttributeDataType = "text" | "number" | "decimal" | "boolean" | "date" | "select";

export interface AttributeOption {
  id: string;
  label: string;
  sortOrder: number;
}

export interface AttributeField {
  id: string;
  name: string;
  code: string;
  dataType: AttributeDataType;
  unit: string | null;
  isRequired: boolean;
  isArchived: boolean;
  sortOrder: number;
  options: AttributeOption[];
  hasValues: boolean;
}

export interface AttributeSetSummary {
  id: string;
  name: string;
  fieldCount: number;
  productCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AttributeSetDetail {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  fields: AttributeField[];
}

export type AttributeValue = string | number | boolean | null;

export interface ProductSummary {
  id: string;
  supplierId: string;
  supplierName: string;
  name: string;
  supplierSku: string;
  minQuantity: number;
  cost: string;
  currency: string;
  attributeSet: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductAttributeValue {
  fieldId: string;
  code: string;
  name: string;
  dataType: AttributeDataType;
  unit: string | null;
  isArchived: boolean;
  value: AttributeValue;
  optionLabel: string | null;
}

export interface ProductDetail extends ProductSummary {
  attributeValues: ProductAttributeValue[];
}

export interface AppSettings {
  defaultCurrency: string;
  maxUploadMb: number;
  currencies: string[];
}

export interface AuditLogDetail extends AuditLogSummary {
  changes: Record<string, { before: unknown; after: unknown }> | null;
}
