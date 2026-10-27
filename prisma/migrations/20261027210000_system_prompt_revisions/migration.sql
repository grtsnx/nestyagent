-- Versions come from one counter, so a deleted and re-created prompt never reuses an old
-- version, and a stale editor cannot change the new one. Prisma names it like autoincrement().
BEGIN;

LOCK TABLE "system_prompts" IN ACCESS EXCLUSIVE MODE;
CREATE SEQUENCE system_prompts_version_seq;
SELECT setval('system_prompts_version_seq', COALESCE(MAX("version"), 0) + 1, false)
FROM "system_prompts";
ALTER TABLE "system_prompts" ALTER COLUMN "version" SET DEFAULT nextval('system_prompts_version_seq');
ALTER SEQUENCE system_prompts_version_seq OWNED BY "system_prompts"."version";

COMMIT;
