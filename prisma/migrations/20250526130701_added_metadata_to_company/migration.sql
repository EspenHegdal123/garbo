-- DropIndex
DROP INDEX "Company_lei_key";

-- AlterTable
ALTER TABLE "Metadata" ADD COLUMN     "companyId" TEXT;

-- AddForeignKey
ALTER TABLE "Metadata" ADD CONSTRAINT "Metadata_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("wikidataId") ON DELETE SET NULL ON UPDATE CASCADE;
