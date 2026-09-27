-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "leaseVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "possibleDuplicateSend" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "workerInstanceId" TEXT;
