# Catalog product images: proposed specification and implementation plan

Status: **proposal for review; not implemented**. [SPEC.md](../SPEC.md) remains
the source of truth for implemented requirements. The API shapes and operational
limits below are proposed implementation choices, not additional user decisions.

## Goal

Extend the existing, explicitly started Gemini catalog analysis to suggest
product images from the PDF. An admin reviews and selects an image before
importing each product. Products can also have an image uploaded, replaced, or
removed through the existing authenticated application and product API.

## Agreed behavior

- Each product has at most one optional image. Existing products start without
  an image.
- Find separately embedded images and, where needed, crop product pictures from
  rendered PDF pages. Suggestions can be wrong or incomplete; do not imply
  Gemini returns the image bytes.
- Show possible images when the association is uncertain. An admin can select
  one or leave the product without an image. Analysis alone never creates or
  changes a product.
- An image-extraction failure does not discard successfully extracted product
  candidates. Show a warning and permit import without an image or later manual
  upload. A failure of Gemini product analysis retains its existing behavior.
- An admin can upload, replace, and remove images in the UI and the
  session-authenticated product API. Authenticated standard users can view
  images but cannot modify them.
- Accept JPEG, PNG, and WebP uploads of at most 5 MiB. Extracted images attached
  to products must also meet this limit.
- Images are private and accessed through authenticated API endpoints.
  Reanalysis does not change images already attached to products.

The public machine-to-machine catalog upload endpoint remains PDF-only and does
not start analysis or accept product images. Existing catalog upload and import
behavior remains unchanged unless an admin explicitly selects an image.

## Image discovery and review

1. Extend the Gemini analysis response to identify possible product-image
   locations on physical, 1-based PDF pages. Validate every page reference and
   bounding box before use. Treat all output as untrusted suggestions, not as
   image data or proof that a picture belongs to a product.
2. Use the existing PDF and canvas capabilities to extract suitable embedded
   images and render/crop page regions. Account for page rotation, crop box,
   coordinate system, and output dimensions. A product image may be part of a
   larger embedded image or composed with other PDF graphics; extraction must
   not assume every product picture is a separate PDF object.
3. Offer the admin the suggested images and other discovered candidates from
   relevant pages, with their source page. Permit explicit selection or no image.
   The same source image may be selected for multiple product variants.
   Exclude unrelated graphics where possible, but do not silently make an
   uncertain match on the admin's behalf.
4. Save candidate files privately, scoped to the analysis job. Return opaque
   candidate identifiers and metadata, not storage keys, raw file paths, or
   embedded image bytes in analysis JSON. Provide authenticated preview access.
   Backward-compatible reads of existing analysis results must continue to work
   when no image suggestions are present.
5. Show image-specific warnings separately from product-analysis errors.
   Missing, invalid, oversized, or unextractable image candidates must not block
   review of the remaining products. Resource-limit truncation must be visible.
   Full PDF rendering cannot guarantee that all pictures are identifiable.

The existing whole-PDF Gemini request, request limiter, temporary Gemini file
deletion, review process, and explicit start/retry behavior remain in effect.
No additional provider, dependency, or provider request is approved by this
proposal; discuss any required dependency before adding it.

## Import and lifecycle

- Extend the existing preview and import flow with a per-product choice of
  candidate image ID or no image. A selected ID must belong to the current
  catalog and latest completed job and be available to the selected product's
  review choices. Reject stale, missing, or foreign IDs rather than silently
  importing a different image.
- The import continues to require a confirmed supplier, preserves the existing
  SKU-skip and category/attribute review rules, and creates only explicitly
  selected products. Skipped existing SKUs are never updated or given images.
- Copy each selected candidate into product-owned private storage; do not make
  the product depend on a candidate file or on the continued existence of its
  catalog. The product image therefore survives reanalysis and catalog deletion.
- Keep product creation, image metadata, and audit changes transactional. File
  storage is outside the database transaction: stage new files before committing,
  remove them on failed or skipped imports, and ensure failures are reported.
  Handle concurrent imports, reanalysis, catalog deletion, and product deletion
  without dangling references or deletion of files in use.
- Clean up candidate files when their jobs or catalogs are removed or no longer
  need retention, and product files on replacement, removal, or product deletion.
  File-removal failures must be logged and recoverable through a durable cleanup
  mechanism; do not report cleanup as complete while an orphan remains.
  Imported product images must not be deleted with candidate files.

## Product image API (proposed)

Use the existing `/api/v1` prefix, session guards, CSRF/Origin checks, standard
error envelope, and audit conventions. No Basic-authenticated product API is
included.

| Method and path | Access | Behavior |
|---|---|---|
| `GET /products/{id}/image` | Authenticated user | Stream the current image with the validated MIME type; return 404 if the product or image does not exist. Audit the view. |
| `PUT /products/{id}/image` | Admin | Accept exactly one multipart `file`; upload or replace the image. Return current non-sensitive image metadata. |
| `DELETE /products/{id}/image` | Admin | Remove the current image; return 204. Return 404 if the product or image does not exist. |
| `GET /catalogs/{catalogId}/extraction/{jobId}/images/{imageId}` | Admin | Stream a private candidate image for review, scoped to the current completed job. |

Image mutation responses and the existing product DTO should expose only
non-sensitive metadata such as presence, MIME type and size. Do not expose
storage keys or public URLs. Use authenticated client requests for image
display, including previews; avoid unauthenticated static hosting.

For multipart uploads reject missing or extra parts, unsupported MIME types,
invalid signatures, malformed images, and files over 5 MiB using the existing
error conventions. Decode and validate the image rather than trusting its name,
MIME header, or signature alone. Bound decoded pixel count and processing
resources to prevent decompression bombs; choose and document a concrete limit
before implementation. Preserve the previous image if validation, storage, or
the metadata transaction fails. Record image changes with the actual admin
actor and before/after metadata in the same transaction, without recording file
contents.

## UI

- In catalog import review, show each candidate's source-page image choices and
  any image extraction warning. Make the selected image or explicit no-image
  choice clear before confirmation. Do not create products during preview.
- In the product UI, show the image or an empty state and let admins upload,
  replace, and remove it. Standard users can view it but see no mutation
  controls. Provide meaningful labels, loading/error states, and translations.
- Product creation and image upload may be separate requests. If product creation
  succeeds but image upload fails, clearly report that the product exists
  without the image and allow a retry; do not report the whole operation as
  successfully completed.

## Implementation plan

1. Add product image metadata and job-scoped candidate metadata with a new
   versioned Prisma migration. Define ownership, indexes, cleanup records, and
   opaque IDs; never modify an applied migration. Extend the existing storage
   abstraction and its key validation for private image keys.
2. Implement bounded image validation, private storage, product-image
   create/replace/remove/read services, transaction-aware audit records, and
   authenticated routes. Wire storage dependencies through existing app setup.
3. Extend Gemini's structured response and validate image locations. Implement
   bounded embedded-image discovery and page-region rendering/cropping using
   available libraries. Store image warnings independently from fatal analysis
   errors and clean up partially produced candidates.
4. Extend candidate DTOs, authenticated previews, import validation and
   transaction flow, and lifecycle cleanup. Preserve compatibility with older
   saved analyses and existing clients.
5. Add localized image review and product image controls using existing
   components, fetch patterns, and authorization behavior.
6. Update [SPEC.md](../SPEC.md), API documentation, configuration and deployment
   guidance when the feature is implemented. Document concrete resource limits,
   retention, recovery, storage capacity, and operational cleanup.

## Acceptance and verification

- Analyze representative PDFs containing separately embedded pictures, multiple
  products on one page, a page-sized raster image, rotated/cropped pages, and
  shared images across variants. Review shows usable choices with correct page
  references; a product receives an image only when an admin selects it.
- If an image cannot be found, a crop is invalid, an extraction limit is hit, or
  image processing fails, successfully extracted products remain reviewable and
  the warning is visible. Import without an image works.
- Verify stale/foreign candidate IDs, repeat imports, duplicate SKUs, competing
  import/reanalysis/delete operations, rollback, and file-cleanup failures.
  Reanalysis and catalog deletion never alter an imported product image.
- Test JPEG, PNG and WebP at and above 5 MiB, mismatched MIME/signature,
  malformed and oversized decoded images, duplicate multipart parts, and image
  replacement failures. Existing images remain intact on failed replacement.
- Verify admin versus standard access, authentication, Origin checks, private
  previews and image reads, audit records for views and mutations, and absence
  of file contents or storage keys in API output and logs.
- Verify existing products and old extraction results without image metadata,
  existing product and catalog API clients, and the unchanged public PDF upload
  flow. Run focused server tests, typecheck and lint, plus client build and lint.
