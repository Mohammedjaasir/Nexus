import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nexusRunnerSupportsPlatform } from "@nexusai/shared";

import {
  nexusRunnerBinaryNeedsBuild,
  resolveNativeRunnerDevBinary,
  resolveNativeRunnerRequirement,
} from "../../../scripts/dev-runner-native-binary.mjs";

const tempRoots = new Set<string>();
const initialPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const initialArchitecture = Object.getOwnPropertyDescriptor(process, "arch")!;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", initialPlatform);
  Object.defineProperty(process, "arch", initialArchitecture);
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createRunnerCheckout(): { root: string; source: string; binary: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-dev-runner-binary-"));
  tempRoots.add(root);

  const runnerRoot = path.join(root, "packages", "nexus-runner", "runner");
  const source = path.join(runnerRoot, "crates", "runner-core", "src", "main.rs");
  const binary = path.join(
    root,
    "packages",
    "nexus-runner",
    "dist",
    "bin",
    process.platform === "win32" ? "nexus-runnerd.exe" : "nexus-runnerd",
  );
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(path.join(runnerRoot, "Cargo.toml"), "[workspace]\n", "utf8");
  fs.writeFileSync(path.join(runnerRoot, "Cargo.lock"), "", "utf8");
  fs.writeFileSync(source, "fn main() {}\n", "utf8");
  fs.writeFileSync(binary, nativeHeader(process.platform, process.arch));
  return { root, source, binary };
}

function nativeHeader(platform: string, architecture: string): Buffer {
  const bytes = Buffer.alloc(128);
  if (platform === "darwin") {
    bytes.writeUInt32LE(0xfeedfacf);
    bytes.writeUInt32LE(architecture === "x64" ? 0x01000007 : 0x0100000c, 4);
  } else if (platform === "win32") {
    bytes.set([0x4d, 0x5a]); bytes.writeUInt32LE(64, 60);
    bytes.writeUInt32LE(0x00004550, 64); bytes.writeUInt16LE(architecture === "x64" ? 0x8664 : 0xaa64, 68);
  } else {
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); bytes.writeUInt16LE(architecture === "x64" ? 62 : 183, 18);
  }
  return bytes;
}

describe("nexus runner native dev prerequisite", () => {
  it.each(["x64", "arm64"].flatMap(architecture => [[undefined, false], ["2.38", false], ["2.39", true], ["3.0", true]].map(([glibcVersionRuntime, native]) => ({ architecture, glibcVersionRuntime, native }))))("uses the measured libc prerequisite on Linux $architecture/$glibcVersionRuntime when no native run or flag requires it", ({ architecture, glibcVersionRuntime, native }) => {
    Object.defineProperty(process, "platform", { ...initialPlatform, value: "linux" });
    Object.defineProperty(process, "arch", { ...initialArchitecture, value: architecture });
    const nativeRunnerRequired = nexusRunnerSupportsPlatform("codex_local", "linux", architecture, glibcVersionRuntime ? "glibc" : "unknown", glibcVersionRuntime as string | undefined);
    expect(nativeRunnerRequired).toBe(native);
    expect(nexusRunnerBinaryNeedsBuild({ repoRoot: "/checkout/without/a/staged/binary", nativeRunnerRequired })).toBe(native);
  });
  it("uses an explicit status response and fails safe when status is unknown", () => {
    expect(
      resolveNativeRunnerRequirement({
        exitCode: 0,
        stdout: "pnpm warning\n{\"nativeRunnerRequired\":false}\n",
      }),
    ).toEqual({ nativeRunnerRequired: false, valid: true });
    expect(
      resolveNativeRunnerRequirement({
        exitCode: 0,
        stdout: "{\"nativeRunnerRequired\":true}\n",
      }),
    ).toEqual({ nativeRunnerRequired: true, valid: true });
    expect(
      resolveNativeRunnerRequirement({
        exitCode: 1,
        stdout: "",
      }),
    ).toEqual({ nativeRunnerRequired: true, valid: false });
    expect(
      resolveNativeRunnerRequirement({
        exitCode: 0,
        stdout: "{\"unexpected\":true}\n",
      }),
    ).toEqual({ nativeRunnerRequired: true, valid: false });
  });

  it("builds only when the staged binary is missing or older than Rust inputs", () => {
    const checkout = createRunnerCheckout();
    const now = Date.now();
    const old = new Date(now - 2_000);
    const current = new Date(now + 2_000);
    const next = new Date(now + 4_000);

    fs.utimesSync(checkout.source, old, old);
    fs.utimesSync(checkout.binary, current, current);
    expect(
      nexusRunnerBinaryNeedsBuild({
        repoRoot: checkout.root,
        nativeRunnerRequired: true,
      }),
    ).toBe(false);

    fs.utimesSync(checkout.source, next, next);
    expect(
      nexusRunnerBinaryNeedsBuild({
        repoRoot: checkout.root,
        nativeRunnerRequired: true,
      }),
    ).toBe(true);

    fs.rmSync(checkout.binary);
    expect(
      nexusRunnerBinaryNeedsBuild({
        repoRoot: checkout.root,
        nativeRunnerRequired: true,
      }),
    ).toBe(true);
  });

  it("keeps default-off legacy development Node-only", () => {
    expect(
      nexusRunnerBinaryNeedsBuild({
        repoRoot: "/checkout/without/a/staged/binary",
        nativeRunnerRequired: false,
      }),
    ).toBe(false);
  });

  it.each([
    "antigravity-distributions.json", "rust-toolchain.toml", "protocol/provider-schemas/acpx-sidecar.schema.json",
  ])("rebuilds an existing native binary after changing embedded input %s", input => {
    const checkout = createRunnerCheckout();
    const dependency = path.join(checkout.root, "packages/nexus-runner", input);
    fs.mkdirSync(path.dirname(dependency), { recursive: true });
    fs.writeFileSync(dependency, "fixture compile input\n");
    const now = Date.now(), old = new Date(now - 2_000), built = new Date(now + 2_000), changed = new Date(now + 4_000);
    fs.utimesSync(dependency, old, old);
    fs.utimesSync(checkout.binary, built, built);
    const options = { repoRoot: checkout.root, nativeRunnerRequired: true };
    expect(nexusRunnerBinaryNeedsBuild(options)).toBe(false);
    fs.utimesSync(dependency, changed, changed);
    expect(nexusRunnerBinaryNeedsBuild(options)).toBe(true);
    expect(nexusRunnerBinaryNeedsBuild({ ...options, nativeRunnerRequired: false })).toBe(false);
  });

  it.each(["arm64", "x64"])("uses the staged Mac %s target before the flat build output", architecture => {
    const checkout = createRunnerCheckout();
    const target = path.join(path.dirname(checkout.binary), `darwin-${architecture}`, "nexus-runnerd");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, nativeHeader("darwin", architecture));
    const old = new Date(Date.now() - 2000), current = new Date(Date.now() + 2000);
    fs.utimesSync(checkout.binary, old, old);
    fs.utimesSync(target, current, current);
    const input = { repoRoot: checkout.root, nativeRunnerRequired: true, platform: "darwin", architecture };
    expect(nexusRunnerBinaryNeedsBuild(input)).toBe(false);
    fs.writeFileSync(checkout.binary, nativeHeader("linux", "x64"));
    const wrongHostNewer = new Date(Date.now() + 4000);
    fs.utimesSync(checkout.binary, wrongHostNewer, wrongHostNewer);
    expect(resolveNativeRunnerDevBinary(input)).toEqual({ binary: target, sourceBuild: false });
    expect(nexusRunnerBinaryNeedsBuild(input)).toBe(false);
    fs.rmSync(checkout.binary);
    expect(nexusRunnerBinaryNeedsBuild(input)).toBe(false);
    fs.utimesSync(target, old, old);
    expect(nexusRunnerBinaryNeedsBuild(input)).toBe(true);
    fs.rmSync(target);
    expect(nexusRunnerBinaryNeedsBuild(input)).toBe(true);
  });

  it.each(["arm64", "x64"])("uses only a newer matching Mac %s source build without changing release selection", architecture => {
    const checkout = createRunnerCheckout();
    const target = path.join(path.dirname(checkout.binary), `darwin-${architecture}`, "nexus-runnerd");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, nativeHeader("darwin", architecture));
    fs.writeFileSync(checkout.binary, nativeHeader("darwin", architecture));
    const old = new Date(Date.now() - 2000), fresh = new Date(Date.now() + 2000), changed = new Date(Date.now() + 4000);
    fs.utimesSync(target, old, old); fs.utimesSync(checkout.binary, fresh, fresh);
    const input = { repoRoot: checkout.root, nativeRunnerRequired: true, platform: "darwin", architecture };
    expect(resolveNativeRunnerDevBinary(input)).toEqual({ binary: checkout.binary, sourceBuild: true });
    expect(nexusRunnerBinaryNeedsBuild(input)).toBe(false);
    fs.utimesSync(checkout.source, changed, changed);
    expect(nexusRunnerBinaryNeedsBuild(input)).toBe(true);
    fs.writeFileSync(checkout.binary, nativeHeader("darwin", architecture === "x64" ? "arm64" : "x64"));
    expect(resolveNativeRunnerDevBinary(input)).toEqual({ binary: target, sourceBuild: false });
    fs.rmSync(target);
    expect(resolveNativeRunnerDevBinary(input)).toBeNull();
    expect(nexusRunnerBinaryNeedsBuild(input)).toBe(true);
  });

  it("does not build a workspace binary when an explicit binary is configured", () => {
    expect(
      nexusRunnerBinaryNeedsBuild({
        repoRoot: "/checkout/without/a/staged/binary",
        nativeRunnerRequired: true,
        configuredBinary: "/opt/nexus/nexus-runnerd",
      }),
    ).toBe(false);
  });
});
