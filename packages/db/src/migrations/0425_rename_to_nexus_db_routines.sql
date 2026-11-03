-- Nexus rename: SQL routines, triggers and the built-in agent marker index live only in raw
-- migration SQL, so drizzle-kit cannot diff them. Recreate each under its Nexus name with the
-- same renamed literals the application code now reads and writes, then drop the old objects.
SET check_function_bodies = false;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.nexus_agent_runtime_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO resource_lifecycle_events(company_id, resource_type, resource_id, action)
      VALUES (OLD.company_id, 'agent_runtime', OLD.id, 'delete');
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND
    jsonb_build_array(OLD.name, OLD.role, OLD.title, OLD.capabilities, OLD.reports_to, OLD.adapter_type, OLD.adapter_config, OLD.runtime_config, OLD.default_environment_id, OLD.permissions, OLD.metadata, OLD.lifecycle_required_plugin_ids)
    IS NOT DISTINCT FROM
    jsonb_build_array(NEW.name, NEW.role, NEW.title, NEW.capabilities, NEW.reports_to, NEW.adapter_type, NEW.adapter_config, NEW.runtime_config, NEW.default_environment_id, NEW.permissions, NEW.metadata, NEW.lifecycle_required_plugin_ids)
    AND NOT (OLD.status = 'pending_approval' AND NEW.status <> 'pending_approval')
    AND NOT (NEW.lifecycle_state = 'ready' AND OLD.lifecycle_state <> 'ready') THEN
    RETURN NEW;
  END IF;
  PERFORM nexus_record_agent_runtime(NEW.company_id, NEW.id);
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.nexus_agent_runtime_files_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE revision bigint;
BEGIN
  IF NEW.entity_type = 'agent' AND NEW.action IN ('agent.files_updated', 'agent.instructions_path_updated',
    'agent.instructions_bundle_updated', 'agent.instructions_file_updated', 'agent.instructions_file_deleted', 'plugin.managed_agent.reset') THEN
    revision := nexus_record_agent_runtime(NEW.company_id, NEW.entity_id::uuid);
    NEW.details := coalesce(NEW.details, '{}'::jsonb) || jsonb_build_object('agentRuntimeRevision', revision::text);
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.nexus_agent_selects_runtime_skill(config jsonb, adapter text, skill_key text, skill_slug text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT (adapter <> 'nexus_runner' AND skill_key IN
    ('paperclipai/paperclip/nexus', 'paperclipai/paperclip/complain', 'paperclipai/paperclip/suggestion-box')) OR
    EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(config#>'{nexusSkillSync,desiredSkills}') = 'array'
      THEN config#>'{nexusSkillSync,desiredSkills}' ELSE '[]'::jsonb END) choice
      WHERE lower(trim(CASE WHEN jsonb_typeof(choice) = 'string' THEN choice#>>'{}' ELSE choice->>'key' END)) = ANY(ARRAY[
        lower(skill_key), lower(regexp_replace(skill_key, '.*/', '')),
        lower(CASE WHEN skill_key LIKE 'paperclipai/paperclip/%' THEN skill_slug
          ELSE skill_slug || '--' || left(encode(sha256(convert_to(skill_key, 'UTF8')), 'hex'), 10) END)]));
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.nexus_bump_issue_assignment_version()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
	IF NEW."assignee_agent_id" IS DISTINCT FROM OLD."assignee_agent_id"
		OR NEW."assignee_user_id" IS DISTINCT FROM OLD."assignee_user_id" THEN
		NEW."status_version" := OLD."status_version" + 1;
	END IF;
	RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.nexus_bump_issue_status_version()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
	IF NEW."status" IS DISTINCT FROM OLD."status" THEN
		NEW."status_version" := OLD."status_version" + 1;
	END IF;
	RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.nexus_company_agent_runtimes_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE column_name text; changed boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' AND TG_NARGS > 0 THEN
    FOREACH column_name IN ARRAY TG_ARGV LOOP
      IF to_jsonb(OLD)->column_name IS DISTINCT FROM to_jsonb(NEW)->column_name THEN changed := true; END IF;
    END LOOP;
    IF NOT changed THEN RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(OLD) - ARRAY['updated_at', 'created_at']) IS NOT DISTINCT FROM
    (to_jsonb(NEW) - ARRAY['updated_at', 'created_at']) THEN RETURN NEW; END IF;
  IF TG_OP <> 'INSERT' THEN PERFORM nexus_invalidate_company_agent_runtimes(OLD.company_id); END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.company_id IS DISTINCT FROM OLD.company_id) THEN
    PERFORM nexus_invalidate_company_agent_runtimes(NEW.company_id);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.nexus_connector_flags_runtime_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE company uuid; previous jsonb := coalesce(to_jsonb(OLD)->'experimental', '{}'::jsonb);
  current jsonb := coalesce(to_jsonb(NEW)->'experimental', '{}'::jsonb);
BEGIN
  IF jsonb_build_array(coalesce(previous->'enablePublicMcp', 'false'::jsonb), coalesce(previous->'enableChatConnectors', 'false'::jsonb))
    IS DISTINCT FROM jsonb_build_array(coalesce(current->'enablePublicMcp', 'false'::jsonb), coalesce(current->'enableChatConnectors', 'false'::jsonb)) THEN
    FOR company IN SELECT DISTINCT company_id FROM agents ORDER BY company_id LOOP
      PERFORM nexus_invalidate_connector_company(company);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.nexus_connector_policy_targets(p_company uuid, selectors jsonb)
 RETURNS TABLE(target_type text, target_id text)
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE single_agent text := CASE WHEN jsonb_typeof(selectors->'agentId') = 'string' THEN nullif(selectors->>'agentId', '') END;
  many_agents text[];
  trim_pattern text := '[\x09-\x0d ]|' || convert_from(decode('c2a07ce19a807ce280807ce280817ce280827ce280837ce280847ce280857ce280867ce280877ce280887ce280897ce2808a7ce280a87ce280a97ce280af7ce2819f7ce380807cefbbbf', 'hex'), 'UTF8');
BEGIN
  SELECT array_agg(value#>>'{}') INTO many_agents
    FROM jsonb_array_elements(CASE jsonb_typeof(selectors->'agentIds')
      WHEN 'array' THEN selectors->'agentIds'
      WHEN 'string' THEN jsonb_build_array(regexp_replace(selectors->>'agentIds', '^(' || trim_pattern || ')+|(' || trim_pattern || ')+$', '', 'g')) ELSE '[]'::jsonb END) value
    WHERE jsonb_typeof(value) = 'string' AND regexp_replace(value#>>'{}', '^(' || trim_pattern || ')+|(' || trim_pattern || ')+$', '', 'g') <> '';
  IF single_agent IS NOT NULL THEN
    IF coalesce(cardinality(many_agents), 0) = 0 OR single_agent = ANY(many_agents) THEN
      RETURN QUERY SELECT 'agent'::text, single_agent;
    END IF;
  ELSIF coalesce(cardinality(many_agents), 0) > 0 THEN
    RETURN QUERY SELECT 'agent'::text, unnest(many_agents);
  ELSE
    RETURN QUERY SELECT 'company'::text, p_company::text;
  END IF;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.nexus_connector_runtime_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE company uuid; query text; target record; binding record; candidate uuid;
  old_projection text := '(to_jsonb(o) - $1)'; new_projection text := '(to_jsonb(n) - $1)';
  ignored text[] := ARRAY['updated_at', 'created_at', 'last_used_at', 'last_resolved_at', 'last_health_at',
    'health_status', 'health_checked_at', 'health_message', 'last_catalog_refresh_at', 'last_seen_at', 'last_error', 'last_event_at', 'last_publication_at',
    'last_sync_at', 'sync_checkpoint', 'activation_at', 'lease_token', 'lease_expires_at'];
BEGIN
  IF TG_TABLE_NAME = 'tool_profiles' AND TG_OP = 'INSERT' THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME = 'connection_grant_delegations' THEN
    IF TG_OP = 'INSERT' THEN query := 'SELECT DISTINCT company_id, agent_id FROM new_rows ORDER BY company_id, agent_id';
    ELSIF TG_OP = 'DELETE' THEN query := 'SELECT DISTINCT company_id, agent_id FROM old_rows ORDER BY company_id, agent_id';
    ELSE query := 'WITH changed AS (
      SELECT to_jsonb(o) AS previous, to_jsonb(n) AS current FROM old_rows o FULL JOIN new_rows n ON o.id = n.id
      WHERE (to_jsonb(o) - $1) IS DISTINCT FROM (to_jsonb(n) - $1)), targets AS (
      SELECT previous AS target FROM changed UNION SELECT current FROM changed)
      SELECT DISTINCT (target->>''company_id'')::uuid AS company_id, (target->>''agent_id'')::uuid AS agent_id
      FROM targets WHERE target IS NOT NULL ORDER BY company_id, agent_id';
    END IF;
    FOR binding IN EXECUTE query USING ignored LOOP
      PERFORM nexus_invalidate_connector_agent(binding.company_id, binding.agent_id);
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'company_secret_bindings' THEN
    IF TG_OP = 'INSERT' THEN query := 'SELECT DISTINCT company_id, target_type, target_id FROM new_rows ORDER BY company_id, target_id';
    ELSIF TG_OP = 'DELETE' THEN query := 'SELECT DISTINCT company_id, target_type, target_id FROM old_rows ORDER BY company_id, target_id';
    ELSE query := 'WITH changed AS (
      SELECT to_jsonb(o) AS previous, to_jsonb(n) AS current FROM old_rows o FULL JOIN new_rows n ON o.id = n.id
      WHERE (to_jsonb(o) - $1) IS DISTINCT FROM (to_jsonb(n) - $1)), targets AS (
      SELECT previous AS target FROM changed UNION SELECT current FROM changed)
      SELECT DISTINCT (target->>''company_id'')::uuid AS company_id, target->>''target_type'' AS target_type, target->>''target_id'' AS target_id
      FROM targets WHERE target IS NOT NULL ORDER BY company_id, target_id';
    END IF;
    FOR binding IN EXECUTE query USING ignored LOOP
      IF binding.target_type = 'agent' THEN
        SELECT id INTO candidate FROM agents WHERE company_id = binding.company_id AND id::text = binding.target_id;
        IF FOUND THEN PERFORM nexus_record_agent_runtime(binding.company_id, candidate); END IF;
      ELSE PERFORM nexus_invalidate_connector_company(binding.company_id);
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'connection_grants' THEN
    old_projection := old_projection || ' #- ''{provider_tenant,oauth,refreshLease}'' #- ''{external_credential,lastVerifiedAt}'' #- ''{provider_tenant,github,lastWebhookAt}'' #- ''{provider_tenant,github,webhookHealth}''';
    new_projection := new_projection || ' #- ''{provider_tenant,oauth,refreshLease}'' #- ''{external_credential,lastVerifiedAt}'' #- ''{provider_tenant,github,lastWebhookAt}'' #- ''{provider_tenant,github,webhookHealth}''';
  END IF;
  IF TG_TABLE_NAME = 'tool_policies' THEN
    old_projection := old_projection || ' #- ''{config,trustRule,hitCount}'' #- ''{config,trustRule,lastHitAt}''';
    new_projection := new_projection || ' #- ''{config,trustRule,hitCount}'' #- ''{config,trustRule,lastHitAt}''';
  END IF;
  IF TG_TABLE_NAME IN ('tool_profile_bindings', 'tool_connection_installs', 'tool_profile_entries', 'tool_policies') THEN
    IF TG_TABLE_NAME IN ('tool_profile_entries', 'tool_policies') THEN
      IF TG_OP = 'INSERT' THEN query := 'SELECT to_jsonb(n) AS row_data FROM new_rows n';
      ELSIF TG_OP = 'DELETE' THEN query := 'SELECT to_jsonb(o) AS row_data FROM old_rows o';
      ELSE query := format('WITH changed AS (
        SELECT to_jsonb(o) AS previous, to_jsonb(n) AS current FROM old_rows o FULL JOIN new_rows n ON o.%I = n.%I
        WHERE %s IS DISTINCT FROM %s)
        SELECT previous AS row_data FROM changed WHERE previous IS NOT NULL UNION
        SELECT current AS row_data FROM changed WHERE current IS NOT NULL', TG_ARGV[0], TG_ARGV[0], old_projection, new_projection);
      END IF;
      IF TG_TABLE_NAME = 'tool_profile_entries' THEN
        query := 'SELECT b.company_id, b.target_type, b.target_id FROM (' || query || ') changed
          JOIN tool_profile_bindings b ON b.company_id = (row_data->>''company_id'')::uuid
          AND b.profile_id = (row_data->>''profile_id'')::uuid';
      ELSE
        query := 'SELECT (row_data->>''company_id'')::uuid AS company_id, t.target_type, t.target_id
          FROM (' || query || ') changed CROSS JOIN LATERAL
          nexus_connector_policy_targets((row_data->>''company_id'')::uuid, row_data->''selectors'') t';
      END IF;
    ELSIF TG_OP = 'INSERT' THEN query := 'SELECT company_id, target_type, target_id FROM new_rows';
    ELSIF TG_OP = 'DELETE' THEN query := 'SELECT company_id, target_type, target_id FROM old_rows';
    ELSE query := format('WITH changed AS (
      SELECT o.company_id AS old_company, o.target_type AS old_type, o.target_id AS old_target,
        n.company_id AS new_company, n.target_type AS new_type, n.target_id AS new_target
      FROM old_rows o FULL JOIN new_rows n ON o.%I = n.%I WHERE %s IS DISTINCT FROM %s)
      SELECT old_company AS company_id, old_type AS target_type, old_target AS target_id FROM changed WHERE old_company IS NOT NULL UNION
      SELECT new_company AS company_id, new_type AS target_type, new_target AS target_id FROM changed WHERE new_company IS NOT NULL',
      TG_ARGV[0], TG_ARGV[0], old_projection, new_projection);
    END IF;
    FOR target IN EXECUTE 'SELECT DISTINCT company_id, target_type, target_id FROM (' || query || ') targets
      WHERE target_type IN (''agent'', ''company'')
      ORDER BY company_id, target_type DESC, target_id' USING ignored LOOP
      IF target.target_type = 'company' AND target.target_id = target.company_id::text THEN
        PERFORM nexus_invalidate_connector_company(target.company_id);
      ELSIF target.target_type = 'agent' AND target.target_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
        SELECT id INTO candidate FROM agents WHERE company_id = target.company_id AND id = target.target_id::uuid;
        IF FOUND THEN PERFORM nexus_invalidate_connector_agent(target.company_id, candidate); END IF;
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN query := 'SELECT DISTINCT company_id FROM new_rows ORDER BY company_id';
  ELSIF TG_OP = 'DELETE' THEN query := 'SELECT DISTINCT company_id FROM old_rows ORDER BY company_id';
  ELSE query := format('WITH changed AS (
    SELECT o.company_id AS old_company, n.company_id AS new_company FROM old_rows o FULL JOIN new_rows n ON o.%I = n.%I
    WHERE %s IS DISTINCT FROM %s)
    SELECT old_company AS company_id FROM changed WHERE old_company IS NOT NULL UNION
    SELECT new_company AS company_id FROM changed WHERE new_company IS NOT NULL ORDER BY company_id', TG_ARGV[0], TG_ARGV[0], old_projection, new_projection);
  END IF;
  FOR company IN EXECUTE query USING ignored LOOP
    PERFORM nexus_invalidate_connector_company(company);
  END LOOP;
  RETURN NULL;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.nexus_connector_secret_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE secret uuid; company uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND jsonb_build_array(OLD.status, OLD.latest_version, OLD.deleted_at, OLD.external_ref, OLD.provider_config_id, OLD.provider_metadata)
    IS NOT DISTINCT FROM jsonb_build_array(NEW.status, NEW.latest_version, NEW.deleted_at, NEW.external_ref, NEW.provider_config_id, NEW.provider_metadata) THEN RETURN NEW; END IF;
  IF TG_OP = 'DELETE' THEN secret := OLD.id; company := OLD.company_id;
  ELSE secret := NEW.id; company := NEW.company_id; END IF;
  IF nexus_connector_uses_secret(company, secret) THEN
    PERFORM nexus_invalidate_connector_company(company);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.nexus_connector_uses_secret(p_company uuid, p_secret uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM tool_connections WHERE company_id = p_company AND (
      credential_refs @> jsonb_build_array(jsonb_build_object('secretId', p_secret::text)) OR
      credential_secret_refs @> jsonb_build_array(jsonb_build_object('secretId', p_secret::text)))) OR
    EXISTS (SELECT 1 FROM connection_grants WHERE company_id = p_company AND
      credential_secret_refs @> jsonb_build_array(jsonb_build_object('secretId', p_secret::text)));
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.nexus_connector_vault_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE vault uuid; company uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND jsonb_build_array(OLD.provider, OLD.status, OLD.config, OLD.is_default, OLD.disabled_at)
    IS NOT DISTINCT FROM jsonb_build_array(NEW.provider, NEW.status, NEW.config, NEW.is_default, NEW.disabled_at) THEN RETURN NEW; END IF;
  IF TG_OP = 'DELETE' THEN vault := OLD.id; ELSE vault := NEW.id; END IF;
  FOR company IN SELECT DISTINCT s.company_id FROM company_secrets s WHERE s.provider_config_id = vault
    AND nexus_connector_uses_secret(s.company_id, s.id) ORDER BY s.company_id LOOP
    PERFORM nexus_invalidate_connector_company(company);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.nexus_environment_runtimes_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE previous jsonb; current jsonb; candidate record;
BEGIN
  IF TG_OP <> 'INSERT' THEN previous := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN current := to_jsonb(NEW); END IF;
  IF TG_TABLE_NAME = 'plugin_company_settings' THEN
    IF coalesce((previous->>'enabled')::boolean, true) IS NOT DISTINCT FROM coalesce((current->>'enabled')::boolean, true) THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'UPDATE' AND (CASE TG_TABLE_NAME
    WHEN 'environments' THEN previous->'config' IS NOT DISTINCT FROM current->'config' AND previous->'driver' IS NOT DISTINCT FROM current->'driver'
    WHEN 'plugins' THEN previous->'manifest_json' IS NOT DISTINCT FROM current->'manifest_json' AND previous->'status' IS NOT DISTINCT FROM current->'status'
    ELSE previous->'default_environment_id' IS NOT DISTINCT FROM current->'default_environment_id' END) THEN RETURN NEW; END IF;
  FOR candidate IN SELECT a.id, a.company_id FROM agents a
    WHERE a.status NOT IN ('pending_approval', 'terminated') AND (CASE TG_TABLE_NAME
      WHEN 'environments' THEN coalesce(a.default_environment_id, (SELECT default_environment_id FROM instance_settings LIMIT 1))
        = coalesce((current->>'id')::uuid, (previous->>'id')::uuid)
      WHEN 'plugins' THEN EXISTS (SELECT 1 FROM environments e
        WHERE e.id = coalesce(a.default_environment_id, (SELECT default_environment_id FROM instance_settings LIMIT 1))
          AND e.driver = 'plugin' AND e.config->>'pluginKey' = coalesce(current->>'plugin_key', previous->>'plugin_key'))
      WHEN 'plugin_company_settings' THEN a.company_id = coalesce((current->>'company_id')::uuid, (previous->>'company_id')::uuid)
        AND EXISTS (SELECT 1 FROM environments e JOIN plugins p ON p.plugin_key = e.config->>'pluginKey'
          WHERE e.id = coalesce(a.default_environment_id, (SELECT default_environment_id FROM instance_settings LIMIT 1))
            AND e.driver = 'plugin' AND p.id = coalesce((current->>'plugin_id')::uuid, (previous->>'plugin_id')::uuid))
      ELSE a.default_environment_id IS NULL END)
    ORDER BY a.company_id, a.id FOR NO KEY UPDATE OF a LOOP
    PERFORM nexus_record_agent_runtime(candidate.company_id, candidate.id);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.nexus_environment_selects_runtime_skill(p_company uuid, p_environment uuid, p_skill uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM environments e
    JOIN plugins p ON p.plugin_key = e.config->>'pluginKey'
    JOIN plugin_managed_resources r ON r.plugin_id = p.id AND r.company_id = p_company
      AND r.resource_kind = 'skill' AND r.resource_id = p_skill
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(p.manifest_json->'environmentDrivers', '[]'::jsonb)) AS declared_driver(value)
    WHERE e.id = coalesce(p_environment, (SELECT default_environment_id FROM instance_settings LIMIT 1))
      AND e.driver = 'plugin' AND declared_driver.value->>'driverKey' = e.config->>'driverKey'
      AND coalesce(declared_driver.value->'skillKeys', '[]'::jsonb) ? r.resource_key);
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.nexus_invalidate_company_agent_runtimes(p_company uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE candidate uuid;
BEGIN
  FOR candidate IN SELECT id FROM agents WHERE company_id = p_company
    AND status NOT IN ('pending_approval', 'terminated') ORDER BY id FOR NO KEY UPDATE LOOP
    PERFORM nexus_record_agent_runtime(p_company, candidate);
  END LOOP;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.nexus_invalidate_connector_agent(p_company uuid, p_agent uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE setting text := 'nexus.runtime_agent_' || replace(p_agent::text, '-', '_'); xid text := pg_current_xact_id()::text;
BEGIN
  IF current_setting('nexus.runtime_' || replace(p_company::text, '-', '_'), true) IS NOT DISTINCT FROM xid
    OR current_setting(setting, true) IS NOT DISTINCT FROM xid THEN RETURN; END IF;
  PERFORM nexus_record_agent_runtime(p_company, p_agent);
  PERFORM set_config(setting, xid, true);
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.nexus_invalidate_connector_company(p_company uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE setting text := 'nexus.runtime_' || replace(p_company::text, '-', '_'); xid text := pg_current_xact_id()::text; candidate uuid;
BEGIN
  IF current_setting(setting, true) IS NOT DISTINCT FROM xid THEN RETURN; END IF;
  FOR candidate IN SELECT id FROM agents WHERE company_id = p_company
    AND status NOT IN ('pending_approval', 'terminated') ORDER BY id FOR NO KEY UPDATE LOOP
    PERFORM nexus_invalidate_connector_agent(p_company, candidate);
  END LOOP;
  PERFORM set_config(setting, xid, true);
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.nexus_invalidate_skill_source_runtimes(p_company uuid, sources uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE candidate uuid;
BEGIN
  FOR candidate IN SELECT a.id FROM agents a WHERE a.company_id = p_company
    AND a.status NOT IN ('pending_approval', 'terminated') AND EXISTS (
      SELECT 1 FROM company_skills s WHERE s.company_id = p_company AND s.access_source_id = ANY(sources)
        AND (nexus_agent_selects_runtime_skill(a.adapter_config, a.adapter_type, s.key, s.slug)
          OR nexus_environment_selects_runtime_skill(p_company, a.default_environment_id, s.id)))
    ORDER BY a.id FOR NO KEY UPDATE LOOP
    PERFORM nexus_record_agent_runtime(p_company, candidate);
  END LOOP;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.nexus_keep_operation_privacy_sources()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE issue_sources jsonb := '{}'::jsonb; run_sources jsonb := '{}'::jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    issue_sources := COALESCE(OLD.metadata->'_issuePrivacySources', '{}'::jsonb);
    run_sources := COALESCE(OLD.metadata->'_runPrivacySources', '{}'::jsonb);
    IF OLD.issue_id IS NOT NULL THEN issue_sources := issue_sources || jsonb_build_object(OLD.issue_id::text, true); END IF;
    IF OLD.heartbeat_run_id IS NOT NULL THEN run_sources := run_sources || jsonb_build_object(OLD.heartbeat_run_id::text, true); END IF;
  END IF;
  IF NEW.issue_id IS NOT NULL THEN issue_sources := issue_sources || jsonb_build_object(NEW.issue_id::text, true); END IF;
  IF NEW.heartbeat_run_id IS NOT NULL THEN run_sources := run_sources || jsonb_build_object(NEW.heartbeat_run_id::text, true); END IF;
  NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb) || jsonb_build_object('_issuePrivacySources', issue_sources, '_runPrivacySources', run_sources);
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.nexus_notify_plugin_lifecycle()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM pg_notify('nexus_plugin_lifecycle', '');
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.nexus_queue_skill_package_deletion()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.storage IS NOT NULL AND (TG_OP = 'DELETE' OR OLD.storage->>'archiveKey' IS DISTINCT FROM NEW.storage->>'archiveKey') THEN
    INSERT INTO skill_package_deletions(company_id, provider, archive_key, manifest_key, delete_after)
    VALUES (OLD.company_id, OLD.storage->>'provider', OLD.storage->>'archiveKey', OLD.storage->>'manifestKey', now() + interval '30 days');
  END IF;
  IF OLD.upload IS NOT NULL AND (TG_OP = 'DELETE' OR (
    OLD.upload->>'token' IS DISTINCT FROM NEW.upload->>'token'
    AND OLD.upload->>'archiveKey' IS DISTINCT FROM NEW.storage->>'archiveKey'
  )) THEN
    INSERT INTO skill_package_deletions(company_id, provider, archive_key, manifest_key, delete_after)
    VALUES (OLD.company_id, OLD.upload->>'provider', OLD.upload->>'archiveKey', OLD.upload->>'manifestKey',
      greatest(now() + interval '1 hour', (OLD.upload->>'expiresAt')::timestamptz));
  END IF;
  RETURN NULL;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.nexus_record_agent_runtime(p_company uuid, p_agent uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE revision bigint;
BEGIN
  PERFORM 1 FROM agents WHERE company_id = p_company AND id = p_agent
    AND status NOT IN ('pending_approval', 'terminated') FOR NO KEY UPDATE;
  IF FOUND THEN
    INSERT INTO resource_lifecycle_events(company_id, resource_type, resource_id, action)
      VALUES (p_company, 'agent_runtime', p_agent, 'update') RETURNING id INTO revision;
  END IF;
  RETURN revision;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.nexus_restore_point_tree_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE starts uuid[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    starts := ARRAY[OLD.parent_id];
  ELSE
    starts := ARRAY[NEW.id, OLD.parent_id, NEW.parent_id];
  END IF;
  UPDATE execution_workspace_restore_points
  SET delete_after = CASE WHEN delete_after IS NULL OR delete_after > now() THEN now() ELSE delete_after END,
    review_generation = review_generation + 1,
    updated_at = now()
  WHERE status = 'active'
    AND source_issue_id IN (
      WITH RECURSIVE ancestors(id, parent_id, depth) AS (
        SELECT i.id, i.parent_id, 0 FROM issues i WHERE i.id = ANY(starts)
        UNION
        SELECT parent.id, parent.parent_id, ancestors.depth + 1 FROM issues parent
        JOIN ancestors ON parent.id = ancestors.parent_id WHERE ancestors.depth < 64
      )
      SELECT id FROM ancestors
    );
  RETURN NULL;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.nexus_schedule_skill_package_cleanup()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE version_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'company_skills' THEN
    version_id := OLD.current_version_id;
    IF version_id IS NOT NULL AND (TG_OP = 'DELETE' OR version_id IS DISTINCT FROM NEW.current_version_id) THEN
      UPDATE company_skill_repository_snapshots SET maintenance_at = now() + interval '30 days'
        WHERE id IN (SELECT repository_snapshot_id FROM company_skill_versions WHERE id = version_id
                     UNION SELECT package_snapshot_id FROM company_skill_versions WHERE id = version_id);
    END IF;
  ELSE
    UPDATE company_skill_repository_snapshots SET maintenance_at = now() + interval '1 day'
      WHERE id = OLD.repository_snapshot_id OR id = OLD.package_snapshot_id;
  END IF;
  RETURN NULL;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.nexus_skill_access_runtime_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE previous jsonb; current jsonb; column_name text; changed boolean := false; company uuid; sources uuid[];
BEGIN
  IF TG_OP <> 'INSERT' THEN previous := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN current := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' THEN
    FOREACH column_name IN ARRAY TG_ARGV LOOP
      IF previous->column_name IS DISTINCT FROM current->column_name THEN changed := true; END IF;
    END LOOP;
    IF TG_NARGS > 0 AND NOT changed THEN RETURN NEW; END IF;
    IF (previous - ARRAY['updated_at', 'created_at']) IS NOT DISTINCT FROM
      (current - ARRAY['updated_at', 'created_at']) THEN RETURN NEW; END IF;
  END IF;
  company := coalesce((current->>'company_id')::uuid, (previous->>'company_id')::uuid);
  IF TG_TABLE_NAME = 'company_skill_sources' THEN
    sources := ARRAY[(previous->>'id')::uuid, (current->>'id')::uuid];
  ELSIF TG_TABLE_NAME = 'project_skill_sources' THEN
    sources := ARRAY[(previous->>'source_id')::uuid, (current->>'source_id')::uuid];
  ELSE
    SELECT array_agg(DISTINCT source_id) INTO sources FROM project_skill_sources WHERE company_id = company
      AND project_id = ANY(CASE WHEN TG_TABLE_NAME = 'projects'
        THEN ARRAY[(previous->>'id')::uuid, (current->>'id')::uuid]
        ELSE ARRAY[(previous->>'project_id')::uuid, (current->>'project_id')::uuid] END);
  END IF;
  PERFORM nexus_invalidate_skill_source_runtimes(company, sources);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.nexus_skill_pins_runtime_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE company uuid;
BEGIN
  IF coalesce(OLD.experimental->'enableBetaSkills', 'false'::jsonb) IS DISTINCT FROM coalesce(NEW.experimental->'enableBetaSkills', 'false'::jsonb) THEN
    FOR company IN SELECT DISTINCT company_id FROM agents ORDER BY company_id LOOP
      PERFORM nexus_invalidate_company_agent_runtimes(company);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.nexus_skill_runtime_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE previous jsonb; current jsonb; keys text[]; company uuid; candidate uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN previous := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN current := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' AND
    jsonb_build_array(OLD.key, OLD.slug, OLD.markdown, OLD.source_type, OLD.source_locator, OLD.source_ref,
      OLD.file_inventory, OLD.current_version_id, OLD.access_source_id, OLD.compatibility, OLD.trust_level, OLD.metadata)
    IS NOT DISTINCT FROM
    jsonb_build_array(NEW.key, NEW.slug, NEW.markdown, NEW.source_type, NEW.source_locator, NEW.source_ref,
      NEW.file_inventory, NEW.current_version_id, NEW.access_source_id, NEW.compatibility, NEW.trust_level, NEW.metadata)
    THEN RETURN NEW; END IF;
  company := coalesce((current->>'company_id')::uuid, (previous->>'company_id')::uuid);
  SELECT array_agg(DISTINCT lower(reference)) INTO keys FROM (
    SELECT row->>'key' AS reference FROM unnest(ARRAY[previous, current]) row
    UNION ALL SELECT regexp_replace(row->>'key', '.*/', '') FROM unnest(ARRAY[previous, current]) row
    UNION ALL SELECT CASE WHEN row->>'key' LIKE 'paperclipai/paperclip/%' THEN row->>'slug'
      ELSE (row->>'slug') || '--' || left(encode(sha256(convert_to(row->>'key', 'UTF8')), 'hex'), 10) END
      FROM unnest(ARRAY[previous, current]) row
  ) refs WHERE reference IS NOT NULL;
  FOR candidate IN SELECT a.id FROM agents a WHERE a.company_id = company
    AND a.status NOT IN ('pending_approval', 'terminated') AND (
      (a.adapter_type <> 'nexus_runner' AND keys && ARRAY['paperclipai/paperclip/nexus', 'paperclipai/paperclip/complain', 'paperclipai/paperclip/suggestion-box']) OR
      EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.adapter_config#>'{nexusSkillSync,desiredSkills}') = 'array'
        THEN a.adapter_config#>'{nexusSkillSync,desiredSkills}' ELSE '[]'::jsonb END) choice
        WHERE lower(trim(CASE WHEN jsonb_typeof(choice) = 'string' THEN choice#>>'{}' ELSE choice->>'key' END)) = ANY(keys))
      OR nexus_environment_selects_runtime_skill(company, a.default_environment_id, coalesce((current->>'id')::uuid, (previous->>'id')::uuid)))
    ORDER BY a.id FOR NO KEY UPDATE LOOP
    PERFORM nexus_record_agent_runtime(company, candidate);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_agent_runtime_files_changed" ON "public"."activity_log";
--> statement-breakpoint
CREATE TRIGGER nexus_agent_runtime_files_changed BEFORE INSERT ON public.activity_log FOR EACH ROW EXECUTE FUNCTION nexus_agent_runtime_files_changed();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_agent_runtime_changed" ON "public"."agents";
--> statement-breakpoint
CREATE TRIGGER nexus_agent_runtime_changed AFTER INSERT OR DELETE OR UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION nexus_agent_runtime_changed();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_delete" ON "public"."chat_agent_routes";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_delete AFTER DELETE ON public.chat_agent_routes REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_insert" ON "public"."chat_agent_routes";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_insert AFTER INSERT ON public.chat_agent_routes REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_update" ON "public"."chat_agent_routes";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_update AFTER UPDATE ON public.chat_agent_routes REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_delete" ON "public"."chat_endpoint_resources";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_delete AFTER DELETE ON public.chat_endpoint_resources REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_insert" ON "public"."chat_endpoint_resources";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_insert AFTER INSERT ON public.chat_endpoint_resources REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_update" ON "public"."chat_endpoint_resources";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_update AFTER UPDATE ON public.chat_endpoint_resources REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_delete" ON "public"."chat_endpoints";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_delete AFTER DELETE ON public.chat_endpoints REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_insert" ON "public"."chat_endpoints";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_insert AFTER INSERT ON public.chat_endpoints REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_update" ON "public"."chat_endpoints";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_update AFTER UPDATE ON public.chat_endpoints REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_delete" ON "public"."chat_identity_links";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_delete AFTER DELETE ON public.chat_identity_links REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_insert" ON "public"."chat_identity_links";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_insert AFTER INSERT ON public.chat_identity_links REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_update" ON "public"."chat_identity_links";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_update AFTER UPDATE ON public.chat_identity_links REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_delete" ON "public"."chat_voice_callbacks";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_delete AFTER DELETE ON public.chat_voice_callbacks REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_insert" ON "public"."chat_voice_callbacks";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_insert AFTER INSERT ON public.chat_voice_callbacks REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_update" ON "public"."chat_voice_callbacks";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_update AFTER UPDATE ON public.chat_voice_callbacks REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_delete" ON "public"."company_memberships";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_delete AFTER DELETE ON public.company_memberships REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_insert" ON "public"."company_memberships";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_insert AFTER INSERT ON public.company_memberships REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_update" ON "public"."company_memberships";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_update AFTER UPDATE ON public.company_memberships REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_delete" ON "public"."company_secret_bindings";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_delete AFTER DELETE ON public.company_secret_bindings REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_insert" ON "public"."company_secret_bindings";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_insert AFTER INSERT ON public.company_secret_bindings REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_update" ON "public"."company_secret_bindings";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_update AFTER UPDATE ON public.company_secret_bindings REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_vault_changed" ON "public"."company_secret_provider_configs";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_vault_changed AFTER INSERT OR DELETE OR UPDATE ON public.company_secret_provider_configs FOR EACH ROW EXECUTE FUNCTION nexus_connector_vault_changed();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_secret_changed" ON "public"."company_secrets";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_secret_changed AFTER DELETE OR UPDATE ON public.company_secrets FOR EACH ROW EXECUTE FUNCTION nexus_connector_secret_changed();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_skill_policy_runtime_changed" ON "public"."company_skill_policies";
--> statement-breakpoint
CREATE TRIGGER nexus_skill_policy_runtime_changed AFTER INSERT OR DELETE OR UPDATE ON public.company_skill_policies FOR EACH ROW EXECUTE FUNCTION nexus_company_agent_runtimes_changed();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "skill_package_deletion_receipts" ON "public"."company_skill_repository_snapshots";
--> statement-breakpoint
CREATE TRIGGER skill_package_deletion_receipts AFTER DELETE OR UPDATE OF storage, upload ON public.company_skill_repository_snapshots FOR EACH ROW EXECUTE FUNCTION nexus_queue_skill_package_deletion();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_skill_source_access_runtime_changed" ON "public"."company_skill_sources";
--> statement-breakpoint
CREATE TRIGGER nexus_skill_source_access_runtime_changed AFTER INSERT OR DELETE OR UPDATE ON public.company_skill_sources FOR EACH ROW EXECUTE FUNCTION nexus_skill_access_runtime_changed('access_scope', 'removed_at');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "skill_package_version_cleanup" ON "public"."company_skill_versions";
--> statement-breakpoint
CREATE TRIGGER skill_package_version_cleanup AFTER DELETE ON public.company_skill_versions FOR EACH ROW EXECUTE FUNCTION nexus_schedule_skill_package_cleanup();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_skill_runtime_changed" ON "public"."company_skills";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER nexus_skill_runtime_changed AFTER INSERT OR DELETE OR UPDATE ON public.company_skills DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION nexus_skill_runtime_changed();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "skill_package_current_cleanup" ON "public"."company_skills";
--> statement-breakpoint
CREATE TRIGGER skill_package_current_cleanup AFTER DELETE OR UPDATE OF current_version_id ON public.company_skills FOR EACH ROW EXECUTE FUNCTION nexus_schedule_skill_package_cleanup();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_delete" ON "public"."connection_grant_delegations";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_delete AFTER DELETE ON public.connection_grant_delegations REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_insert" ON "public"."connection_grant_delegations";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_insert AFTER INSERT ON public.connection_grant_delegations REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_update" ON "public"."connection_grant_delegations";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_update AFTER UPDATE ON public.connection_grant_delegations REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_delete" ON "public"."connection_grant_members";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_delete AFTER DELETE ON public.connection_grant_members REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_insert" ON "public"."connection_grant_members";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_insert AFTER INSERT ON public.connection_grant_members REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_update" ON "public"."connection_grant_members";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_update AFTER UPDATE ON public.connection_grant_members REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_delete" ON "public"."connection_grants";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_delete AFTER DELETE ON public.connection_grants REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_insert" ON "public"."connection_grants";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_insert AFTER INSERT ON public.connection_grants REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_update" ON "public"."connection_grants";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_update AFTER UPDATE ON public.connection_grants REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_delete" ON "public"."email_endpoints";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_delete AFTER DELETE ON public.email_endpoints REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('endpoint_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_insert" ON "public"."email_endpoints";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_insert AFTER INSERT ON public.email_endpoints REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('endpoint_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_update" ON "public"."email_endpoints";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_update AFTER UPDATE ON public.email_endpoints REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('endpoint_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_environment_runtime_changed" ON "public"."environments";
--> statement-breakpoint
CREATE TRIGGER nexus_environment_runtime_changed AFTER INSERT OR UPDATE ON public.environments FOR EACH ROW EXECUTE FUNCTION nexus_environment_runtimes_changed();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_flags_runtime_changed" ON "public"."instance_settings";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_flags_runtime_changed AFTER INSERT OR DELETE OR UPDATE ON public.instance_settings FOR EACH ROW EXECUTE FUNCTION nexus_connector_flags_runtime_changed();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_default_environment_runtime_changed" ON "public"."instance_settings";
--> statement-breakpoint
CREATE TRIGGER nexus_default_environment_runtime_changed AFTER UPDATE ON public.instance_settings FOR EACH ROW EXECUTE FUNCTION nexus_environment_runtimes_changed();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_skill_pins_runtime_changed" ON "public"."instance_settings";
--> statement-breakpoint
CREATE TRIGGER nexus_skill_pins_runtime_changed AFTER UPDATE ON public.instance_settings FOR EACH ROW EXECUTE FUNCTION nexus_skill_pins_runtime_changed();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_issue_assignment_version_trigger" ON "public"."issues";
--> statement-breakpoint
CREATE TRIGGER nexus_issue_assignment_version_trigger BEFORE UPDATE OF assignee_agent_id, assignee_user_id ON public.issues FOR EACH ROW EXECUTE FUNCTION nexus_bump_issue_assignment_version();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_issue_status_version_trigger" ON "public"."issues";
--> statement-breakpoint
CREATE TRIGGER nexus_issue_status_version_trigger BEFORE UPDATE OF status ON public.issues FOR EACH ROW EXECUTE FUNCTION nexus_bump_issue_status_version();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_restore_point_tree_delete" ON "public"."issues";
--> statement-breakpoint
CREATE TRIGGER nexus_restore_point_tree_delete AFTER DELETE ON public.issues FOR EACH ROW EXECUTE FUNCTION nexus_restore_point_tree_changed();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_restore_point_tree_update" ON "public"."issues";
--> statement-breakpoint
CREATE TRIGGER nexus_restore_point_tree_update AFTER UPDATE OF status, parent_id ON public.issues FOR EACH ROW WHEN (((old.status IS DISTINCT FROM new.status) OR (old.parent_id IS DISTINCT FROM new.parent_id))) EXECUTE FUNCTION nexus_restore_point_tree_changed();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_plugin_company_environment_runtime_changed" ON "public"."plugin_company_settings";
--> statement-breakpoint
CREATE TRIGGER nexus_plugin_company_environment_runtime_changed AFTER INSERT OR DELETE OR UPDATE ON public.plugin_company_settings FOR EACH ROW EXECUTE FUNCTION nexus_environment_runtimes_changed();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_plugin_environment_runtime_changed" ON "public"."plugins";
--> statement-breakpoint
CREATE TRIGGER nexus_plugin_environment_runtime_changed AFTER UPDATE ON public.plugins FOR EACH ROW EXECUTE FUNCTION nexus_environment_runtimes_changed();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_delete" ON "public"."principal_permission_grants";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_delete AFTER DELETE ON public.principal_permission_grants REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_insert" ON "public"."principal_permission_grants";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_insert AFTER INSERT ON public.principal_permission_grants REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_update" ON "public"."principal_permission_grants";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_update AFTER UPDATE ON public.principal_permission_grants REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_project_access_runtime_changed" ON "public"."project_access_members";
--> statement-breakpoint
CREATE TRIGGER nexus_project_access_runtime_changed AFTER INSERT OR DELETE OR UPDATE ON public.project_access_members FOR EACH ROW EXECUTE FUNCTION nexus_skill_access_runtime_changed();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_skill_source_runtime_changed" ON "public"."project_skill_sources";
--> statement-breakpoint
CREATE TRIGGER nexus_skill_source_runtime_changed AFTER INSERT OR DELETE OR UPDATE ON public.project_skill_sources FOR EACH ROW EXECUTE FUNCTION nexus_skill_access_runtime_changed('project_id', 'source_id', 'active');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_project_privacy_runtime_changed" ON "public"."projects";
--> statement-breakpoint
CREATE TRIGGER nexus_project_privacy_runtime_changed AFTER UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION nexus_skill_access_runtime_changed('visibility', 'privacy_owner_user_id', 'personal_owner_user_id', 'execution_workspace_policy');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_notify_plugin_lifecycle" ON "public"."resource_lifecycle_events";
--> statement-breakpoint
CREATE TRIGGER nexus_notify_plugin_lifecycle AFTER INSERT ON public.resource_lifecycle_events FOR EACH ROW WHEN ((new.resource_type = 'agent_runtime'::text)) EXECUTE FUNCTION nexus_notify_plugin_lifecycle();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_delete" ON "public"."tool_applications";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_delete AFTER DELETE ON public.tool_applications REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_insert" ON "public"."tool_applications";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_insert AFTER INSERT ON public.tool_applications REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_update" ON "public"."tool_applications";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_update AFTER UPDATE ON public.tool_applications REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_delete" ON "public"."tool_catalog_entries";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_delete AFTER DELETE ON public.tool_catalog_entries REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_insert" ON "public"."tool_catalog_entries";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_insert AFTER INSERT ON public.tool_catalog_entries REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_update" ON "public"."tool_catalog_entries";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_update AFTER UPDATE ON public.tool_catalog_entries REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_delete" ON "public"."tool_connection_installs";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_delete AFTER DELETE ON public.tool_connection_installs REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_insert" ON "public"."tool_connection_installs";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_insert AFTER INSERT ON public.tool_connection_installs REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_update" ON "public"."tool_connection_installs";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_update AFTER UPDATE ON public.tool_connection_installs REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_delete" ON "public"."tool_connections";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_delete AFTER DELETE ON public.tool_connections REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_insert" ON "public"."tool_connections";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_insert AFTER INSERT ON public.tool_connections REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_update" ON "public"."tool_connections";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_update AFTER UPDATE ON public.tool_connections REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_delete" ON "public"."tool_mcp_gateways";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_delete AFTER DELETE ON public.tool_mcp_gateways REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_insert" ON "public"."tool_mcp_gateways";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_insert AFTER INSERT ON public.tool_mcp_gateways REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_update" ON "public"."tool_mcp_gateways";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_update AFTER UPDATE ON public.tool_mcp_gateways REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_delete" ON "public"."tool_policies";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_delete AFTER DELETE ON public.tool_policies REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_insert" ON "public"."tool_policies";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_insert AFTER INSERT ON public.tool_policies REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_update" ON "public"."tool_policies";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_update AFTER UPDATE ON public.tool_policies REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_delete" ON "public"."tool_profile_bindings";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_delete AFTER DELETE ON public.tool_profile_bindings REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_insert" ON "public"."tool_profile_bindings";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_insert AFTER INSERT ON public.tool_profile_bindings REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_update" ON "public"."tool_profile_bindings";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_update AFTER UPDATE ON public.tool_profile_bindings REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_delete" ON "public"."tool_profile_entries";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_delete AFTER DELETE ON public.tool_profile_entries REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_insert" ON "public"."tool_profile_entries";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_insert AFTER INSERT ON public.tool_profile_entries REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_update" ON "public"."tool_profile_entries";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_update AFTER UPDATE ON public.tool_profile_entries REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_delete" ON "public"."tool_profiles";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_delete AFTER DELETE ON public.tool_profiles REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_insert" ON "public"."tool_profiles";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_insert AFTER INSERT ON public.tool_profiles REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "paperclip_connector_runtime_update" ON "public"."tool_profiles";
--> statement-breakpoint
CREATE TRIGGER nexus_connector_runtime_update AFTER UPDATE ON public.tool_profiles REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION nexus_connector_runtime_changed('id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "workspace_operations_keep_privacy_sources" ON "public"."workspace_operations";
--> statement-breakpoint
CREATE TRIGGER workspace_operations_keep_privacy_sources BEFORE INSERT OR UPDATE ON public.workspace_operations FOR EACH ROW EXECUTE FUNCTION nexus_keep_operation_privacy_sources();
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.paperclip_agent_runtime_changed();
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.paperclip_agent_runtime_files_changed();
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.paperclip_agent_selects_runtime_skill(jsonb,text,text,text);
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.paperclip_bump_issue_assignment_version();
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.paperclip_bump_issue_status_version();
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.paperclip_company_agent_runtimes_changed();
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.paperclip_connector_flags_runtime_changed();
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.paperclip_connector_policy_targets(uuid,jsonb);
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.paperclip_connector_runtime_changed();
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.paperclip_connector_secret_changed();
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.paperclip_connector_uses_secret(uuid,uuid);
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.paperclip_connector_vault_changed();
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.paperclip_environment_runtimes_changed();
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.paperclip_environment_selects_runtime_skill(uuid,uuid,uuid);
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.paperclip_invalidate_company_agent_runtimes(uuid);
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.paperclip_invalidate_connector_agent(uuid,uuid);
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.paperclip_invalidate_connector_company(uuid);
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.paperclip_invalidate_skill_source_runtimes(uuid,uuid[]);
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.paperclip_keep_operation_privacy_sources();
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.paperclip_notify_plugin_lifecycle();
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.paperclip_queue_skill_package_deletion();
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.paperclip_record_agent_runtime(uuid,uuid);
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.paperclip_restore_point_tree_changed();
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.paperclip_schedule_skill_package_cleanup();
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.paperclip_skill_access_runtime_changed();
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.paperclip_skill_pins_runtime_changed();
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.paperclip_skill_runtime_changed();
--> statement-breakpoint
RESET check_function_bodies;
--> statement-breakpoint
DROP INDEX IF EXISTS "public"."agents_company_built_in_agent_key_unique_idx";
--> statement-breakpoint
UPDATE "agents"
  SET "metadata" = ("metadata" - 'paperclipBuiltInAgent') || jsonb_build_object('nexusBuiltInAgent', "metadata" -> 'paperclipBuiltInAgent')
  WHERE "metadata" ? 'paperclipBuiltInAgent';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS agents_company_built_in_agent_key_unique_idx ON public.agents USING btree (company_id, (((metadata -> 'nexusBuiltInAgent'::text) ->> 'key'::text))) WHERE ((((metadata -> 'nexusBuiltInAgent'::text) ->> 'key'::text) IS NOT NULL) AND (status <> 'terminated'::text));
