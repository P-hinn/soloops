-- CreateTable
CREATE TABLE "InvoiceSequence" (
    "year" INTEGER NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "InvoiceSequence_pkey" PRIMARY KEY ("year")
);

-- Seed the counter from the invoices that already exist, so the first number
-- handed out after this migration continues the series instead of restarting
-- it.
--
-- The sequence is read off the end of the number rather than with
-- split_part: the prefix comes from INVOICE_NUMBER_PREFIX and may itself
-- contain a dash. Numbers whose tail is not a number at all are skipped
-- instead of counted as zero — a hand-edited "RE-2026-storno" must not
-- decide where the series continues, and it must not break this migration
-- either.
INSERT INTO "InvoiceSequence" ("year", "last")
SELECT EXTRACT(YEAR FROM "issueDate")::int AS year,
       MAX(regexp_replace("number", '^.*-', '')::int) AS last
FROM "Invoice"
WHERE regexp_replace("number", '^.*-', '') ~ '^[0-9]+$'
GROUP BY 1
ON CONFLICT ("year") DO NOTHING;
