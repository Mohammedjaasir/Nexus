import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

export const DAYTONA_IMAGE_CONTENT_SCHEMA =
  "nexus-daytona-runner-image-content/v5";
export const DAYTONA_IMAGE_PLATFORM = "linux/amd64";
export const DAYTONA_IMAGE_DOCKERFILE_PATH = "docker/daytona-runner/Dockerfile";

export const DAYTONA_IMAGE_INPUT_PATHS = [...new Set([
  ".dockerignore",
  ".npmrc",
  "docker/daytona-runner/Dockerfile",
  "package.json",
  "patches",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/link-plugin-dev-sdk.mjs",
  "tsconfig.base.json",
  "packages/nexus-eval-kernel/package.json",
  "packages/nexus-eval-kernel/src",
  "packages/nexus-eval-kernel/tsconfig.json",
  "packages/nexus-runner/scripts/provision-grok.mjs",
  "packages/nexus-runner/package.json",
  "packages/nexus-runner/acpx-profiles.json",
  "packages/nexus-runner/cursor-distributions.json",
  "packages/nexus-runner/cursor-contract.json",
  // The pack's contract digest fingerprints these generated contracts.
  "packages/nexus-runner/generated",
  "packages/nexus-runner/protocol",
  "packages/nexus-runner/runner/Cargo.lock",
  "packages/nexus-runner/runner/Cargo.toml",
  "packages/nexus-runner/runner/crates",
  "packages/nexus-runner/scripts/acpx-sidecar-contract.mjs",
  "packages/nexus-runner/scripts/build-provider-pack.mjs",
  "packages/nexus-runner/scripts/contracts/contract-fingerprints.mjs",
  "packages/nexus-runner/scripts/provider-pack-executable-shims.mjs",
  "packages/nexus-runner/scripts/build-node-startup-timeout.mjs",
  "packages/nexus-runner/scripts/candidate-provider-pack.mjs",
  "packages/nexus-runner/scripts/build-copilot-distribution.mjs",
  "packages/nexus-runner/scripts/copilot-inner-distribution.mjs",
  // ACPX generation recomputes the Copilot, Grok, Pi and Kimi release attestations.
  "packages/nexus-runner/scripts/acpx-release-attestations.mjs",
  "packages/nexus-runner/scripts/generate-acpx-profiles.mjs",
  "packages/nexus-runner/scripts/materialize-copilot-binary.mjs",
  "packages/nexus-runner/scripts/install-copilot-assets.mjs",
  "packages/nexus-runner/scripts/materialize-cursor-distribution.mjs",
  "packages/nexus-runner/scripts/cursor-runtime-patch.mjs",
  "packages/nexus-runner/scripts/build-verified-provider-entrypoints.mjs",
  "packages/nexus-runner/antigravity-distributions.json",
  "packages/nexus-runner/scripts/provision-antigravity.mjs",
  "packages/nexus-runner/scripts/antigravity-provisioner-layout.mjs",
  "packages/nexus-runner/scripts/materialize-antigravity-distribution.mjs",
  "packages/nexus-runner/scripts/patch-antigravity-runtime.mjs",
  "packages/nexus-runner/scripts/patch-antigravity-runtime.admission.py",
  "packages/nexus-runner/scripts/provider-pack-runtime-tree.mjs",
  "packages/nexus-runner/scripts/generate-acpx-sidecar-contract.mjs",
  "packages/nexus-runner/scripts/generate-protocol-schema-module.mjs",
  "packages/nexus-runner/scripts/materialize-pi-distribution.mjs",
  "packages/nexus-runner/scripts/pi-distribution",
  "packages/nexus-runner/scripts/materialize-kimi-distribution.mjs",
  "packages/nexus-runner/scripts/patch-kimi-runtime.mjs",
  "packages/nexus-runner/scripts/kimi-instructions-runtime.mjs",
  "packages/nexus-runner/scripts/provision-kimi.mjs",
  "packages/nexus-runner/scripts/kimi-distribution",
  "packages/nexus-runner/scripts/cursor-native-usage.mjs",
  "packages/nexus-runner/scripts/cursor-native-usage-source.json",
  "packages/nexus-runner/scripts/provision-cursor.mjs",
  "packages/nexus-runner/cursor-distributions.json",
  "packages/nexus-runner/cursor-contract.json",
  // Pi runtime/extension/Node/closure pins are included by the src tree below.
  "packages/nexus-runner/src",
  "packages/nexus-runner/styles.css",
  "packages/nexus-runner/tsconfig.json",
  "packages/nexus-runner/tsconfig.surfaces.json",
])] as const;

const ignoredRunnerDevelopmentDirectoryPaths = new Set([
  "packages/nexus-runner/devtools",
  "packages/nexus-runner/docs",
  "packages/nexus-runner/examples",
  "packages/nexus-runner/test",
  "packages/nexus-runner/test-fixtures",
  "packages/nexus-runner/test-support",
]);

const runnerDocumentationFilePattern = /\.md$/;
const runnerTestFilePattern = /\.(?:spec|test)\.(?:[cm]?[jt]sx?)$/;
const runnerRustIntegrationTestPathPattern =
  /^packages\/nexus-runner\/runner\/crates\/[^/]+\/tests(?:\/|$)/;
const runnerSmokeScriptPattern =
  /^packages\/nexus-runner\/scripts\/[^/]+-smoke\.mjs$/;

export interface DaytonaImageContentOptions {
  repositoryRoot?: string;
  inputPaths?: readonly string[];
  platform?: string;
  baseImages?: readonly string[];
  frontendDigest?: string;
  /** Must match the Docker NEXUS_RUNNER_CANDIDATE_PROVIDERS build argument. */
  candidateProviders?: readonly string[];
}

export function normalizedDaytonaCandidateProviders(values: readonly string[]): string[] {
  const selected = [...values].sort();
  if (selected.some(value => !["cursor", "copilot", "pi", "kimi"].includes(value))
    || new Set(selected).size !== selected.length) {
    throw new Error("Daytona candidate providers must be distinct known ACP profiles");
  }
  return selected;
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function shouldIgnore(relativePath: string): boolean {
  return relativePath.split("/").includes("node_modules");
}

function shouldIgnoreRunnerDevelopmentInput(relativePath: string): boolean {
  if (!relativePath.startsWith("packages/nexus-runner/")) return false;
  if (ignoredRunnerDevelopmentDirectoryPaths.has(relativePath)) return true;
  return (
    runnerDocumentationFilePattern.test(relativePath) ||
    runnerTestFilePattern.test(relativePath) ||
    runnerRustIntegrationTestPathPattern.test(relativePath) ||
    runnerSmokeScriptPattern.test(relativePath)
  );
}

function updateRecord(
  hash: ReturnType<typeof createHash>,
  kind: string,
  relativePath: string,
  payload = "",
): void {
  hash.update(kind);
  hash.update("\0");
  hash.update(relativePath);
  hash.update("\0");
  hash.update(payload);
  hash.update("\0");
}

function assertPinnedBaseImage(reference: string): void {
  if (!/@sha256:[0-9a-f]{64}$/.test(reference)) {
    throw new Error(
      `Daytona image base must use an immutable sha256 digest: ${reference}`,
    );
  }
}

function assertPinnedFrontendDigest(digest: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(
      `Daytona Dockerfile frontend must use an immutable sha256 digest: ${digest}`,
    );
  }
}

export function extractDaytonaDockerfileFrontendDigest(
  dockerfile: string,
): string {
  const firstLine = dockerfile.split(/\r?\n/, 1)[0] ?? "";
  const match = /^#\s*syntax=\S+@(sha256:[0-9a-f]{64})\s*$/.exec(firstLine);
  if (!match) {
    throw new Error(
      "Daytona Dockerfile first line must pin its syntax frontend to an immutable sha256 digest",
    );
  }
  const digest = match[1]!;
  assertPinnedFrontendDigest(digest);
  return digest;
}

export function extractDaytonaBaseImages(dockerfile: string): string[] {
  const baseImages: string[] = [];
  const stageAliases = new Set<string>();

  for (const line of dockerfile.split(/\r?\n/)) {
    if (!/^\s*FROM\s/i.test(line)) continue;
    const match = /^\s*FROM(?:\s+--\S+)*\s+(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(
      line,
    );
    if (!match) {
      throw new Error(`Cannot parse Daytona Dockerfile FROM line: ${line}`);
    }

    const reference = match[1]!;
    if (!stageAliases.has(reference)) {
      assertPinnedBaseImage(reference);
      baseImages.push(reference);
    }
    if (match[2]) stageAliases.add(match[2]);
  }

  if (baseImages.length === 0) {
    throw new Error("Daytona Dockerfile does not declare a base image");
  }
  return baseImages;
}

async function resolveBaseImages(
  root: string,
  explicitBaseImages?: readonly string[],
): Promise<string[]> {
  const baseImages = explicitBaseImages
    ? [...explicitBaseImages]
    : extractDaytonaBaseImages(
        await readFile(path.join(root, DAYTONA_IMAGE_DOCKERFILE_PATH), "utf8"),
      );
  if (baseImages.length === 0) {
    throw new Error("Daytona image content identity requires a base image");
  }
  for (const reference of baseImages) assertPinnedBaseImage(reference);
  return baseImages.sort(compareNames);
}

async function resolveFrontendDigest(
  root: string,
  explicitFrontendDigest?: string,
): Promise<string> {
  const digest =
    explicitFrontendDigest ??
    extractDaytonaDockerfileFrontendDigest(
      await readFile(path.join(root, DAYTONA_IMAGE_DOCKERFILE_PATH), "utf8"),
    );
  assertPinnedFrontendDigest(digest);
  return digest;
}

async function hashEntry(
  hash: ReturnType<typeof createHash>,
  root: string,
  relativePath: string,
): Promise<void> {
  const normalizedPath = normalizedRelativePath(relativePath);
  if (
    shouldIgnore(normalizedPath) ||
    shouldIgnoreRunnerDevelopmentInput(normalizedPath)
  ) {
    return;
  }

  const absolutePath = path.resolve(root, relativePath);
  const relativeFromRoot = path.relative(root, absolutePath);
  if (
    relativeFromRoot.startsWith(`..${path.sep}`) ||
    relativeFromRoot === ".." ||
    path.isAbsolute(relativeFromRoot)
  ) {
    throw new Error(
      `Daytona image input escapes repository root: ${relativePath}`,
    );
  }

  const stats = await lstat(absolutePath);
  if (stats.isDirectory()) {
    const entries = await readdir(absolutePath, { withFileTypes: true });
    entries.sort((left, right) => compareNames(left.name, right.name));
    for (const entry of entries) {
      await hashEntry(hash, root, path.join(relativePath, entry.name));
    }
    return;
  }
  if (stats.isSymbolicLink()) {
    updateRecord(hash, "symlink", normalizedPath, await readlink(absolutePath));
    return;
  }
  if (stats.isFile()) {
    const executable =
      (stats.mode & 0o111) === 0 ? "non-executable" : "executable";
    updateRecord(hash, "file", normalizedPath, executable);
    hash.update(await readFile(absolutePath));
    hash.update("\0");
    return;
  }
  throw new Error(`Unsupported Daytona image input type: ${relativePath}`);
}

export async function computeDaytonaImageContentId(
  options: DaytonaImageContentOptions = {},
): Promise<string> {
  const root = path.resolve(options.repositoryRoot ?? repositoryRoot);
  const inputPaths = [
    ...(options.inputPaths ?? DAYTONA_IMAGE_INPUT_PATHS),
  ].sort(compareNames);
  const hash = createHash("sha256");
  updateRecord(
    hash,
    "contract",
    DAYTONA_IMAGE_CONTENT_SCHEMA,
    options.platform ?? DAYTONA_IMAGE_PLATFORM,
  );
  updateRecord(
    hash,
    "dockerfile-frontend",
    await resolveFrontendDigest(root, options.frontendDigest),
  );
  for (const baseImage of await resolveBaseImages(root, options.baseImages)) {
    updateRecord(hash, "base-image", baseImage);
  }
  for (const candidate of normalizedDaytonaCandidateProviders(options.candidateProviders ?? [])) {
    updateRecord(hash, "candidate-provider", candidate);
  }
  for (const inputPath of inputPaths) {
    await hashEntry(hash, root, inputPath);
  }
  return hash.digest("hex");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  const arguments_ = process.argv.slice(2);
  const candidateFlag = arguments_[0];
  if (arguments_.length > 1 || (candidateFlag !== undefined && !candidateFlag.startsWith("--candidate-providers="))) {
    throw new Error("Expected only --candidate-providers=cursor,copilot,pi,kimi");
  }
  const candidateProviders = candidateFlag?.slice("--candidate-providers=".length).split(",").filter(Boolean) ?? [];
  computeDaytonaImageContentId({ candidateProviders })
    .then((contentId) => process.stdout.write(`${contentId}\n`))
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}

export const DAYTONA_IMAGE_CONTENT_SCRIPT = fileURLToPath(import.meta.url);
