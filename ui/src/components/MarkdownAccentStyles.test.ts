import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(fileURLToPath(new URL("../index.css", import.meta.url)), "utf8");

function cssBlock(selector: string): string {
  const start = stylesheet.indexOf(`${selector} {`);
  expect(start, `Missing CSS selector: ${selector}`).toBeGreaterThanOrEqual(0);

  const bodyStart = stylesheet.indexOf("{", start);
  const bodyEnd = stylesheet.indexOf("\n}", bodyStart);
  expect(bodyStart, `Missing CSS block start: ${selector}`).toBeGreaterThanOrEqual(0);
  expect(bodyEnd, `Missing CSS block end: ${selector}`).toBeGreaterThan(bodyStart);

  return stylesheet.slice(bodyStart + 1, bodyEnd);
}

describe("accent markdown styles", () => {
  it("inherits the current message bubble foreground for prose text, links, and list counters", () => {
    const block = cssBlock(".nexus-markdown.nexus-markdown-on-accent");

    expect(block).toContain("color: inherit");
    expect(block).toContain("--tw-prose-body: currentColor");
    expect(block).toContain("--tw-prose-links: currentColor");
    expect(block).toContain("--tw-prose-counters: currentColor");
    expect(block).toContain("--tw-prose-bullets: currentColor");
    expect(block).toContain("--tw-prose-invert-links: currentColor");
  });

  it("keeps ordered-list markers and rendered link variants readable on accent bubbles", () => {
    expect(cssBlock(".nexus-markdown.nexus-markdown-on-accent li::marker")).toContain(
      "color: currentColor",
    );
    expect(cssBlock(".nexus-markdown.nexus-markdown-on-accent :where(a, a:visited)")).toContain(
      "color: currentColor",
    );
    expect(cssBlock(".nexus-markdown.nexus-markdown-on-accent .nexus-workspace-file-link")).toContain(
      "color: currentColor",
    );
    expect(
      cssBlock(
        ".nexus-markdown.nexus-markdown-on-accent :where(a.nexus-mention-chip, a.nexus-project-mention-chip)",
      ),
    ).toContain("color: currentColor !important");
  });
});
