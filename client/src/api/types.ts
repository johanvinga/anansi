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

/** A translatable value: one string per locale (FR-I18N-01). */
export interface Translated {
  en: string;
  fr: string;
}

export interface TranslatedText {
  en: string | null;
  fr: string | null;
}

export interface CategoryRef {
  id: string;
  name: Translated;
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
  /** Direct categories assigned to the supplier. */
  assignedCategories: CategoryRef[];
  /** Categories inherited from associated products, excluding duplicates of assigned ones. */
  inheritedCategories: CategoryRef[];
  /** Union of assigned and inherited categories. */
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
  supplierId: string | null;
  categories: CategoryRef[];
  name: string;
  version: string | null;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedById: string | null;
  analysisStatus: CatalogAnalysisStatus;
  createdAt: string;
  updatedAt: string;
}

export type CatalogAnalysisStatus = "not_processed" | "queued" | "processing" | "processed" | "failed";

export interface CatalogExtractionAttribute {
  name: string;
  value: string;
  confidence: number | null;
  sourcePage: number;
}

export interface CatalogProductCandidate {
  sku: string | null;
  name: string;
  description: string | null;
  categories: string[];
  attributes: CatalogExtractionAttribute[];
  source: { pageNumbers: number[]; excerpt: string };
  confidence: { overall: number | null; name: number | null; sku: number | null; attributes: number | null };
  validationStatus: "pending";
}

export interface CatalogExtractionResults {
  products: CatalogProductCandidate[];
  suggestedAttributeFields: { name: string; type: "text" }[];
  pages: { pageNumber: number; textSource: "pdf" | "ocr"; confidence: number | null }[];
}

export interface CatalogExtractionJob {
  jobId: string;
  status: CatalogAnalysisStatus;
  stage: string;
  progress: number;
  currentPage: number;
  totalPages: number;
  productsIdentified: number;
  error: string | null;
  results: CatalogExtractionResults | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogExtraction {
  analysisStatus: CatalogAnalysisStatus;
  job: CatalogExtractionJob | null;
}

/** A catalog joined with its supplier summary, as returned by the global catalogs list. */
export interface CatalogWithSupplier extends Catalog {
  supplierName: string | null;
  supplierCategoryNames: string[];
}

export type AttributeDataType = "text" | "number" | "decimal" | "boolean" | "date" | "select";

export interface AttributeOption {
  id: string;
  label: Translated;
  sortOrder: number;
}

export interface AttributeField {
  id: string;
  name: Translated;
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
  name: Translated;
  fieldCount: number;
  productCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AttributeSetDetail {
  id: string;
  name: Translated;
  createdAt: string;
  updatedAt: string;
  fields: AttributeField[];
}

export type AttributeValue = string | number | boolean | null;

export interface ProductSummary {
  id: string;
  supplierId: string;
  supplierName: string;
  name: Translated;
  supplierSku: string;
  minQuantity: number;
  cost: string;
  currency: string;
  categories: CategoryRef[];
  attributeSet: { id: string; name: Translated } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductAttributeValue {
  fieldId: string;
  code: string;
  name: Translated;
  dataType: AttributeDataType;
  unit: string | null;
  isArchived: boolean;
  value: AttributeValue;
  optionLabel: Translated | null;
}

export interface ProductDetail extends ProductSummary {
  description: TranslatedText;
  attributeValues: ProductAttributeValue[];
}

export interface AppSettings {
  defaultCurrency: string;
  maxUploadMb: number;
  catalogExtractionEnabled: boolean;
  currencies: string[];
}

export interface AuditLogDetail extends AuditLogSummary {
  changes: Record<string, { before: unknown; after: unknown }> | null;
}
