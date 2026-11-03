-- Rebuild the run-context issue index for the renamed `nexusIssue` snapshot key without
-- blocking run writes. Top-level statements: CONCURRENTLY cannot run inside a transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "heartbeat_runs_company_ctx_nexus_issue_created_idx" ON "heartbeat_runs" USING btree ("company_id",("context_snapshot" -> 'nexusIssue' ->> 'id'),"created_at" DESC NULLS LAST);--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "heartbeat_runs_company_ctx_paperclip_issue_created_idx";
