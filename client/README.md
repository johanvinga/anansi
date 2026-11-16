# React + TypeScript + Vite

## Catalog analysis

PDF catalog analysis is disabled by default. To enable it, set
`CATALOG_EXTRACTION_ENABLED=true` and `GEMINI_API_KEY` in the server environment,
and restart the server with Redis available. `GEMINI_MODEL` defaults to
`gemini-3.5-flash-lite`. An admin must start each analysis explicitly. The complete
PDF is uploaded to Google Gemini for analysis; this may incur charges.
Catalog and supplier-asset uploads share the server's `MAX_UPLOAD_MB` limit
(default 25 MiB). Increase it in `server/.env` and restart the server to accept
larger files. Gemini catalog analysis separately limits PDFs to 50 MiB.
Only send catalogs you are authorized to share. Results require review and are
never imported automatically. Gemini is instructed to extract separate candidates
for distinct SKUs and variants, but may still miss items. Page count is limited by
`CATALOG_EXTRACTION_MAX_PAGES`.
For unassigned catalogs, new analysis results may also show an unverified supplier
suggestion with its source. Verify it and assign a supplier manually; the suggestion
does not create or assign a supplier. An existing supplier with the same
case-insensitive name is shown for review; a missing exact match does not mean
that a similar supplier is absent. An admin can create a supplier from the review
dialog, then explicitly confirm its assignment in the catalog editor. An existing
supplier can also be selected and explicitly assigned in the import preview;
the preview refreshes supplier-specific duplicate checks before import.
Product, supplier and catalog lists have a searchable category tree filter.
Selecting a category includes its descendants; multiple selections match any
branch. The product filter can also include uncategorized products.
The categories page shows full paths and supports creating, moving and renaming
categories. Deletion displays assignment and child-promotion impact before
confirmation. Product, supplier and catalog editors select direct assignments
from the tree; new categories require an explicit parent or root selection and
are created when the enclosing record is saved.
Catalog import displays suggested category matches with full paths. An admin
must resolve each suggestion to an existing category or approve creation under
an explicitly selected parent; additional existing categories may also be
assigned. If the category tree changes, refresh the preview and review again.
The analysis dialog offers a read-only review of selected or all candidates,
including missing required product fields, duplicate SKUs, extracted attribute
examples, and possible matches. Only the product name and SKU are required;
cost, currency and minimum quantity may be left blank. Exact compatible
independent attributes are selected automatically and new text attributes are
proposed for creation. Admins can review and change the mappings; incompatible
exact matches require review. Typed and
unit-bearing mappings require explicit per-product values; no unit conversion
is performed. Convert legacy set fields into shared attributes before reusing
them directly in imports. Duplicate supplier SKUs are
skipped; the import is transactional.

## Independent attributes

The Attributes page can create, rename and remove independent typed attributes,
and products can store their values without an attribute set. Removal archives
attributes with values, preserving those values; unused attributes are deleted.
Independent attributes can be added to multiple sets with set-specific required
and ordering settings. The Attributes page offers a confirmed bulk conversion of
legacy set fields; exact compatible definitions are merged, and archived,
incompatible or conflicting fields are reported for review. A merge remaps option
and field references to the retained definition, while preserving product values.
Conversions commit and audit separately, so a failed batch can be retried.
Apply the server's Prisma migrations before starting this version. Type, unit and
options are fixed when an independent attribute is created.
The worker requests deletion of the temporary Google file after analysis. If
deletion fails, the job fails and the file may remain at Google for up to 48 hours.
On HTTP 503, the analysis request is retried up to twice; retries may incur charges.
The application shares a budget of eight Gemini HTTP requests per rolling minute
per API key across instances connected to the same Redis. Upload steps, readiness
checks, model calls, retries, and deletion all count, so analysis may wait for
capacity. Redis must be available; requests fail rather than bypass the limit.
Other applications or API keys using the same Google project can consume its quota
independently, and resetting Redis loses the current request window.
Other failures and exhausted retries require a manual restart. Large catalogs may
exceed model context or output limits; truncated output is rejected rather than
saved as a complete result. Gemini page numbers and extracted data require review.
The new Gemini queue does not automatically consume jobs from the old OCR queue;
an admin can explicitly restart an old queued job. Disabled mode retains uploads
and downloads without starting a worker or showing analysis controls. Set the same
configuration and restart every server instance, then reload the client.

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
