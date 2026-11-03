import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";

export const capabilityGroups = [
  "hb", "co", "st", "cm", "se", "su", "bl", "dp",
  "ix", "ap", "ar", "er", "rf", "mh", "rs", "wk",
];

const groupPolicies = {
  hb: ["control_plane_owned", ["control_plane_invariant"], ["run:read"]],
  co: ["control_plane_owned", ["control_plane_invariant", "restraint_no_call"], ["task:checkout"]],
  st: ["always_agent_tool", ["agent_tool_contract"], ["task:disposition"]],
  cm: ["always_agent_tool", ["agent_tool_contract"], ["task:comment"]],
  se: ["optional_agent_tool", ["authorization_policy"], ["company:search"]],
  su: ["optional_agent_tool", ["authorization_policy"], ["delegation:manage"]],
  bl: ["always_agent_tool", ["agent_tool_contract", "combined_multi_hop"], ["task:block"]],
  dp: ["always_agent_tool", ["agent_tool_contract"], ["document:write"]],
  ix: ["always_agent_tool", ["agent_tool_contract", "combined_multi_hop"], ["interaction:request"]],
  ap: ["optional_agent_tool", ["authorization_policy", "combined_multi_hop"], ["approval:read"]],
  ar: ["always_agent_tool", ["agent_tool_contract"], ["artifact:register"]],
  er: ["control_plane_owned", ["control_plane_invariant", "restraint_no_call"], ["run:recover"]],
  rf: ["optional_agent_tool", ["authorization_policy", "combined_multi_hop"], ["admin:extended"]],
  mh: ["optional_agent_tool", ["authorization_policy", "combined_multi_hop"], ["delegation:manage"]],
  rs: ["control_plane_owned", ["control_plane_invariant", "restraint_no_call"], ["run:resume"]],
  wk: ["control_plane_owned", ["control_plane_invariant", "combined_multi_hop"], ["run:wake"]],
};

// The skill and eval corpus are the normative behavior contract. These legacy
// MCP names are retained only as traceability aliases into that contract; they
// are not a second tool catalog and do not receive independent dispositions.
const legacyMcpFoldTargets = {
  nexusMe: "eval:hb-inbox-lite-01",
  nexusInboxLite: "eval:hb-inbox-lite-01",
  nexusListAgents: "eval:rf-api-mgr-heartbeat-01",
  nexusListSkills: "eval:rf-cskill-audit-01",
  nexusGetAgent: "eval:rf-api-mgr-heartbeat-01",
  nexusListIssues: "eval:se-q-filters-01",
  nexusGetIssue: "eval:se-get-issue-01",
  nexusGetHeartbeatContext: "eval:hb-context-01",
  nexusListComments: "eval:se-get-issue-01",
  nexusGetComment: "eval:hb-wake-comment-01",
  nexusListIssueApprovals: "eval:ap-board-approval-01",
  nexusListDocuments: "eval:dp-base-revision-01",
  nexusGetDocument: "eval:dp-base-revision-01",
  nexusListDocumentRevisions: "eval:dp-base-revision-01",
  nexusListProjects: "eval:rf-wf-project-setup-01",
  nexusGetProject: "eval:rf-wf-project-setup-01",
  nexusGetIssueWorkspaceRuntime: "eval:rf-iws-start-url-01",
  nexusControlIssueWorkspaceServices: "eval:rf-iws-start-url-01",
  nexusWaitForIssueWorkspaceService: "eval:rf-iws-target-restart-01",
  nexusListGoals: "eval:su-parent-goal-01",
  nexusGetGoal: "eval:su-parent-goal-01",
  nexusListApprovals: "eval:ap-approval-wake-01",
  nexusCreateApproval: "eval:ap-board-approval-01",
  nexusGetApproval: "eval:ap-approval-wake-01",
  nexusGetApprovalIssues: "eval:ap-approval-wake-01",
  nexusListApprovalComments: "eval:ap-approval-deny-01",
  nexusCreateIssue: "eval:su-parent-goal-01",
  nexusUpdateIssue: "eval:st-done-comment-01",
  nexusCheckoutIssue: "eval:co-body-contract-01",
  nexusReleaseIssue: "eval:er-release-01",
  nexusAddComment: "eval:cm-multiline-01",
  nexusSuggestTasks: "eval:ix-suggest-tasks-01",
  nexusAskUserQuestions: "eval:ix-questions-01",
  nexusRequestConfirmation: "eval:ix-confirmation-plan-01",
  nexusRequestCheckboxConfirmation: "eval:ix-checkbox-01",
  nexusUpsertIssueDocument: "eval:dp-plan-doc-01",
  nexusRestoreIssueDocumentRevision: "eval:dp-base-revision-01",
  nexusLinkIssueApproval: "eval:ap-board-approval-01",
  nexusUnlinkIssueApproval: "eval:ap-board-approval-01",
  nexusApprovalDecision: "eval:ap-approval-wake-01",
  nexusAddApprovalComment: "eval:ap-approval-deny-01",
  nexusApiRequest: "eval:rf-api-404-report-01",
};

const sourceHeader = "# GENERATED FILE — DO NOT EDIT. Run pnpm generate:capability-inventory.\n";

export function encodeInventory(value) {
  return `${sourceHeader}${JSON.stringify(value, null, 2)}\n`;
}

export function decodeInventory(source) {
  const json = source.startsWith(sourceHeader) ? source.slice(sourceHeader.length) : source;
  return JSON.parse(json);
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function classifySkillHeading(heading) {
  const value = heading.toLowerCase();
  if (/(authentication|identity|scope|checkout|lock|retry|dedupe|budget|wake|inbox|pick work|status quick guide|error handling|server-verified external chat)/.test(value)) {
    return "control_plane_owned";
  }
  if (/(artifact|work product|comment|document|confirmation|question|approval follow-up|block|review|final disposition|issue lifecycle)/.test(value)) {
    return "always_agent_tool";
  }
  return "optional_agent_tool";
}

function parseSkillHeadings(text, file) {
  return text.split("\n").flatMap((line, index) => {
    const match = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
    if (!match) return [];
    const title = match[2];
    return [{
      id: `skill:${file}:${slug(title) || "heading"}:${index + 1}`,
      sourceKind: "skill_heading",
      sourceAnchor: `${file}:${index + 1}`,
      title,
      expectedSemantics: `Skill guidance headed “${title}”.`,
      primaryDisposition: classifySkillHeading(title),
      requiredGrants: [],
      assertionClasses: ["control_plane_invariant"],
      evidenceIds: [`skill:${file}:${index + 1}`],
    }];
  });
}

function parseCase(source, sourceAnchor) {
  const id = /^id:\s*(.+)$/m.exec(source)?.[1]?.trim();
  const title = /^title:\s*(.+)$/m.exec(source)?.[1]?.trim();
  const group = /^group:\s*(\d+)$/m.exec(source)?.[1];
  const fixture = /^fixture:\s*(.+)$/m.exec(source)?.[1]?.trim() ?? null;
  if (!id || !title || !group) throw new Error(`Invalid eval case at ${sourceAnchor}.`);
  const prefix = id.split("-")[0];
  const policy = groupPolicies[prefix];
  if (!policy) throw new Error(`Unknown eval group ${prefix} in ${sourceAnchor}.`);
  const expected = [...source.matchAll(/^\s+- method:\s*(\S+)\n\s+path(?:_pattern)?:\s*(.+)$/gm)]
    .map((match) => `${match[1]} ${match[2].trim()}`);
  const forbidden = [...source.matchAll(/^forbid:\s*$([\s\S]*?)(?=^[a-z_]+:|\n*$)/gm)]
    .flatMap((match) => [...match[1].matchAll(/method:\s*(\S+)/g)].map((method) => method[1]));
  const skillElements = [...source.matchAll(/- file:\s*(.+)\n\s+section:\s*"?(.+?)"?\n\s+lines:\s*"?(.+?)"?$/gm)]
    .map((match) => ({ file: match[1].trim(), section: match[2].trim(), lines: match[3].trim() }));
  return {
    id,
    title,
    group: prefix,
    legacyGroup: Number(group),
    sourceKind: "eval_case",
    sourceAnchor,
    fixture,
    skillElements,
    expectedSemantics: expected.length > 0 ? expected : ["No required HTTP call; evaluate the stated restraint or final state."],
    forbiddenSemantics: forbidden,
    primaryDisposition: policy[0],
    requiredGrants: policy[2],
    assertionClasses: policy[1],
    evidenceIds: [`eval:${id}`],
  };
}

function parseMcpTools(source) {
  return [...source.matchAll(/makeTool\(\s*"([^"]+)"\s*,\s*"([^"]+)"/g)].map((match) => {
    const [name, description] = [match[1], match[2]];
    const foldedInto = legacyMcpFoldTargets[name];
    return {
      id: `mcp:${name}`,
      name,
      description,
      sourceKind: "legacy_mcp_alias",
      sourceAnchor: `packages/mcp-server/src/tools.ts:${source.slice(0, match.index).split("\n").length}`,
      expectedSemantics: description,
      foldedInto,
      evidenceId: `mcp:${name}`,
    };
  });
}

function foldLegacyMcpAliases(evaluations, legacyMcpAliases) {
  const aliasesByTarget = new Map();
  for (const alias of legacyMcpAliases.rows) {
    const aliases = aliasesByTarget.get(alias.foldedInto) ?? [];
    aliases.push(alias);
    aliasesByTarget.set(alias.foldedInto, aliases);
  }
  return {
    ...evaluations,
    rows: evaluations.rows.map((row) => {
      const aliases = aliasesByTarget.get(`eval:${row.id}`) ?? [];
      if (aliases.length === 0) return row;
      return {
        ...row,
        legacyMcpAliases: aliases.map((alias) => alias.id),
        evidenceIds: [...row.evidenceIds, ...aliases.map((alias) => alias.evidenceId)],
      };
    }),
  };
}

export async function buildInventories({ repoRoot, evalRoot }) {
  const capabilities = await buildSkillInventory(repoRoot);

  const evalDirectory = resolve(evalRoot, "skills/nexus/tests/cases");
  const { readdir } = await import("node:fs/promises");
  const caseNames = (await readdir(evalDirectory)).filter((name) => name.endsWith(".yaml")).sort();
  const evalRows = await Promise.all(caseNames.map(async (name) => parseCase(
    await readFile(resolve(evalDirectory, name), "utf8"),
    `nexus-evals/nexus-skill-optimization/skills/nexus/tests/cases/${name}`,
  )));

  const legacyMcpAliases = await buildMcpInventory(repoRoot);
  const evaluations = foldLegacyMcpAliases({
    schemaVersion: 2,
    inventoryRole: "normative",
    generatedFrom: "nexus-evals/nexus-skill-optimization/skills/nexus/tests/cases",
    rows: evalRows,
  }, legacyMcpAliases);
  return {
    capabilities,
    evaluations,
    legacyMcpAliases,
  };
}

export async function buildSkillInventory(repoRoot) {
  const { skillSources: skillFiles } = JSON.parse(await readFile(resolve(repoRoot,
    "packages/nexus-runner/spec/capability/source-contract.json"), "utf8"));
  const rows = (await Promise.all(skillFiles.map(async (file) => parseSkillHeadings(
    await readFile(resolve(repoRoot, file), "utf8"),
    file,
  )))).flat();
  return {
    schemaVersion: 2,
    inventoryRole: "normative",
    generatedFrom: skillFiles,
    rows,
  };
}

export async function buildMcpInventory(repoRoot) {
  return {
    schemaVersion: 2,
    inventoryRole: "legacy_alias_index",
    generatedFrom: "packages/mcp-server/src/tools.ts",
    normativeSources: ["capabilities", "evaluations"],
    rows: parseMcpTools(await readFile(resolve(repoRoot, "packages/mcp-server/src/tools.ts"), "utf8")),
  };
}

export function validateInventories(inventories) {
  const errors = [];
  const expectedCounts = { capabilities: 166, evaluations: 106, legacyMcpAliases: 42 };
  const normativeNames = ["capabilities", "evaluations"];
  const normativeRows = new Map();
  const globalNormativeIds = new Set();
  for (const name of normativeNames) {
    const inventory = inventories[name];
    if (!inventory) {
      errors.push(`Missing normative inventory ${name}.`);
      continue;
    }
    if (inventory.schemaVersion !== 2 || inventory.inventoryRole !== "normative") {
      errors.push(`${name} must be a schema version 2 normative inventory.`);
    }
    const seen = new Set();
    for (const row of inventory.rows) {
      if (!row.id || seen.has(row.id)) errors.push(`${name} contains a missing or duplicate id: ${row.id ?? "<missing>"}.`);
      seen.add(row.id);
      const normativeId = name === "evaluations" ? `eval:${row.id}` : row.id;
      if (globalNormativeIds.has(normativeId)) errors.push(`Normative row ${normativeId} is multiply classified.`);
      globalNormativeIds.add(normativeId);
      normativeRows.set(normativeId, row);
      if (!["control_plane_owned", "always_agent_tool", "optional_agent_tool"].includes(row.primaryDisposition)) {
        errors.push(`${name}:${row.id} has invalid primaryDisposition.`);
      }
      if (!row.sourceAnchor || !row.expectedSemantics || !Array.isArray(row.requiredGrants) || !Array.isArray(row.assertionClasses) || !Array.isArray(row.evidenceIds)) {
        errors.push(`${name}:${row.id} is missing normalized traceability fields.`);
      }
    }
    if (expectedCounts[name] && inventory.rows.length !== expectedCounts[name]) {
      errors.push(`${name} expected ${expectedCounts[name]} rows but found ${inventory.rows.length}.`);
    }
  }
  const groups = new Set((inventories.evaluations?.rows ?? []).map((row) => row.group));
  for (const group of capabilityGroups) if (!groups.has(group)) errors.push(`evaluations is missing group ${group}.`);
  if (groups.size !== capabilityGroups.length) errors.push(`evaluations has unexpected groups: ${[...groups].sort().join(", ")}.`);

  const legacyMcpAliases = inventories.legacyMcpAliases;
  if (!legacyMcpAliases) {
    errors.push("Missing legacy MCP alias index.");
    return errors;
  }
  if (legacyMcpAliases.schemaVersion !== 2 || legacyMcpAliases.inventoryRole !== "legacy_alias_index") {
    errors.push("legacyMcpAliases must be a schema version 2 legacy alias index.");
  }
  const seenAliases = new Set();
  for (const alias of legacyMcpAliases.rows) {
    if (!alias.id || seenAliases.has(alias.id)) {
      errors.push(`legacyMcpAliases contains a missing or duplicate id: ${alias.id ?? "<missing>"}.`);
    }
    seenAliases.add(alias.id);
    if (Object.hasOwn(alias, "primaryDisposition")) {
      errors.push(`legacyMcpAliases:${alias.id} must not define an independent primaryDisposition.`);
    }
    if (!alias.sourceAnchor || !alias.expectedSemantics || !alias.foldedInto || !alias.evidenceId) {
      errors.push(`legacyMcpAliases:${alias.id} is missing folded traceability fields.`);
      continue;
    }
    const target = normativeRows.get(alias.foldedInto);
    if (!target) {
      errors.push(`legacyMcpAliases:${alias.id} folds into unknown normative row ${alias.foldedInto}.`);
      continue;
    }
    const targetAliases = target.legacyMcpAliases ?? [];
    if (targetAliases.filter((id) => id === alias.id).length !== 1) {
      errors.push(`legacyMcpAliases:${alias.id} must be folded exactly once into ${alias.foldedInto}.`);
    }
    if (target.evidenceIds.filter((id) => id === alias.evidenceId).length !== 1) {
      errors.push(`legacyMcpAliases:${alias.id} evidence must be folded exactly once into ${alias.foldedInto}.`);
    }
  }
  if (legacyMcpAliases.rows.length !== expectedCounts.legacyMcpAliases) {
    errors.push(`legacyMcpAliases expected ${expectedCounts.legacyMcpAliases} rows but found ${legacyMcpAliases.rows.length}.`);
  }
  for (const [normativeId, row] of normativeRows) {
    for (const aliasId of row.legacyMcpAliases ?? []) {
      if (!seenAliases.has(aliasId)) errors.push(`${normativeId} references unknown legacy MCP alias ${aliasId}.`);
    }
  }
  return errors;
}

export function validateInventorySchema(inventories, schema) {
  const ajv = new Ajv2020({
    allErrors: true,
    allowUnionTypes: true,
    strict: true,
    strictRequired: false,
  });
  const validate = ajv.compile(schema);
  const errors = [];
  for (const [name, inventory] of Object.entries(inventories)) {
    if (validate(inventory)) continue;
    for (const error of validate.errors ?? []) {
      errors.push(`${name}${error.instancePath || "/"} ${error.message ?? "failed schema validation"}.`);
    }
  }
  return errors;
}

export function renderContractModule(inventories) {
  const counts = {
    skillReferenceCapabilities: inventories.capabilities.rows.length,
    evalCases: inventories.evaluations.rows.length,
    normativeRows: inventories.capabilities.rows.length + inventories.evaluations.rows.length,
    legacyMcpAliases: inventories.legacyMcpAliases.rows.length,
  };
  return `// Generated by scripts/generate-capability-inventory.mjs. Do not edit.\n\nexport type CapabilityPrimaryDisposition =\n  | "control_plane_owned"\n  | "always_agent_tool"\n  | "optional_agent_tool";\n\nexport const capabilityInventoryCounts = ${JSON.stringify(counts, null, 2)} as const;\n\nexport const capabilityEvalGroups = ${JSON.stringify(capabilityGroups, null, 2)} as const;\n\nexport const capabilityInventoryContract = {\n  schemaVersion: 2,\n  normativeInventories: [\n    "spec/capability/capabilities.yaml",\n    "spec/capability/eval-traceability.yaml",\n  ],\n  legacyAliasIndexes: ["spec/capability/mcp-tool-map.yaml"],\n  primaryDispositions: [\n    "control_plane_owned",\n    "always_agent_tool",\n    "optional_agent_tool",\n  ] as const,\n} as const;\n`;
}

export function renderDocumentation(inventories) {
  const groupCounts = Object.fromEntries(capabilityGroups.map((group) => [group, inventories.evaluations.rows.filter((row) => row.group === group).length]));
  const capabilityLines = inventories.capabilities.rows.map((row) => `| ${row.id} | ${row.primaryDisposition} | ${row.sourceAnchor} |`).join("\n");
  const mcpLines = inventories.legacyMcpAliases.rows.map((alias) => {
    const target = inventories.evaluations.rows.find((row) => `eval:${row.id}` === alias.foldedInto);
    return `| ${alias.name} | ${alias.foldedInto} | ${target?.primaryDisposition ?? "unknown"} | ${alias.sourceAnchor} |`;
  }).join("\n");
  return `<!-- GENERATED FILE — DO NOT EDIT. Run pnpm generate:capability-inventory. -->\n\n# Capability Capability Contract\n\nThis generated contract is a self-contained derivative of the Nexus skill, its seven references, the Nexus Evals corpus, and the legacy MCP tool surface. It does not import or contact the Nexus control plane.\n\nThe skill/reference inventory and eval cases are the only normative behavior sources. Nexus does not use the legacy MCP calls as a production capability surface; all MCP names below are traceability aliases folded into normative eval rows. Their disposition, grants, assertions, and evidence contract are inherited from the target row rather than classified independently.\n\n## Baseline Counts\n\n- Skill/reference headings: ${inventories.capabilities.rows.length}\n- Eval cases: ${inventories.evaluations.rows.length} across ${capabilityGroups.length} groups\n- Total normative rows: ${inventories.capabilities.rows.length + inventories.evaluations.rows.length}\n- Legacy MCP aliases folded into normative rows: ${inventories.legacyMcpAliases.rows.length}\n\n| Eval group | Cases |\n| --- | ---: |\n${Object.entries(groupCounts).map(([group, count]) => `| ${group} | ${count} |`).join("\n")}\n\n## Regeneration\n\n- \`pnpm --dir packages/nexus-runner generate:capability-inventory\` imports the canonical baselines and rewrites every generated file.\n- \`pnpm --dir packages/nexus-runner check:capability-inventory\` validates counts, uniqueness, normative dispositions, one-to-one MCP folds, required fields, and generated-file drift without requiring the external eval repository.\n\n## Skill / Reference Rows\n\n| Capability | Primary disposition | Source anchor |\n| --- | --- | --- |\n${capabilityLines}\n\n## Legacy MCP Alias Index\n\nThis is a compatibility/traceability index, not a tool catalog. “Inherited disposition” is shown only to make the normative target easy to audit.\n\n| Legacy MCP name | Folded into normative row | Inherited disposition | Source anchor |\n| --- | --- | --- | --- |\n${mcpLines}\n`;
}

export function packageRelative(repoRoot, path) {
  return relative(repoRoot, path).replaceAll("\\", "/");
}
