import { createHash } from "node:crypto";

import { NEXUS_RUNNER_COMPATIBILITY } from "../compatibility.js";
import {
  PRP_PROTOCOL_MIN_VERSION,
  PRP_PROTOCOL_NAME,
  PRP_PROTOCOL_VERSION,
} from "../protocol/replay-contract.js";
import { canonicalCapabilitySemanticCatalog } from "../semantic-tools/catalog.js";

export const NEXUS_RUNNER_BUILD_METADATA_SCHEMA =
  "nexus-runner/build-metadata/v1" as const;
export const NEXUS_RUNNER_NATIVE_EXECUTION_SCHEMA =
  "nexus-runner/native-execution/v1" as const;
export const NEXUS_RUNNER_EVAL_INTEGRATION_SCHEMA =
  "nexus-runner/evals-integration/v1" as const;
export const NEXUS_RUNNERD_BUILD_METADATA_SCHEMA =
  "nexus-runner/runnerd-build-metadata/v1" as const;

export const NEXUS_RUNNER_SEMANTIC_CATALOG_SHA256 =
  `sha256:${createHash("sha256")
    .update(canonicalCapabilitySemanticCatalog())
    .digest("hex")}` as const;

/**
 * App-owned release metadata that Evals pins beside every native attempt.
 * Contract versions are independent from package semver so consumers can give
 * a precise mismatch instead of guessing from a package version.
 */
export const NEXUS_RUNNER_BUILD_METADATA = Object.freeze({
  schema: NEXUS_RUNNER_BUILD_METADATA_SCHEMA,
  package: Object.freeze({
    name: NEXUS_RUNNER_COMPATIBILITY.packageName,
    version: NEXUS_RUNNER_COMPATIBILITY.packageVersion,
  }),
  contracts: Object.freeze({
    evalIntegration: NEXUS_RUNNER_COMPATIBILITY.components.evalIntegration,
    nativeExecution: NEXUS_RUNNER_COMPATIBILITY.components.nativeExecution,
    runnerdArtifact: NEXUS_RUNNER_COMPATIBILITY.components.runnerdBinary,
    prp: PRP_PROTOCOL_VERSION,
    semanticCatalog: NEXUS_RUNNER_COMPATIBILITY.components.catalog,
    harnessDriver: NEXUS_RUNNER_COMPATIBILITY.components.harnessDriver,
    controlPlaneAdapter: NEXUS_RUNNER_COMPATIBILITY.components.controlPlaneAdapter,
    testkit: NEXUS_RUNNER_COMPATIBILITY.components.testkit,
  }),
  prp: Object.freeze({
    name: PRP_PROTOCOL_NAME,
    minimumVersion: PRP_PROTOCOL_MIN_VERSION,
    maximumVersion: PRP_PROTOCOL_VERSION,
  }),
  semanticCatalog: Object.freeze({
    version: NEXUS_RUNNER_COMPATIBILITY.components.catalog,
    sha256: NEXUS_RUNNER_SEMANTIC_CATALOG_SHA256,
  }),
  runnerd: Object.freeze({
    binaryName: "nexus-runnerd" as const,
    metadataSchema: NEXUS_RUNNERD_BUILD_METADATA_SCHEMA,
    digestAlgorithm: "sha256" as const,
  }),
});

export type NexusRunnerBuildMetadata = typeof NEXUS_RUNNER_BUILD_METADATA;
