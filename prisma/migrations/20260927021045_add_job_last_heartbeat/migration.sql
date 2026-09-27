-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "lastHeartbeat" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Job_status_lastHeartbeat_idx" ON "Job"("status", "lastHeartbeat");
