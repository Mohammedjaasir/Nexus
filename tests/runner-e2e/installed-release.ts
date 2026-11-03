import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

/** Test supervisor only: launch the actual public CLI, with its own module root. */
export function installedReleaseLaunch(cliPath: string) {
  if (!path.isAbsolute(cliPath)) throw new Error("Installed release CLI must be an absolute path");
  const cli = realpathSync(cliPath);
  const root = path.resolve(path.dirname(cli), "..");
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  if (path.basename(cli) !== "index.js" || path.basename(path.dirname(cli)) !== "dist" ||
      manifest.name !== "nexusai" || typeof manifest.version !== "string") {
    throw new Error("Installed release must use nexusai/dist/index.js from its public package");
  }
  return { cli, cwd: root, args: [cli, "onboard", "--yes", "--run"], version: manifest.version };
}

/** Verify the selected public plugin belongs to the release being qualified. */
export function installedReleaseDaytonaPlugin(cliPath: string, installedPluginPath?: string, expectedVersion?: string): string {
  const cli = installedReleaseLaunch(cliPath);
  if (installedPluginPath && !path.isAbsolute(installedPluginPath)) throw new Error("Installed Daytona plugin path must be absolute");
  const plugin = realpathSync(installedPluginPath ?? path.join(path.dirname(cli.cwd), "@nexusai/plugin-daytona"));
  const manifest = JSON.parse(readFileSync(path.join(plugin, "package.json"), "utf8"));
  if (manifest.name !== "@nexusai/plugin-daytona" ||
      manifest.nexusPlugin?.manifest !== "./dist/manifest.js" ||
      manifest.nexusPlugin?.worker !== "./dist/worker.js" ||
      manifest.exports?.["."]?.import !== "./dist/index.js") {
    throw new Error("Installed release requires the public compiled Daytona plugin package");
  }
  const releaseVersion = expectedVersion ?? cli.version;
  if (!releaseVersion || manifest.version !== releaseVersion) {
    throw new Error(`Installed Daytona plugin must match qualified release version ${releaseVersion}`);
  }
  realpathSync(path.join(plugin, "dist/manifest.js"));
  realpathSync(path.join(plugin, "dist/worker.js"));
  realpathSync(path.join(plugin, "dist/index.js"));
  return plugin;
}

/** Qualification assets must never make a public installed product smoke pass. */
export function installedReleaseEnvironment(source: NodeJS.ProcessEnv, repositoryRoot: string, providerBin: string): NodeJS.ProcessEnv {
  if (source.NEXUS_RUNNER_ACPX_QUALIFICATION) throw new Error("Installed release smoke requires production admission without qualification overrides");
  const result = { ...source };
  for (const key of Object.keys(result)) {
    if ((key.startsWith("NEXUS_RUNNER_") && !key.startsWith("NEXUS_RUNNER_E2E_")) ||
        key.startsWith("NEXUS_ACPX_") || key.startsWith("NEXUS_NATIVE_") ||
        key === "NODE_PATH" || key === "NODE_OPTIONS") delete result[key];
  }
  result.PATH = source.PATH?.split(path.delimiter).filter(entry =>
    entry && entry !== providerBin && entry !== repositoryRoot &&
    !entry.startsWith(`${repositoryRoot}${path.sep}`) && !entry.includes(`${path.sep}node_modules${path.sep}`),
  ).join(path.delimiter);
  return result;
}
