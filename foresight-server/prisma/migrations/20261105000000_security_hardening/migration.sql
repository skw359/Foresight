-- Server admin + revocable sessions.
ALTER TABLE "User" ADD COLUMN "isAdmin" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- Existing deployments: the oldest account becomes the server admin.
UPDATE "User" SET "isAdmin" = true
WHERE "id" = (SELECT "id" FROM "User" ORDER BY "createdAt" ASC, "id" ASC LIMIT 1);

-- O(1) device-secret lookup + webhook session tracking.
ALTER TABLE "Camera" ADD COLUMN "deviceSecretSha256" TEXT;
ALTER TABLE "Camera" ADD COLUMN "livekitSid" TEXT;
CREATE UNIQUE INDEX "Camera_deviceSecretSha256_key" ON "Camera"("deviceSecretSha256");

-- E2EE bookkeeping.
ALTER TABLE "Home" ADD COLUMN "keyRotationRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Home" ADD COLUMN "recorderConsentRevokedAt" DATETIME;

-- Audit trail.
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "homeId" TEXT,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "actorLabel" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "details" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditEvent_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AuditEvent_homeId_createdAt_idx" ON "AuditEvent"("homeId", "createdAt");
