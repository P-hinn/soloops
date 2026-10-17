-- CreateTable
CREATE TABLE "ReserveYear" (
    "id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "vatRate" DOUBLE PRECISION NOT NULL DEFAULT 19,
    "incomeTaxRate" DOUBLE PRECISION NOT NULL DEFAULT 35,
    "discountRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReserveYear_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReserveCost" (
    "id" TEXT NOT NULL,
    "yearId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "monthlyCents" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ReserveCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReserveMonth" (
    "id" TEXT NOT NULL,
    "yearId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "grossCents" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReserveMonth_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReserveYear_year_key" ON "ReserveYear"("year");

-- CreateIndex
CREATE INDEX "ReserveCost_yearId_position_idx" ON "ReserveCost"("yearId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ReserveMonth_yearId_month_key" ON "ReserveMonth"("yearId", "month");

-- AddForeignKey
ALTER TABLE "ReserveCost" ADD CONSTRAINT "ReserveCost_yearId_fkey" FOREIGN KEY ("yearId") REFERENCES "ReserveYear"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReserveMonth" ADD CONSTRAINT "ReserveMonth_yearId_fkey" FOREIGN KEY ("yearId") REFERENCES "ReserveYear"("id") ON DELETE CASCADE ON UPDATE CASCADE;
