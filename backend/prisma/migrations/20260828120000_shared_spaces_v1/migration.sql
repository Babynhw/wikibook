-- Shared spaces v1 (wiki-docs/plan/shared-spaces-v1/design.md "Migration").
--
-- Order matters: the membership table and actor columns are created and
-- backfilled from Space.ownerId *before* Space.lastOpenedAt is dropped, so no
-- existing space loses its resume state and no existing row loses its actor.
--
-- Reverse path (by hand, if ever needed): ALTER TABLE "Space" ADD COLUMN
-- "lastOpenedAt" TIMESTAMP(3); UPDATE "Space" s SET "lastOpenedAt" =
-- m."lastOpenedAt" FROM "SpaceMember" m WHERE m."spaceId" = s.id AND m.role =
-- 'owner'; then drop the tables and columns below.

-- CreateEnum
CREATE TYPE "SpaceRole" AS ENUM ('owner', 'editor', 'viewer');

-- CreateTable
CREATE TABLE "SpaceMember" (
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "SpaceRole" NOT NULL,
    "invitedById" TEXT,
    "lastOpenedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpaceMember_pkey" PRIMARY KEY ("spaceId","userId")
);

-- CreateTable
CREATE TABLE "SpaceInvite" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "SpaceRole" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpaceInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SpaceMember_userId_lastOpenedAt_idx" ON "SpaceMember"("userId", "lastOpenedAt");
CREATE UNIQUE INDEX "SpaceInvite_tokenHash_key" ON "SpaceInvite"("tokenHash");
CREATE UNIQUE INDEX "SpaceInvite_spaceId_email_key" ON "SpaceInvite"("spaceId", "email");

-- AddForeignKey
ALTER TABLE "SpaceMember" ADD CONSTRAINT "SpaceMember_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SpaceMember" ADD CONSTRAINT "SpaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SpaceInvite" ADD CONSTRAINT "SpaceInvite_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SpaceInvite" ADD CONSTRAINT "SpaceInvite_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Actor columns
ALTER TABLE "Source" ADD COLUMN "addedById" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "userId" TEXT;
ALTER TABLE "Note" ADD COLUMN "authorId" TEXT;
ALTER TABLE "Notebook" ADD COLUMN "updatedById" TEXT;

ALTER TABLE "Source" ADD CONSTRAINT "Source_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Note" ADD CONSTRAINT "Note_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Notebook" ADD CONSTRAINT "Notebook_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Data: one owner row per existing space, carrying its resume timestamp.
INSERT INTO "SpaceMember" ("spaceId", "userId", "role", "lastOpenedAt", "createdAt")
SELECT s.id, s."ownerId", 'owner', s."lastOpenedAt", s."createdAt" FROM "Space" s;

-- Data: everything that exists today was done by the owner.
UPDATE "Source" src SET "addedById" = s."ownerId" FROM "Space" s WHERE src."spaceId" = s.id;
UPDATE "Conversation" c SET "userId" = s."ownerId" FROM "Space" s WHERE c."spaceId" = s.id;
UPDATE "Note" n SET "authorId" = s."ownerId" FROM "Space" s WHERE n."spaceId" = s.id;
UPDATE "Notebook" nb SET "updatedById" = s."ownerId" FROM "Space" s WHERE nb."spaceId" = s.id;

-- Only now is the per-space column redundant.
ALTER TABLE "Space" DROP COLUMN "lastOpenedAt";

-- Conversation index gains the member dimension.
DROP INDEX "Conversation_spaceId_idx";
CREATE INDEX "Conversation_spaceId_userId_idx" ON "Conversation"("spaceId", "userId");
