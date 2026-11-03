import { STORAGE_PROVIDERS, type NexusConfig, type StorageProvider } from "@nexusai/shared";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultStorageDir, resolveHomeAwarePath } from "../home-paths.js";

export interface StorageConfig {
  storageProvider: StorageProvider;
  storageLocalDiskBaseDir: string;
  storageS3Bucket: string;
  storageS3Region: string;
  storageS3Endpoint: string | undefined;
  storageS3Prefix: string;
  storageS3ForcePathStyle: boolean;
}

export function loadStorageConfig(
  fileConfig: NexusConfig | null = readConfigFile(),
  env: NodeJS.ProcessEnv = process.env,
): StorageConfig {
  const storage = fileConfig?.storage;
  const selected = env.NEXUS_STORAGE_PROVIDER;
  const provider =
    selected && STORAGE_PROVIDERS.includes(selected as StorageProvider)
      ? (selected as StorageProvider)
      : null;
  return {
    storageProvider: provider ?? storage?.provider ?? "local_disk",
    storageLocalDiskBaseDir: resolveHomeAwarePath(
      env.NEXUS_STORAGE_LOCAL_DIR ?? storage?.localDisk?.baseDir ?? resolveDefaultStorageDir(),
    ),
    storageS3Bucket: env.NEXUS_STORAGE_S3_BUCKET ?? storage?.s3?.bucket ?? "nexus",
    storageS3Region: env.NEXUS_STORAGE_S3_REGION ?? storage?.s3?.region ?? "us-east-1",
    storageS3Endpoint: env.NEXUS_STORAGE_S3_ENDPOINT ?? storage?.s3?.endpoint ?? undefined,
    storageS3Prefix: env.NEXUS_STORAGE_S3_PREFIX ?? storage?.s3?.prefix ?? "",
    storageS3ForcePathStyle:
      env.NEXUS_STORAGE_S3_FORCE_PATH_STYLE !== undefined
        ? env.NEXUS_STORAGE_S3_FORCE_PATH_STYLE === "true"
        : (storage?.s3?.forcePathStyle ?? false),
  };
}
