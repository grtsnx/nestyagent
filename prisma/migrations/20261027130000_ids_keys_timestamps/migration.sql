-- Keeps every existing row. One transaction: it applies fully or not at all.
BEGIN;

-- Old times were written in UTC without a zone. Store them with the zone now.
ALTER TABLE "chat_items"
  ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC';

-- Ids become native UUIDs. Every id written so far is already a UUID.
ALTER TABLE "paused_runs"
  ALTER COLUMN "id" SET DATA TYPE UUID USING "id"::uuid,
  ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC',
  ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "updated_at" AT TIME ZONE 'UTC';

ALTER TABLE "remote_machines"
  ALTER COLUMN "claim_token" SET DATA TYPE UUID USING "claim_token"::uuid,
  ALTER COLUMN "claimed_at" SET DATA TYPE TIMESTAMPTZ(3) USING "claimed_at" AT TIME ZONE 'UTC',
  ADD COLUMN "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "remote_machines" ALTER COLUMN "updated_at" DROP DEFAULT;

-- One row per chat, created for every chat that already has items.
CREATE TABLE "chats" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "chats_pkey" PRIMARY KEY ("id")
);

INSERT INTO "chats" ("id", "created_at", "updated_at")
SELECT "chat_id", MIN("created_at"), MAX("created_at")
FROM "chat_items"
GROUP BY "chat_id";

ALTER TABLE "chat_items" ADD CONSTRAINT "chat_items_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
