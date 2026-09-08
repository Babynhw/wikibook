-- AlterTable
ALTER TABLE "Passage" ADD COLUMN     "endBlockOrd" INTEGER,
ADD COLUMN     "startBlockOrd" INTEGER;

-- CreateTable
CREATE TABLE "SourceBlock" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "ord" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "page" INTEGER,
    "paragraphIndex" INTEGER,
    "heading" TEXT,

    CONSTRAINT "SourceBlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SourceBlock_sourceId_page_idx" ON "SourceBlock"("sourceId", "page");

-- CreateIndex
CREATE UNIQUE INDEX "SourceBlock_sourceId_ord_key" ON "SourceBlock"("sourceId", "ord");

-- AddForeignKey
ALTER TABLE "SourceBlock" ADD CONSTRAINT "SourceBlock_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;
