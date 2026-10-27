-- Applies fully or not at all.
BEGIN;

-- Each user's Composio session, so the session id never comes from a request.
CREATE TABLE "composio_sessions" (
    "user_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "composio_sessions_pkey" PRIMARY KEY ("user_id")
);

CREATE UNIQUE INDEX "composio_sessions_session_id_key" ON "composio_sessions"("session_id");

COMMIT;
