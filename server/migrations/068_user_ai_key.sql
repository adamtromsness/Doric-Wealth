-- Relocate the Anthropic API key + model from the household to the user (each
-- person brings their own key). Carries any existing household key over to that
-- household's owner, then drops the household columns. Idempotent.
ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_api_key TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_model   TEXT;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'households' AND column_name = 'ai_api_key') THEN
    UPDATE users u
       SET ai_api_key = h.ai_api_key,
           ai_model   = COALESCE(u.ai_model, h.ai_model)
      FROM households h JOIN memberships m ON m.household_id = h.id
     WHERE m.user_id = u.id AND m.role = 'owner'
       AND h.ai_api_key IS NOT NULL AND u.ai_api_key IS NULL;
    ALTER TABLE households DROP COLUMN ai_api_key;
    ALTER TABLE households DROP COLUMN ai_model;
  END IF;
END $$;
