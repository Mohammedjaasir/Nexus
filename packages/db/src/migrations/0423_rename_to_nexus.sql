ALTER TABLE "tool_connections" DROP CONSTRAINT "tool_connections_credential_source_check";--> statement-breakpoint
ALTER TABLE "tool_connections" DROP CONSTRAINT "tool_connections_credential_source_one_of_check";--> statement-breakpoint
-- Rewrite stored product-owned values so existing rows keep satisfying the renamed
-- CHECK constraints and stay inside the renamed partial indexes.
UPDATE "tool_connections" SET "credential_source" = 'nexus_vault' WHERE "credential_source" = 'paperclip_vault';--> statement-breakpoint
UPDATE "company_secrets" SET "managed_mode" = 'nexus_managed' WHERE "managed_mode" = 'paperclip_managed';--> statement-breakpoint
UPDATE "user_secret_definitions" SET "managed_mode" = 'nexus_managed' WHERE "managed_mode" = 'paperclip_managed';--> statement-breakpoint
UPDATE "environments"
  SET "metadata" = ("metadata" - 'managedByPaperclip') || jsonb_build_object('managedByNexus', "metadata" -> 'managedByPaperclip')
  WHERE "metadata" ? 'managedByPaperclip';--> statement-breakpoint
UPDATE "agent_instruction_working_copies"
  SET "receipt" = jsonb_set("receipt", '{schema}', '"nexus.agent-files.v1"')
  WHERE "receipt" ->> 'schema' = 'paperclip.agent-files.v1';--> statement-breakpoint
UPDATE "issue_recovery_actions"
  SET "evidence" = jsonb_set("evidence", '{workspaceRestoreRecovery,schema}', '"nexus.workspace-restore-recovery.v1"')
  WHERE "evidence" -> 'workspaceRestoreRecovery' ->> 'schema' = 'paperclip.workspace-restore-recovery.v1';--> statement-breakpoint
-- heartbeat_runs_retained_recovery_adoption_idx (dropped below) still covers exactly these rows here.
UPDATE "heartbeat_runs"
  SET "result_json" = jsonb_set("result_json", '{workspaceRestoreRecovery,schema}', '"nexus.workspace-restore-recovery.v1"')
  WHERE "result_json" -> 'workspaceRestoreRecovery' ->> 'schema' = 'paperclip.workspace-restore-recovery.v1';--> statement-breakpoint
DROP INDEX "agent_instruction_copies_collection_idx";--> statement-breakpoint
DROP INDEX "agent_instruction_copies_cleanup_idx";--> statement-breakpoint
DROP INDEX "environments_managed_sandbox_idx";--> statement-breakpoint
DROP INDEX "heartbeat_runs_cancelled_workspace_preservation_idx";--> statement-breakpoint
DROP INDEX "heartbeat_runs_retained_recovery_adoption_idx";--> statement-breakpoint
DROP INDEX "issue_recovery_actions_system_recovery_adoption_idx";--> statement-breakpoint
DROP INDEX "issue_recovery_actions_retained_workspace_recovery_idx";--> statement-breakpoint
ALTER TABLE "chat_identity_links" RENAME COLUMN "paperclip_user_id" TO "nexus_user_id";--> statement-breakpoint
ALTER TABLE "company_secrets" ALTER COLUMN "managed_mode" SET DEFAULT 'nexus_managed';--> statement-breakpoint
ALTER TABLE "execution_workspace_snapshots" ALTER COLUMN "format" SET DEFAULT 'nexus.remote-workspace-archive.v1';--> statement-breakpoint
ALTER TABLE "feedback_exports" ALTER COLUMN "schema_version" SET DEFAULT 'nexus-feedback-envelope-v2';--> statement-breakpoint
ALTER TABLE "feedback_exports" ALTER COLUMN "bundle_version" SET DEFAULT 'nexus-feedback-bundle-v2';--> statement-breakpoint
ALTER TABLE "feedback_exports" ALTER COLUMN "payload_version" SET DEFAULT 'nexus-feedback-v1';--> statement-breakpoint
ALTER TABLE "tool_connections" ALTER COLUMN "credential_source" SET DEFAULT 'nexus_vault';--> statement-breakpoint
ALTER TABLE "user_secret_definitions" ALTER COLUMN "managed_mode" SET DEFAULT 'nexus_managed';--> statement-breakpoint
CREATE INDEX "agent_instruction_copies_collection_idx" ON "agent_instruction_working_copies" USING btree ("run_id","company_id") WHERE NOT (coalesce("agent_instruction_working_copies"."receipt", '{}'::jsonb) ? 'retainedByRunId') AND (
      ("agent_instruction_working_copies"."attempts" < 3 AND ("agent_instruction_working_copies"."state" IN ('prepared', 'pending_collection', 'unchanged_turn', 'warm_saved')
        OR ("agent_instruction_working_copies"."state" = 'preparing' AND "agent_instruction_working_copies"."receipt"->>'schema' = 'nexus.agent-files.v1')))
      OR ("agent_instruction_working_copies"."state" = 'unavailable' AND "agent_instruction_working_copies"."process_stopped_at" IS NULL
        AND "agent_instruction_working_copies"."location" LIKE 'remote:%' AND "agent_instruction_working_copies"."receipt"->>'schema' = 'nexus.agent-files.v1'));--> statement-breakpoint
CREATE INDEX "agent_instruction_copies_cleanup_idx" ON "agent_instruction_working_copies" USING btree ("run_id","company_id") WHERE "agent_instruction_working_copies"."state" IN ('saved', 'unchanged', 'resolved', 'unavailable')
      AND "agent_instruction_working_copies"."process_stopped_at" IS NOT NULL
      AND "agent_instruction_working_copies"."receipt"->>'schema' = 'nexus.agent-files.v1'
      AND coalesce("agent_instruction_working_copies"."receipt"->>'retainedByRunId', '') = ''
      AND "agent_instruction_working_copies"."receipt"->>'cleanupPending' IS DISTINCT FROM 'false'
      AND ("agent_instruction_working_copies"."receipt" ? 'baseline' OR "agent_instruction_working_copies"."receipt"->>'cleanupPending' = 'true');--> statement-breakpoint
CREATE UNIQUE INDEX "environments_managed_sandbox_idx" ON "environments" USING btree ("driver") WHERE "environments"."driver" = 'sandbox' AND ("environments"."metadata" ->> 'managedByNexus')::boolean = true;--> statement-breakpoint
CREATE INDEX "heartbeat_runs_cancelled_workspace_preservation_idx" ON "heartbeat_runs" USING btree ("id","company_id") WHERE "heartbeat_runs"."runtime_mode" = 'native' AND "heartbeat_runs"."status" = 'cancelled'
        AND "heartbeat_runs"."runner_profile_json"->'nativeWorkspaceSync'->>'state' = 'prepared'
        AND "heartbeat_runs"."result_json"->'nativeCancellation'->>'dispatchState' = 'acknowledged'
        AND ("heartbeat_runs"."result_json"->'workspaceRestoreRecovery'->>'schema' = 'nexus.workspace-restore-recovery.v1'
          AND "heartbeat_runs"."result_json"->>'workspaceRestoreFailure' IN ('restore_permission_denied', 'restore_lock_timeout', 'restore_unsafe_archive', 'restore_invalid_metadata', 'restore_failed')) IS NOT TRUE;--> statement-breakpoint
CREATE INDEX "heartbeat_runs_retained_recovery_adoption_idx" ON "heartbeat_runs" USING btree ("id") WHERE "heartbeat_runs"."result_json"->'workspaceRestoreRecovery'->>'schema' = 'nexus.workspace-restore-recovery.v1'
        and not (coalesce("heartbeat_runs"."result_json", '{}'::jsonb) ? 'systemRecoveryAdoption')
        and "heartbeat_runs"."status" in ('failed', 'interrupted', 'timed_out', 'cancelled', 'succeeded');--> statement-breakpoint
CREATE INDEX "issue_recovery_actions_system_recovery_adoption_idx" ON "issue_recovery_actions" USING btree ("id") WHERE not ("issue_recovery_actions"."evidence" ? 'systemRecovery') and (
        "issue_recovery_actions"."evidence"->'workspaceRestoreRecovery'->>'schema' = 'nexus.workspace-restore-recovery.v1'
        or "issue_recovery_actions"."cause" in ('native_workspace_sync_out_unrecoverable', 'native_workspace_sync_out_retry_exhausted')
      );--> statement-breakpoint
CREATE INDEX "issue_recovery_actions_retained_workspace_recovery_idx" ON "issue_recovery_actions" USING btree ("id") WHERE 
      ("issue_recovery_actions"."evidence"->'workspaceRestoreRecovery'->>'schema' = 'nexus.workspace-restore-recovery.v1'
        or "issue_recovery_actions"."cause" in ('native_workspace_sync_out_unrecoverable', 'native_workspace_sync_out_retry_exhausted'))
      and ("issue_recovery_actions"."evidence"->'executionReconciliation' is null
        or "issue_recovery_actions"."evidence"#>>'{workspaceRecovery,status}' = 'recovered')
    ;--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_credential_source_check" CHECK ("tool_connections"."credential_source" in ('nexus_vault', 'vercel_connect'));--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_credential_source_one_of_check" CHECK ((
      ("tool_connections"."credential_source" = 'nexus_vault' and "tool_connections"."external_credential" is null)
      or
      ("tool_connections"."credential_source" = 'vercel_connect' and "tool_connections"."external_credential" is not null and jsonb_array_length("tool_connections"."credential_refs") = 0 and jsonb_array_length("tool_connections"."credential_secret_refs") = 0)
    ));
