/*
  Warnings:

  - Added the required column `expires` to the `BannedIP` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_BannedIP" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reason" TEXT NOT NULL,
    "expires" DATETIME NOT NULL
);
INSERT INTO "new_BannedIP" ("id", "reason") SELECT "id", "reason" FROM "BannedIP";
DROP TABLE "BannedIP";
ALTER TABLE "new_BannedIP" RENAME TO "BannedIP";
PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
