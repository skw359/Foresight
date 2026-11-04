-- AlterTable
ALTER TABLE "Camera" ADD COLUMN "publicKey" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "keyKdf" JSONB;
ALTER TABLE "User" ADD COLUMN "keyNonce" TEXT;
ALTER TABLE "User" ADD COLUMN "publicKey" TEXT;
ALTER TABLE "User" ADD COLUMN "wrappedPrivateKey" TEXT;

-- CreateTable
CREATE TABLE "HomeKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "homeId" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "holderType" TEXT NOT NULL,
    "holderId" TEXT NOT NULL,
    "sealedKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HomeKey_homeId_fkey" FOREIGN KEY ("homeId") REFERENCES "Home" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RecorderIdentity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "publicKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Home" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "keyEpoch" INTEGER NOT NULL DEFAULT 0
);
INSERT INTO "new_Home" ("createdAt", "id", "name") SELECT "createdAt", "id", "name" FROM "Home";
DROP TABLE "Home";
ALTER TABLE "new_Home" RENAME TO "Home";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "HomeKey_homeId_epoch_idx" ON "HomeKey"("homeId", "epoch");

-- CreateIndex
CREATE UNIQUE INDEX "HomeKey_homeId_epoch_holderType_holderId_key" ON "HomeKey"("homeId", "epoch", "holderType", "holderId");
