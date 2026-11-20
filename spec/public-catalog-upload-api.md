# Public catalog upload API: specification and implementation plan

Status: **implemented**. Production use requires the deployment checks below.
[SPEC.md](../SPEC.md) remains the source of truth for application requirements.

## Goal and scope

Allow an external script or integration to upload a PDF catalog over HTTPS using
an existing administrator's email address and password. A caller may omit the
catalog name; the server immediately generates one from the uploaded filename.
No Gemini request blocks upload. A later, explicitly started full analysis may
replace that generated placeholder and assign a complete root-to-leaf category
path. The catalog is created without a supplier and can be edited in the existing UI.

This is an authenticated public-facing endpoint, not anonymous access. It only
adds catalog upload; supplier assignment, catalog editing, download, analysis,
and integration account management are out of scope. Use a dedicated existing
admin account where practical; its credentials still grant full admin access to
the application, not just this endpoint.

## Existing behavior and compatibility

- `POST /api/v1/catalogs` requires an admin session and an `Origin` matching
  `APP_ORIGIN`; its catalog `name` is optional.
- `Catalog.name` is non-null and limited to 200 characters. Keep that invariant:
  no database migration or nullable-name UI changes are needed.
- Catalog uploads validate both PDF MIME type and `%PDF-` signature, store files
  under generated private storage keys, and write catalog metadata and audit
  records transactionally. Reuse this service rather than duplicating it.
- Analysis is disabled by default and, when enabled, is started explicitly.
  An upload remains `not_processed` and must not start analysis or import data.
- Existing session-authenticated endpoints and CSRF rules remain unchanged;
  browser and machine-to-machine uploads use the same metadata inference.

## Endpoint

### `POST /api/v1/public/catalogs`

HTTPS is required in production; development and test environments may use
HTTP locally. Accept HTTP Basic authentication in the `Authorization` header:
the username is the existing user's email and the password is that user's
current password. Authenticate each request; do not create or accept a session
for this endpoint. Only active admins who are not required to change their
password may upload. An inactive account or invalid credentials receives the
same generic authentication error; an authenticated standard user or admin
required to change their password receives `403`.

Request: `multipart/form-data`.

| Field | Required | Behavior |
|---|---|---|
| `file` | Yes | Exactly one PDF file part; declare `application/pdf`. |
| `name` | No | If supplied, trim and validate as 1–200 characters. Omitted, empty, or whitespace-only values use vendor deduction and the filename fallback below. |

Reject duplicate fields, additional file parts, and unsupported fields with a
validation error. The file part must have a multipart filename parameter so the
server can recognize it as a file; a catalog name field is not required.

**Name derivation:** when no non-empty name is supplied, sanitize the supplied
filename using the existing
`sanitizeFileName` helper, remove a trailing `.pdf` case-insensitively, trim
the result, and truncate safely to the existing 200-character validator limit
without splitting a surrogate pair. If the result is empty, use `Catalog`.
The original sanitized filename is still stored separately. Generated names
need not be unique. For example, `spring prices.PDF` becomes `spring prices`.

**Analysis metadata:** a later full Gemini analysis classifies the catalog into
every distinct category represented by its extracted products and identifies a
clear catalog title in the same request. Gemini returns complete bilingual
root-to-leaf paths. Existing nodes are reused under the same parent by their
English name, while missing nodes are created and audited when the analysis
completes. Only the leaf of each path is directly assigned to the catalog. The
inferred title replaces a filename-derived placeholder but never an explicitly
supplied catalog name. If either value is uncertain, the existing name or
categories are retained.

**File validation:** enforce the `PUBLIC_CATALOG_MAX_UPLOAD_MB` limit (default
100 MiB), PDF MIME type and `%PDF-` signature, private storage, and cleanup on
failed metadata transaction. The existing `MAX_UPLOAD_MB` limit for session
uploads remains separate. Do not trust the filename or extension as evidence
that a file is a PDF.

### Example request

From the repository root, use the included PowerShell script:

```powershell
.\tools\upload-catalog.ps1 -FilePath "C:\path\to\catalog.pdf" -Email "admin@example.com"
```

The script securely prompts for the password. It defaults to the local API; use `-Url`
with the full HTTPS endpoint URL for a deployed server. Add `-Name "Catalog
name"` to supply a name. The public API's configured size limit still applies.

In PowerShell, set `API_EMAIL` in the environment first. `curl.exe` prompts for
the password when `--user` is supplied with an email but no password.

```powershell
curl.exe --fail-with-body --user "$env:API_EMAIL" `
  -H "X-Catalog-Upload: 1" `
  -F "file=@C:\path\to\catalog.pdf;type=application/pdf" `
  https://your-host.example/api/v1/public/catalogs
```

Never put credentials in the URL or source control. Avoid passing passwords on
the command line, where process listings or shell history may expose them.

### Success response

Return `201 Created` with `{ "catalog": ... }` using the existing catalog DTO.
The response includes the new catalog ID; the existing UI can find and manage
the catalog. No Basic-authenticated read endpoint is included in this scope.

```json
{
  "catalog": {
    "id": "c1bba094-dc0d-4c54-a578-d7426574031b",
    "supplierId": null,
    "name": "spring prices",
    "version": null,
    "originalFileName": "spring prices.PDF",
    "mimeType": "application/pdf",
    "sizeBytes": 12345,
    "uploadedById": "1ae99ab6-50dd-4b04-b7d7-353c3cd2d778",
    "analysisStatus": "not_processed",
    "createdAt": "2026-11-16T13:00:00.000Z",
    "updatedAt": "2026-11-16T13:00:00.000Z",
    "categories": []
  }
}
```

### Errors and retries

Use the existing `{ "error": { "code", "message", "details" } }` envelope.

| HTTP | Code | Example |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing file, invalid name, unsupported or duplicate fields, malformed multipart. |
| 401 | `UNAUTHENTICATED` | Missing, malformed, invalid, or inactive-account credentials; include `WWW-Authenticate: Basic realm="catalog-upload", charset="UTF-8"`. |
| 403 | `FORBIDDEN` | Insufficient role, required password change, or rejected browser-origin request. |
| 413 | `PAYLOAD_TOO_LARGE` | File exceeds the configured limit. |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | File MIME type or signature is not PDF. |
| 429 | `RATE_LIMITED` | Authentication attempt throttled; return `Retry-After`. |
| 500 | `INTERNAL_ERROR` | Unexpected storage, database, or server error. |

No idempotency key or deduplication is included in this scope. A retry after a
timeout may create a second catalog if the first request succeeded; clients
must account for that possibility rather than blindly retrying.

## Security and operations

1. Require TLS for all public traffic, including authentication; never expose
   the Fastify port directly to the internet. Configure the reverse proxy to
   reject plaintext API requests rather than redirecting requests containing
   credentials. Production rollout is blocked until HTTPS, proxy body limits,
   upload timeouts, and private upstream binding are verified.
2. Basic credentials can be automatically replayed by browsers. Scope the
   global Origin-check exception **only** to this exact route and method.
   Require `X-Catalog-Upload: 1`, reject requests carrying any `Origin` or
   `Sec-Fetch-*` header, and do not permit this header through CORS. This is a
   machine-to-machine API, not a browser upload API. The rest of the app keeps
   its existing CSRF protection. Ignore cookies for authentication here.
3. Use existing password hashing/verification, email normalization, and dummy
   hash verification for unknown users. Rate-limit failed authentication by
   account and client IP, including unknown accounts; valid upload volume must
   not consume a login-attempt quota. Share the account-failure limiter with
   existing login as appropriate. Return generic failures and never record
   passwords, Authorization headers, cookies, or file contents in logs or audit.
4. Ensure IP throttling sees the real client IP without trusting arbitrary
   forwarded headers: trust only the known reverse proxy, which must overwrite
   incoming forwarding headers. Address multi-instance deployment explicitly:
   current in-memory account counters are per process; use a shared limiter or
   enforce a shared proxy limit before deploying multiple instances.
5. Audit authentication failures and successful authentication using existing
   audit conventions, including attempted email, request ID, and client IP.
   Audit each successful catalog upload with the actual admin actor in the same
   transaction as metadata creation. Avoid creating session or logout records.
   Audit records and application errors must not contain credentials or PDF
   contents.
6. Document credential rotation, account deactivation, and password-change
   recovery through existing admin workflows. Password reset, deactivation, or
   role changes take effect on the next request.

## Implementation and deployment checklist

1. The endpoint shares account failure throttling with session login, applies a
   separate per-IP failure limit, bounds concurrent authentication attempts,
   and reuses the catalog upload service. These in-memory counters are per
   process; deploy one instance unless a shared limiter or shared proxy limit is
   configured.
2. Set `NODE_ENV=production` so Fastify binds to `127.0.0.1`, trusts forwarded
   headers only from loopback, and requires HTTPS for this endpoint. Production
   must use a trusted reverse proxy on the same host; do not expose the upstream.
3. Before enabling [nginx-site.conf](../deploy/nginx-site.conf), obtain a TLS
   certificate, review the hostname and certificate paths, and set the public
   route's proxy body limit above `PUBLIC_CATALOG_MAX_UPLOAD_MB` plus multipart
   overhead. The provided configuration uses 105 MiB for the default 100 MiB
   file limit. Validate with `nginx -t`,
   reload, and confirm HTTPS, the plaintext API rejection, the JSON `413`,
   request timeouts, and client IP forwarding on the actual deployment.
4. Verify the deployed endpoint over HTTPS with a non-production test account.
   Never test with real credentials over HTTP. Account password resets,
   deactivation, and role changes apply to the next request.
5. To isolate server tests from any existing test database, set
   `TEST_DATABASE_URL` to a disposable PostgreSQL database whose name ends in
   `_test`. Tests apply migrations and truncate its tables.

Uploads are buffered in server memory before storage; a 100 MiB upload can use
more than 100 MiB of memory, and concurrent uploads multiply that demand.
Check available memory, proxy temporary disk space, and upload timeouts before
deployment. Catalog analysis has separate limits and may not support every
catalog accepted for upload.

## Acceptance checks

- Existing admin credentials can upload a valid PDF without `name`; response is
  `201`, generated name and DTO fields are correct, the catalog appears in the
  existing UI, and `analysisStatus` is `not_processed`.
- Explicit valid name is preserved after trimming; blank names use deduction,
  while oversized, duplicate, and unknown fields fail. Test filenames with paths, unsafe characters,
  uppercase extension, empty stem, long and non-ASCII names; generated names
  always meet the existing validator and stored filenames remain sanitized.
- Missing, malformed, wrong, inactive, standard-user, and password-change
  credentials receive the specified errors; username enumeration is not
  exposed. Reset passwords and role/deactivation changes take effect on the
  next request. No session is created.
- Missing file, invalid MIME, bad signature, oversize, multiple files, and
  malformed multipart fail with the specified status and no catalog or orphaned
  file. Simulated storage and transaction failures are surfaced and cleaned up
  according to existing storage semantics.
- Verify IP and account throttling, `Retry-After`, shared-account protection
  with normal login, and that successful uploads do not exhaust the failed-login
  quota. Test untrusted forwarded headers and the deployed proxy configuration.
- Requests with browser Origin or Fetch Metadata headers, without the required
  custom header, or using only a session cookie cannot upload. Existing
  session endpoints retain their Origin checks and role requirements.
- Successful and failed authentication and successful uploads have the expected
  audit actor and request context, with the upload audit transactional; no
  credentials or file contents appear in audit or captured logs.
- Verify HTTPS-only public access, proxy error envelope and file-size limit,
  and that upload requests do not start analysis or create products.
