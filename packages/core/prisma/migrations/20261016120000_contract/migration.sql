-- CreateTable
CREATE TABLE "Contract" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "projectId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'entwurf',
    "externalId" TEXT,
    "taskId" TEXT,
    "file" TEXT,
    "signedOn" TIMESTAMP(3),
    "startsOn" TIMESTAMP(3),
    "endsOn" TIMESTAMP(3),
    "amountCents" INTEGER,
    "notes" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contract_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Contract_externalId_key" ON "Contract"("externalId");

-- CreateIndex
CREATE INDEX "Contract_clientId_archived_idx" ON "Contract"("clientId", "archived");

-- CreateIndex
CREATE INDEX "Contract_status_endsOn_idx" ON "Contract"("status", "endsOn");

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ActionItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

