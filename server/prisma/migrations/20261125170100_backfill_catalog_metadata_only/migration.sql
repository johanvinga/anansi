UPDATE "catalogs" AS c
SET "analysis_status" = 'metadata_only'
WHERE c."analysis_status" = 'processed'
  AND NOT EXISTS (
    SELECT 1 FROM "catalog_extraction_jobs" j
    WHERE j."catalog_id" = c."id" AND j."prompt" = 'tags' AND j."status" = 'processed'
  );
