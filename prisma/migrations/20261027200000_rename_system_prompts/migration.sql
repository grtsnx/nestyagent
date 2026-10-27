-- "Instructions" became "system prompts". Renaming keeps every saved prompt.
BEGIN;

ALTER TABLE "instructions" RENAME TO "system_prompts";
ALTER TABLE "system_prompts" RENAME CONSTRAINT "instructions_pkey" TO "system_prompts_pkey";

COMMIT;
