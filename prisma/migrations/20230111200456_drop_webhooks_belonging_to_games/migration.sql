/*
  Warnings:

  - You are about to drop the column `belongsTo` on the `WebhooksSeen` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_WebhooksSeen" (
    "id" TEXT NOT NULL PRIMARY KEY
);
INSERT INTO "new_WebhooksSeen" ("id") SELECT "id" FROM "WebhooksSeen";
DROP TABLE "WebhooksSeen";
ALTER TABLE "new_WebhooksSeen" RENAME TO "WebhooksSeen";
PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
