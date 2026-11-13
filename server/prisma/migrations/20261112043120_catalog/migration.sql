-- CreateEnum
CREATE TYPE "CatalogAnalysisStatus" AS ENUM ('not_processed', 'queued', 'processing', 'processed', 'failed');

-- AlterTable
ALTER TABLE "catalogs" ADD COLUMN     "analysis_status" "CatalogAnalysisStatus" NOT NULL DEFAULT 'not_processed';

-- CreateTable
CREATE TABLE "catalog_extraction_jobs" (
    "id" UUID NOT NULL,
    "catalog_id" UUID NOT NULL,
    "status" "CatalogAnalysisStatus" NOT NULL DEFAULT 'queued',
    "stage" VARCHAR(50) NOT NULL DEFAULT 'queued',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "current_page" INTEGER NOT NULL DEFAULT 0,
    "total_pages" INTEGER NOT NULL DEFAULT 0,
    "products_identified" INTEGER NOT NULL DEFAULT 0,
    "processing_error" TEXT,
    "results" JSONB,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "catalog_extraction_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "catalog_extraction_jobs_catalog_id_created_at_idx" ON "catalog_extraction_jobs"("catalog_id", "created_at");

-- CreateIndex
CREATE INDEX "catalog_extraction_jobs_status_created_at_idx" ON "catalog_extraction_jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "catalogs_analysis_status_idx" ON "catalogs"("analysis_status");

-- AddForeignKey
ALTER TABLE "catalog_extraction_jobs" ADD CONSTRAINT "catalog_extraction_jobs_catalog_id_fkey" FOREIGN KEY ("catalog_id") REFERENCES "catalogs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
