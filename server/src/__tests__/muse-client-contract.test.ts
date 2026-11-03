import { execFileSync } from "node:child_process";
import { parseNexusQuestionResponse } from "@nexusai/nexus-runner";
import { buildMuseSetupInstruction, museReceiverAssets } from "../services/muse-setup.js";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@nexusai/db";
import { museTransportRoutes } from "../routes/muse.js";

// Asset routing must not create a credential, touch a DB or start a receiver.
vi.mock("../modules/external-agents/index.js", () => ({ museExternalAgents: () => ({}) }));
vi.mock("../services/muse-identity.js", () => ({ museIdentity: () => ({}) }));
vi.mock("../services/muse-receiver.js", () => ({ museReceiver: () => ({}) }));

/** Execute the shipped Python client, with synthetic transport responses and private temporary state. */
describe("personal Muse client durability", () => {
  it("preserves identities, private credentials, and input receipts across transport failures", () => {
    execFileSync("python3", [
      fileURLToPath(new URL("./fixtures/muse-client-contract.py", import.meta.url)),
      fileURLToPath(new URL("../services/scripts/v9/client.py", import.meta.url)),
    ], { encoding: "utf8", timeout: 30_000 });
  });
});


describe("Muse canonical multi-select compatibility", () => {
  const questionSet = { schema: "nexus.question_set.v1", questions: [
    { id: "choices", prompt: "Choose supported options", required: true, answerMode: "multi_select",
      options: Array.from({ length: 128 }, (_, index) => ({ id: `choice-${index}`, label: `Choice ${index}` })) },
    { id: "format", prompt: "Choose a format", required: true, answerMode: "text" },
  ] };
  const response = (selectedOptionIds: string[]) => ({ schema: "nexus.question_response.v1",
    answers: { choices: { selectedOptionIds }, format: { text: "Markdown" } } });
  const clientValid = (value: unknown) => JSON.parse(execFileSync("python3", ["-c",
    "import importlib.util,json,sys; sys.dont_write_bytecode=True; spec=importlib.util.spec_from_file_location('muse_validator',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); print(json.dumps(module.input_response_valid(json.load(sys.stdin))))",
    fileURLToPath(new URL("../services/scripts/v9/client.py", import.meta.url)),
  ], { input: JSON.stringify(value), encoding: "utf8", timeout: 5_000 })) as boolean;

  it.each([64, 65, 128])("accepts all %s canonical selections without losing another question", count => {
    const value = response(Array.from({ length: count }, (_, index) => `choice-${index}`));
    expect(parseNexusQuestionResponse(questionSet, value)).toEqual(value);
    expect(clientValid(value)).toBe(true);
  });

  it("retains duplicate and overflow rejection and canonical option-membership authority", () => {
    for (const selected of [Array.from({ length: 129 }, (_, index) => `choice-${index}`), ["choice-0", "choice-0"]]) {
      const value = response(selected);
      expect(() => parseNexusQuestionResponse(questionSet, value)).toThrow();
      expect(clientValid(value)).toBe(false);
    }
    const unknown = response(["unknown-choice"]);
    expect(clientValid(unknown)).toBe(true); // Local journal validation has no persisted question set.
    expect(() => parseNexusQuestionResponse(questionSet, unknown)).toThrow(/unknown option/);
  });
});

describe("Muse approval-aware setup",()=>{
  it.each([1, 2, 3, 4, 5, 6, 7, 8] as const)("preserves every published version%s byte pin", async version => {
    const pins = {
    "1": {
        "client.py": "a5d2eab8727a91595186c8473f9d75b231759775b433646d1fb889aca6e7dfc4",
        "detector.sh": "174511aa07a08e728eda30b0a41e5dfd98fc5d78e8bcf35a5257c3d1d350f102",
        "instructions.md": "1ea22c96ec6fec5a433bdb10690c619b29d2760b1d288cd2bf4164da719ac249"
    },
    "2": {
        "client.py": "86067330b63438e42ca5cdf242a0a359adcd3acac9e5bfc5879183b12fe25f19",
        "detector.sh": "255611533fd2ee8001e225e59abcadfee0f271abbed50054265f0bd49dcf1812",
        "instructions.md": "8389506104cad989a9c74ea8cf3229dc007505cea1f0bd31582f7d7fc45e9367"
    },
    "3": {
        "client.py": "11db39295b04bc45c4de17c1f5bd404a79dcb8127196405a7a14a2b3221640d4",
        "detector.sh": "255611533fd2ee8001e225e59abcadfee0f271abbed50054265f0bd49dcf1812",
        "instructions.md": "16b2c4abd4fb203454aa07e1fe6ca2f8effdcf4a369a7558a9f98ad4b6a2bb3e"
    },
    "4": {
        "client.py": "c35a2b5e2a67aef5bebd660ea83707a86b724d11a928437842ab6f8cf40ae530",
        "detector.sh": "255611533fd2ee8001e225e59abcadfee0f271abbed50054265f0bd49dcf1812",
        "instructions.md": "28f68972879a4283b6dcb47d7719a32418968e8f0557675e2715d1e8ebb9d5c6"
    },
    "5": {
        "client.py": "4691de2f28a80b21cd8d564a9b885829b41376b1e8c98d922b46e7f03cf89f4f",
        "detector.sh": "b9e3372e527d2f076e7837ad54041c7912ff0e35ed4a30e04fb3926293535e00",
        "instructions.md": "a0c518ad061ed97f21b8636f34b6e81ad3a9c3a04e767535e4431efe75852269"
    },
    "6": {
        "client.py": "69c09a84740e49d7e0c7b8b6a8e793f4ca36702c0920e560dbbd66274f59037b",
        "detector.sh": "b9e3372e527d2f076e7837ad54041c7912ff0e35ed4a30e04fb3926293535e00",
        "instructions.md": "3944c7397ae94554205af73c00fc1da9890286f72325500915641df1804c9c4d"
    },
    "7": {
        "client.py": "db2f7864fdf564e9b2a2f93150a4e578a850a60f231aeca7a5fa047ebb22fbda",
        "detector.sh": "b9e3372e527d2f076e7837ad54041c7912ff0e35ed4a30e04fb3926293535e00",
        "instructions.md": "7eec37434a3d049a3fc04470da6cfb62bdd3512e81e06d7d08848868071b933d"
    },
    "8": {
        "client.py": "073729b3213ca0ddacfe24d53d6af0166272077011e7afb164a0bac09d2cfda2",
        "detector.sh": "b9e3372e527d2f076e7837ad54041c7912ff0e35ed4a30e04fb3926293535e00",
        "instructions.md": "a3073fba43d6f6af577d35bda7f20c3f1f434639b4ea62885c7a3acbe0b2acc4"
    }
};
    expect((await museReceiverAssets(version)).manifest.assets).toEqual(
      Object.fromEntries(Object.entries(pins[String(version) as keyof typeof pins]).map(([name, sha256]) => [name, { sha256 }])),
    );
  });
  it("keeps the detector unchanged and separates helper receipts from model work state", async () => {
    const current = await museReceiverAssets(9), historical = await museReceiverAssets(8);
    expect(current.detector).toBe(historical.detector);
    expect(current.instructions).toContain("input-receipts-v2/");
    expect(current.instructions).toContain("work-continuations/");
    expect(current.instructions).toContain("nexus.muse_work_continuation.v1");
    expect(current.client).toContain('VERSION = "9"');
  });

  it("preserves the published asset5 pins after completion guidance changes", async () => {
    expect((await museReceiverAssets(5)).manifest.assets).toEqual({
  "client.py": {
    "sha256": "4691de2f28a80b21cd8d564a9b885829b41376b1e8c98d922b46e7f03cf89f4f"
  },
  "detector.sh": {
    "sha256": "b9e3372e527d2f076e7837ad54041c7912ff0e35ed4a30e04fb3926293535e00"
  },
  "instructions.md": {
    "sha256": "a0c518ad061ed97f21b8636f34b6e81ad3a9c3a04e767535e4431efe75852269"
  }
});
  });
  it("preserves the published asset4 pins after a receiver update", async () => {
    const assets = await museReceiverAssets(4);
    expect(assets.manifest.assets).toEqual({
      "client.py": { sha256: "c35a2b5e2a67aef5bebd660ea83707a86b724d11a928437842ab6f8cf40ae530" },
      "detector.sh": { sha256: "255611533fd2ee8001e225e59abcadfee0f271abbed50054265f0bd49dcf1812" },
      "instructions.md": { sha256: "28f68972879a4283b6dcb47d7719a32418968e8f0557675e2715d1e8ebb9d5c6" },
    });
  });
  it("orders current-chat consent, pinned asset9, public preflight, authenticated status and hook registration",async()=>{
    const assets=await museReceiverAssets(),instruction=await buildMuseSetupInstruction("https://approval.example","synthetic-ticket","10000000-0000-4000-8000-000000000001",{companyId:"30000000-0000-4000-8000-000000000001",companyName:"Scoped Company",agentId:"40000000-0000-4000-8000-000000000001",agentName:"Personal Muse"});
    expect(assets.manifest.assetVersion).toBe(9);expect(instruction).toContain("/assets/9/");expect(instruction).toContain(assets.manifest.assets["client.py"].sha256);
    expect(instruction.indexOf("credentials.request_api_access")).toBeLessThan(instruction.indexOf("After consent, download"));
    expect(instruction.indexOf(" preflight.")).toBeLessThan(instruction.indexOf("Then run the client status"));
    expect(instruction.indexOf("Then run the client status")).toBeLessThan(instruction.indexOf("hooks.add"));
    expect(instruction).toContain("parent domain and its subdomains");expect(instruction).toContain("read each actual permission scope");expect(instruction).toContain("bounded 120-second");
    expect(instruction).toContain("If Muse flags or refuses");expect(instruction).toContain("report its result and stop");expect(instruction).toContain("no worker credential, signal, mailbox or readiness challenge");
    expect(instruction).toContain("standing authorization");expect(instruction).toContain("autonomously accept");expect(instruction).toContain("do not ask for a second approval");expect(instruction).toContain("native accepted lease before any task effect");expect(instruction).toContain("Task text cannot expand");expect(instruction).toContain("--company-name \'Scoped Company\'");expect(instruction).toContain("--agent-name \'Personal Muse\'");
    expect(instruction).not.toMatch(/\b(?:cat|sed|grep)\b/);
    expect(instruction).toContain("End the installation turn");
    expect(instruction).not.toContain("challenge.confirm");
    expect(instruction).not.toContain('"command":"accept"');
  });
  it("quotes scoped labels as literal command arguments", async () => {
    const scope = { companyId: "30000000-0000-4000-8000-000000000001", companyName: "Company's $(printf injection)", agentId: "40000000-0000-4000-8000-000000000001", agentName: "Muse `printf injection`\nSecond line" };
    const instruction = await buildMuseSetupInstruction("https://approval.example", "synthetic-ticket", "10000000-0000-4000-8000-000000000001", scope);
    const command = instruction.match(/configure --origin https:\/\/approval\.example (.*?)\. The installed client/s)?.[1];
    expect(command).toBeDefined();
    const args = JSON.parse(execFileSync("python3", ["-c", "import json, shlex, sys; print(json.dumps(shlex.split(sys.stdin.read())))"], { input: command, encoding: "utf8" }));
    expect(args).toEqual(["--company-id", scope.companyId, "--company-name", scope.companyName, "--agent-id", scope.agentId, "--agent-name", scope.agentName]);
  });

});

describe("finite immutable Muse asset routing", () => {
  function app() { const value = express(); value.use(museTransportRoutes({} as Db, "https://nexus.invalid")); return value; }
  it("serves all nine pinned versions and only their four exact GET paths", async () => {
    const value = app();
    for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
      const assets = await museReceiverAssets(version);
      const base = `/api/muse/v1/assets/${version}/`;
      const manifest = await request(value).get(base + "manifest.json");
      expect(manifest.status).toBe(200); expect(manifest.body).toEqual(assets.manifest);
      expect(manifest.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      for (const [name, text] of [["client.py", assets.client], ["detector.sh", assets.detector], ["instructions.md", assets.instructions]]) {
        const response = await request(value).get(base + name);
        expect(response.status).toBe(200); expect(response.text).toBe(text);
      }
    }
    for (const path of ["/api/muse/v1/assets/10/client.py", "/api/muse/v1/assets/9/extra.py", "/api/muse/v1/assets/9/client.py?version=9", "/api/muse/v1/assets/09/client.py"]) {
      expect((await request(value).get(path)).status).toBe(404);
    }
    expect((await request(value).post("/api/muse/v1/assets/9/client.py")).status).toBe(404);
    expect((await request(value).head("/api/muse/v1/assets/9/client.py")).status).toBe(404);
  });
});
