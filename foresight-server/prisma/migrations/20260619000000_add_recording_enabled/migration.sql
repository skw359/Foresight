-- AlterTable: add 24/7 server-side recording toggle to Camera.
ALTER TABLE "Camera" ADD COLUMN "recordingEnabled" BOOLEAN NOT NULL DEFAULT false;
