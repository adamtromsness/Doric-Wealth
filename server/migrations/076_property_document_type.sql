-- Property documents gain a category (deed, survey, insurance, …) so they can be
-- grouped, matching vehicle documents. Additive & idempotent.
ALTER TABLE property_documents ADD COLUMN IF NOT EXISTS doc_type TEXT NOT NULL DEFAULT 'other';
