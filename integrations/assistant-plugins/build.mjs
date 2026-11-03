import { cp, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The endpoint is a packaging input, never a model-callable destination.
const endpoint = new URL(process.argv[2] || "http://localhost:3100/mcp/nexus");
const local = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/mcp/nexus"
  || (endpoint.protocol !== "https:" && !(local && endpoint.protocol === "http:"))) {
  throw new Error("Supply a deployed HTTPS /mcp/nexus URL, or HTTP loopback for development.");
}
const root = path.dirname(fileURLToPath(import.meta.url));
const identity = { name: "nexus", version: "0.1.0", description: "Review your team, delegate work and retrieve durable results in Nexus.", author: { name: "Nexus", url: "https://paperclip.ing" }, homepage: "https://paperclip.ing", repository: "https://github.com/paperclipai/paperclip", license: "MIT" };
const presentation = { displayName: "Nexus", shortDescription: "Your persistent team behind your assistant.", longDescription: "Use your Nexus team as yourself. Review tasks, delegate work to agents, add feedback and retrieve documents. Delegation can start autonomous work using your team's configured execution capacity and budget.", developerName: "Nexus", category: "Productivity", capabilities: ["Read", "Write"], defaultPrompt: "Review my Nexus team and show what needs my attention." };
const json = (file, data) => writeFile(file, JSON.stringify(data, null, 2) + "\n");
for (const vendor of ["openai", "claude"]) {
  const out = path.join(root, vendor, "nexus");
  const manifestDir = vendor === "openai" ? ".codex-plugin" : ".claude-plugin";
  await mkdir(path.join(out, manifestDir), { recursive: true });
  await cp(path.join(root, "shared", "skills"), path.join(out, "skills"), { recursive: true });
  await json(path.join(out, ".mcp.json"), { mcpServers: { nexus: { type: "http", url: endpoint.href } } });
  if (vendor === "openai") {
    await json(path.join(out, "plugin.json"), { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", ...identity, extensions: { "com.openai": { interface: presentation } } });
    await json(path.join(out, "mcp.json"), { $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { nexus: { type: "streamable-http", url: endpoint.href } } });
    await json(path.join(out, manifestDir, "plugin.json"), { ...identity, skills: "./skills/", mcpServers: "./.mcp.json", interface: presentation });
  } else {
    await json(path.join(out, manifestDir, "plugin.json"), { ...identity, skills: "./skills/", mcpServers: "./.mcp.json" });
  }
}
console.log(`Built both plugin packages for ${endpoint.href}${local ? " (development only; not a public listing)" : ""}`);
