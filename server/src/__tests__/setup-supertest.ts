import fs from "node:fs";
import { createIsolatedTestHome } from "./helpers/isolated-test-home.js";
import { createRequire } from "node:module";
import type { AddressInfo, Server as NetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Server as TlsServer } from "node:tls";


type SupertestServer = NetServer & {
  address(): ReturnType<NetServer["address"]>;
  listen(port: number): NetServer;
};

type SupertestTestInstance = {
  _server?: SupertestServer;
};

type SupertestTestConstructor = {
  prototype: {
    serverAddress(this: SupertestTestInstance, app: SupertestServer, path: string): string;
    __nexusLoopbackPatched?: boolean;
  };
};

// Keep the original home available only for read-only host port-lease checks.
process.env.NEXUS_TEST_HOST_HOME ??= process.env.NEXUS_HOME?.trim() || path.join(os.homedir(), ".nexus");

// Receipt-spool recovery must never scan a developer's instance during tests.
const { home: nexusTestHome, cleanup: cleanupNexusTestHome } = createIsolatedTestHome();
process.env.NEXUS_HOME = nexusTestHome;
process.env.NEXUS_CONFIG = path.join(nexusTestHome, "config.json");
process.env.NEXUS_INSTANCE_ID = `vt-${process.pid}`;
// Setup-file afterAll hooks run before suites drain asynchronous heartbeats.
// Cleanup at worker exit, after all suite teardown, avoids deleting live state.
process.once("exit", cleanupNexusTestHome);

const require = createRequire(import.meta.url);
const SupertestTest = require("supertest/lib/test.js") as SupertestTestConstructor;

if (!process.env.CODEX_HOME) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-vitest-codex-home-"));
  fs.writeFileSync(path.join(codexHome, "auth.json"), '{"OPENAI_API_KEY":"sk-vitest"}\n', { mode: 0o600 });
  process.env.CODEX_HOME = codexHome;
}

// The automatic Tailscale HTTPS default (PAP-17158) probes for a real host
// broker socket, so leaving it enabled would make every test that starts a
// service named `nexus-dev` behave differently on a broker-capable host
// than on CI. Tests that exercise the default opt in explicitly.
if (!process.env.NEXUS_MANAGED_RUNTIME_HTTPS) {
  process.env.NEXUS_MANAGED_RUNTIME_HTTPS = "off";
}

if (!SupertestTest.prototype.__nexusLoopbackPatched) {
  SupertestTest.prototype.serverAddress = function serverAddress(app, path) {
    const addr = app.address();

    if (!addr) {
      this._server = app.listen(0) as SupertestServer;
    }

    const listeningAddress = app.address() as AddressInfo | string | null;
    if (!listeningAddress || typeof listeningAddress === "string") {
      throw new Error("Expected Supertest server to listen on a TCP port");
    }

    const host = listeningAddress.address === "::"
      ? "[::1]"
      : listeningAddress.address === "0.0.0.0"
        ? "127.0.0.1"
        : listeningAddress.address;
    const protocol = app instanceof TlsServer ? "https" : "http";
    return `${protocol}://${host}:${listeningAddress.port}${path}`;
  };

  SupertestTest.prototype.__nexusLoopbackPatched = true;
}
