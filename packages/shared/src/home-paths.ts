import os from "node:os";
import path from "node:path";

export const DEFAULT_NEXUS_INSTANCE_ID = "default";
export const NEXUS_CONFIG_BASENAME = "config.json";
export const NEXUS_ENV_FILENAME = ".env";

const PATH_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

export function expandHomePrefix(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

export function resolveNexusHomeDir(homeOverride?: string): string {
  const raw = homeOverride?.trim() || process.env.NEXUS_HOME?.trim();
  if (raw) return path.resolve(expandHomePrefix(raw));
  return path.resolve(os.homedir(), ".nexus");
}

export function resolveNexusInstanceId(instanceIdOverride?: string): string {
  const raw = instanceIdOverride?.trim() || process.env.NEXUS_INSTANCE_ID?.trim() || DEFAULT_NEXUS_INSTANCE_ID;
  if (!PATH_SEGMENT_RE.test(raw)) {
    throw new Error(`Invalid NEXUS_INSTANCE_ID '${raw}'.`);
  }
  return raw;
}

export function resolveNexusInstanceRoot(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveNexusHomeDir(input.homeDir), "instances", resolveNexusInstanceId(input.instanceId));
}

export function resolveNexusInstanceConfigPath(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveNexusInstanceRoot(input), NEXUS_CONFIG_BASENAME);
}

export function resolveNexusConfigPathForInstance(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return resolveNexusInstanceConfigPath(input);
}

export function resolveNexusEnvPathForConfig(configPath: string): string {
  return path.resolve(path.dirname(configPath), NEXUS_ENV_FILENAME);
}

export function resolveDefaultEmbeddedPostgresDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveNexusInstanceRoot(input), "db");
}

export function resolveDefaultLogsDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveNexusInstanceRoot(input), "logs");
}

export function resolveDefaultSecretsKeyFilePath(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveNexusInstanceRoot(input), "secrets", "master.key");
}

export function resolveDefaultStorageDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveNexusInstanceRoot(input), "data", "storage");
}

export function resolveDefaultBackupDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveNexusInstanceRoot(input), "data", "backups");
}

export function resolveHomeAwarePath(value: string): string {
  return path.resolve(expandHomePrefix(value));
}
