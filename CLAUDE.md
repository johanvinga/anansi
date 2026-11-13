# Project: Supplier & Product Management

Full-stack web application for managing suppliers, supplier assets (PDF catalogs), products, and attribute sets. The source of truth for requirements is [SPEC.md](SPEC.md). Read it before making changes that affect behavior, data, or the API.

## Status

- Milestone M1 (project setup, database, authentication, roles, user management, audit logging) is implemented.
- Milestones M1 (setup, auth, roles, users, audit), M2 (suppliers, categories, assets), and M3 (attribute sets, products) are implemented on the server and client.
- Not yet implemented: M4 (UI polish, Docker app image, security review, Playwright E2E tests).
- Catalog uploads are analyzed asynchronously using a BullMQ worker, Redis, PDF.js, and Tesseract.js; admins can review candidates and explicitly create products or attribute sets from them, but analysis never imports records automatically.
- Supplier deletion is blocked while the supplier has products (SPEC §8.3).
- Products have independent category assignments; supplier category summaries inherit the union of categories assigned to their products.
- Attribute value validation lives in `server/src/services/attribute-values.ts`. Product saves go through `product.service.ts`.
- Seed the example attribute sets (SPEC §4.5) with `npm run seed:attribute-sets` in `server/`.
- Docker Compose currently runs PostgreSQL only. The app runs with `npm run dev` in each package.

## Stack

- Frontend: React + TypeScript, built with Vite
- UI components: shadcn/ui (https://ui.shadcn.com), built on Radix UI and Tailwind CSS v4, styled after the shadcn dashboard demo (Geist font, sidebar shell)
- Backend: Node.js + TypeScript with Fastify
- Database: PostgreSQL with Prisma 7 (versioned migrations only)
- Validation: Zod for API inputs
- Testing: Vitest (unit, API via Supertest), Playwright (E2E, planned)
- Local run: Docker Compose for PostgreSQL and Redis

## Layout

- `client/` React app (Vite dev server on port 5173, proxies `/api` to the server)
  - `src/api/` fetch wrapper and shared API types
  - `src/auth/` auth state and provider
  - `src/components/` shared wrappers around shadcn components (for example `FormField`); `src/components/ui/` holds the shadcn primitives themselves
  - `src/features/` pages grouped by domain (`auth`, `account`, `users`, `audit`)
  - `src/layout/` app shell with the shadcn sidebar and a light/dark theme toggle
- `server/` Fastify API (port 3000)
  - `prisma/` schema and migrations
  - `src/routes/` HTTP layer only (parse input, call services, shape responses)
  - `src/services/` business rules and audit writes
  - `src/lib/` helpers (guards, password hashing, validation, login limiter)
  - `src/scripts/seed-admin.ts` creates the first admin
  - `src/test/` shared test helpers and global setup
- `server/storage/assets/` uploaded asset files, created on first upload (never served directly; access goes through the API).
- `docker-compose.yml` and `docker/db-init/` local PostgreSQL. Creates the `supplier_app_test` database on first start.

## Commands

Run from the repository root unless noted.

| Task | Command |
|---|---|
| Start PostgreSQL and Redis | `docker compose up -d db redis` |
| Install server | `cd server && npm install` (runs `prisma generate` automatically) |
| Install client | `cd client && npm install` |
| Configure server | Copy `server/.env.example` to `server/.env`; set `SESSION_SECRET` (32+ chars) |
| Apply migrations (dev) | `cd server && npm run db:migrate` |
| Apply migrations (deploy) | `cd server && npm run db:deploy` |
| Create first admin | `cd server && npm run seed:admin -- <email> <password>` (or set `SEED_ADMIN_PASSWORD`) |
| API dev server | `cd server && npm run dev` |
| Client dev server | `cd client && npm run dev` |
| Server tests | `cd server && npm test` (uses `supplier_app_test`; migrations are applied automatically) |
| Server typecheck | `cd server && npm run typecheck` |
| Server lint | `cd server && npm run lint` |
| Client build (includes typecheck) | `cd client && npm run build` |
| Client lint | `cd client && npm run lint` |

Before committing, run the typecheck, lint, and test commands for the packages you changed.

## Domain Rules (from SPEC.md)

- Two roles: `admin` and `standard`. Standard users are read-only for all data. Admins can create, edit, and delete data and manage user accounts.
- Admins create user accounts and reset passwords. There is no self-registration.
- Every user action is written to the audit log: logins (including failed attempts), successful changes (with before/after values), and views or downloads. Only admins can read the audit log. Entries are never deleted. The `audit_logs` table rejects UPDATE, DELETE, and TRUNCATE through a trigger.
- Each product has its own currency (ISO 4217 code).
- Supplier SKU is unique per supplier, case-insensitive.
- A supplier with products cannot be deleted.
- Attribute sets with products cannot be deleted. Attribute fields with values are archived, not deleted. A field's data type cannot change once it has values.
- Uploads: PDF only, validated by MIME type and `%PDF-` signature, with a size limit. Files are stored under generated names, outside any public directory.
- Sessions use signed, httpOnly cookies named `sid`. Passwords are hashed with bcrypt at cost 12 (via `bcryptjs`).
- Mutating API requests must send an `Origin` header equal to `APP_ORIGIN` (CSRF check).
- Users with `mustChangePassword` can only call `/auth/me`, `/auth/logout`, and `/users/me/password`.

## Code Conventions

- TypeScript strict mode. Avoid `any`; if it's unavoidable, add a comment explaining why.
- Prefer `interface` for object shapes and discriminated unions for complex state.
- Named exports only. No default exports.
- Functional React components only, with a `{Component}Props` interface for props.
- All UI components in the React app must come from shadcn/ui (`src/components/ui/`, added with `npx shadcn add`). Do not build custom equivalents of components it provides. Project-specific components may wrap shadcn components but must not replace them. Plain HTML elements (`button`, `table`, `form`) are used for layout and actions.
- Business rules live in service modules, not in route handlers or React components.
- All API inputs are validated with Zod. Errors use the `{ error: { code, message, details } }` shape from SPEC.md §12.
- Multi-step writes run in a transaction. Audit entries for data changes are written inside the same transaction.
- Case-insensitive unique names use a lowercased `name_key` column with a unique index (Prisma cannot model functional indexes).
- Uploaded files are saved before the metadata transaction. If the transaction fails, the file is removed.
- Catalog analysis uses `REDIS_URL` (default `redis://127.0.0.1:6379`), English/French OCR, and a single worker by default. Keep Redis private; the Compose service binds to loopback, caps memory at 384 MB, and persists its queue data.
- Catalog upload responses and catalog lists include `analysisStatus`. `GET /api/v1/catalogs/:catalogId/extraction` returns progress and extracted candidates; admins can retry with `POST` to the same endpoint.
- Case-insensitive unique names use a lowercased 
ame_key column with a unique index (Prisma cannot model functional indexes).
- Uploaded files are saved before the metadata transaction. If the transaction fails, the file is removed.
- Database changes go through Prisma migrations. Never edit an applied migration.
- Comment code only where the logic needs clarification.

## Testing

- Every API endpoint has tests covering success, validation failure, authentication, and authorization (admin vs. standard user).
- Every requirement ID in SPEC.md §4 should map to at least one test.
- Audit logging is tested for every write path.
- Server tests share one database, so test files run sequentially (`fileParallelism: false`).

## Git

- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`.
- Branch names: `feature/`, `fix/`, `chore/`.

## Do NOT

- Do not expose uploaded files through static hosting or direct URLs.
- Do not log passwords, session tokens, or file contents.
- Do not skip audit logging for any action listed in SPEC.md.
- Do not use UI components from any library other than shadcn/ui.
- Do not add dependencies outside the stack above without discussing first.
- Do not edit applied migrations.
- Do not use inline styles in the frontend.
