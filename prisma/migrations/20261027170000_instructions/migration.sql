-- Applies fully or not at all.
BEGIN;

-- Custom helper instructions. A missing row means the default file is used.
CREATE TABLE "instructions" (
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "instructions_pkey" PRIMARY KEY ("name")
);

COMMIT;
