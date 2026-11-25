CREATE TYPE "CatalogAnalysisPrompt" AS ENUM ('supplier', 'tags');
ALTER TABLE "catalog_extraction_jobs"
ADD COLUMN "prompt" "CatalogAnalysisPrompt" NOT NULL DEFAULT 'supplier';
