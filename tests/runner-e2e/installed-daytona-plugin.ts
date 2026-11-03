/** Public plugin fixture admission; the complete installed graph is audited separately. */
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { findPackageJSON } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertInstalledCliSelection, usesInstalledCli } from "./installed-cli.js";
import type { MatrixExecution } from "./types.js";

export const installedDaytonaPluginKeys = ["NEXUS_RUNNER_E2E_INSTALLED_DAYTONA_PLUGIN", "NEXUS_RUNNER_E2E_INSTALLED_DAYTONA_PLUGIN_AUTHORITY", "NEXUS_RUNNER_E2E_INSTALLED_DAYTONA_PLUGIN_AUTHORITY_SHA256"] as const;
type PackagePin = { root: string; packageSha256: string; entry: string; entrySha256: string };
export interface InstalledDaytonaPluginAuthority {
  schema: "nexus.e2e.installed-daytona-plugin/v1";
  graphRoot: string;
  plugin: PackagePin & { manifestSha256: string; workerSha256: string };
  sdk: PackagePin;
  shared: PackagePin;
  daytona: PackagePin;
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function canonical(path: string) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw new Error("Installed Daytona plugin path must be canonical and unlinked");
}
async function pinned(path: string, expected: string, maximum = 32 * 1024 * 1024) {
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("Installed Daytona plugin requires a SHA-256 pin");
  await canonical(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximum) || before.nlink !== 1n) throw new Error("Installed Daytona plugin requires a bounded unlinked regular file");
    const bytes = await handle.readFile(); const after = await handle.stat({ bigint: true }); const named = await lstat(path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || named.dev !== before.dev || named.ino !== before.ino || bytes.length !== Number(before.size) || digest(bytes) !== expected) throw new Error("Installed Daytona plugin bytes differ from reviewed pins");
    return bytes;
  } finally { await handle.close(); }
}
function compiledEntry(manifest: any): string | undefined {
  const exported = manifest.exports?.["."];
  return typeof exported === "string" ? exported : (typeof exported?.import === "string" ? exported.import : exported?.import?.default) ?? manifest.main;
}
export async function verifyInstalledDaytonaPlugin(env: NodeJS.ProcessEnv, executions: readonly MatrixExecution[]) {
  const selected = installedDaytonaPluginKeys.some(key => env[key] !== undefined);
  const required = usesInstalledCli(env) && executions.some(e => e.environment.id === "daytona");
  if (!selected && !required) return undefined;
  assertInstalledCliSelection(env, executions);
  if (!usesInstalledCli(env) || !installedDaytonaPluginKeys.every(key => Boolean(env[key])) || executions.some(e => e.environment.id !== "daytona")) throw new Error("Installed Daytona plugin requires complete pins and installed Daytona selection");
  const authorityPath = env.NEXUS_RUNNER_E2E_INSTALLED_DAYTONA_PLUGIN_AUTHORITY!;
  const authoritySha256 = env.NEXUS_RUNNER_E2E_INSTALLED_DAYTONA_PLUGIN_AUTHORITY_SHA256!;
  const a: InstalledDaytonaPluginAuthority = JSON.parse((await pinned(authorityPath, authoritySha256, 65536)).toString());
  if (a.schema !== "nexus.e2e.installed-daytona-plugin/v1" || a.plugin?.root !== env.NEXUS_RUNNER_E2E_INSTALLED_DAYTONA_PLUGIN) throw new Error("Installed Daytona plugin authority differs");
  await canonical(a.graphRoot);
  async function packageAt(pin: PackagePin, name: string) {
    await canonical(pin.root);
    if (pin.root !== join(a.graphRoot, "node_modules", name)) throw new Error("Installed Daytona plugin package escapes its reviewed graph");
    const manifest = JSON.parse((await pinned(join(pin.root, "package.json"), pin.packageSha256, 65536)).toString());
    if (manifest.name !== name || typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(manifest.version) || pin.entry !== (name === "@daytonaio/sdk" ? "./esm/index.js" : "./dist/index.js") || compiledEntry(manifest) !== pin.entry) throw new Error("Installed Daytona plugin requires published compiled package exports");
    await pinned(join(pin.root, pin.entry), pin.entrySha256);
    return manifest;
  }
  const plugin = await packageAt(a.plugin, "@nexusai/plugin-daytona");
  const sdk = await packageAt(a.sdk, "@nexusai/plugin-sdk");
  const shared = await packageAt(a.shared, "@nexusai/shared");
  const daytona = await packageAt(a.daytona, "@daytonaio/sdk");
  if (plugin.nexusPlugin?.manifest !== "./dist/manifest.js" || plugin.nexusPlugin?.worker !== "./dist/worker.js" || plugin.dependencies?.["@nexusai/plugin-sdk"] !== sdk.version || sdk.dependencies?.["@nexusai/shared"] !== shared.version || plugin.dependencies?.["@daytonaio/sdk"] !== "0.203.0" || daytona.version !== "0.203.0") throw new Error("Installed Daytona plugin public dependency identity differs");
  await pinned(join(a.plugin.root, "dist/manifest.js"), a.plugin.manifestSha256);
  await pinned(join(a.plugin.root, "dist/worker.js"), a.plugin.workerSha256);
  for (const [name, parent, pin] of [["@nexusai/plugin-sdk", join(a.plugin.root, "dist/worker.js"), a.sdk], ["@nexusai/shared", join(a.sdk.root, a.sdk.entry), a.shared], ["@daytonaio/sdk", join(a.plugin.root, "dist/worker.js"), a.daytona]] as const) {
    const found = findPackageJSON(name, pathToFileURL(parent));
    if (!found || await realpath(found) !== join(pin.root, "package.json")) throw new Error("Installed Daytona plugin resolves a foreign dependency");
  }
  return { schema: a.schema, authorityPath, authoritySha256, packageRoot: a.plugin.root, graphRoot: a.graphRoot, fullGraphVerified: false, completeGraphAuthorityRequired: true, sourceFallback: false };
}
