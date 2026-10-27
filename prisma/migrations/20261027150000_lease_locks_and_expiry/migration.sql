-- Applies fully or not at all.
BEGIN;

-- Execution locks are rows with an expiry, so no database connection is held while a run works.
CREATE TABLE "execution_locks" (
    "key" TEXT NOT NULL,
    "owner" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "execution_locks_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "execution_locks_owner_idx" ON "execution_locks"("owner");

-- Expiry is kept here, so finished webhooks can be deleted later without forgetting it.
CREATE TABLE "expired_environments" (
    "environment_id" TEXT NOT NULL,
    "expired_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expired_environments_pkey" PRIMARY KEY ("environment_id")
);

INSERT INTO "expired_environments" ("environment_id", "expired_at")
SELECT "resource_id", MIN("created_at")
FROM "hosted_webhooks"
WHERE "type" = 'agent.environment.expired'
GROUP BY "resource_id";

COMMIT;
