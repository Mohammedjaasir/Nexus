import fs from "node:fs";
import path from "node:path";
import { resolveDefaultConfigPath } from "./home-paths.js";
import { isCloudManagedInstance } from "./services/cloud-instance.js";

const NEXUS_CONFIG_BASENAME = "config.json";
const NEXUS_ENV_FILENAME = ".env";

function findConfigFileFromAncestors(startDir: string): string | null {
  const absoluteStartDir = path.resolve(startDir);
  let currentDir = absoluteStartDir;

  while (true) {
    const candidate = path.resolve(currentDir, ".nexus", NEXUS_CONFIG_BASENAME);
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const nextDir = path.resolve(currentDir, "..");
    if (nextDir === currentDir) break;
    currentDir = nextDir;
  }

  return null;
}

export function resolveNexusConfigPath(overridePath?: string): string {
  if (overridePath) return path.resolve(overridePath);
  if (process.env.NEXUS_CONFIG) return path.resolve(process.env.NEXUS_CONFIG);
  if (isCloudManagedInstance()) return resolveDefaultConfigPath();
  return findConfigFileFromAncestors(process.cwd()) ?? resolveDefaultConfigPath();
}

export function resolveNexusEnvPath(overrideConfigPath?: string): string {
  return path.resolve(path.dirname(resolveNexusConfigPath(overrideConfigPath)), NEXUS_ENV_FILENAME);
}
