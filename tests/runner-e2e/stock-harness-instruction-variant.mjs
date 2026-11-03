import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const reduced = "You are an agent in a Nexus company.\n";
const historicalSha256 = "1b2f303539f921140fab608404e9742841f60366e6323a8a5ee2b76233ab86cc";

/**
 * @param {unknown} content
 * @returns {{ variant: 'reduced' | 'historical', sha256: string, content: string }}
 */
export function classifyStockInstructionManual(content) {
  if (typeof content !== "string") throw new Error("Stock harness instruction manual must be exact UTF-8 text.");
  const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
  if (content === reduced) return { variant: "reduced", sha256, content };
  if (Buffer.byteLength(content, "utf8") === 4249 && sha256 === historicalSha256)
    return { variant: "historical", sha256, content };
  throw new Error("Stock harness instruction manual is not an admitted reduced or historical source.");
}

export function readStockInstructionVariant() {
  return classifyStockInstructionManual(readFileSync(new URL(
    "../../server/src/onboarding-assets/default/AGENTS.md", import.meta.url,
  ), "utf8"));
}
