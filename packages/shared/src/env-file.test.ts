import { describe, expect, it } from "vitest";
import { encodeEnvValue, updateEnvFileContents } from "./env-file.js";

describe("env file editor", () => {
  it("pins minimal and JSON value encoding", () => {
    expect(encodeEnvValue("plain-value", "minimal")).toBe("plain-value");
    expect(encodeEnvValue("#439edb", "minimal")).toBe('"#439edb"');
    expect(encodeEnvValue("plain-value", "json")).toBe('"plain-value"');
  });

  it("preserves unrelated content and CRLF while updating every stale duplicate", () => {
    const original = [
      "# operator comment",
      "UNKNOWN='keep this encoding'",
      "",
      "export NEXUS_HOME = '/old path'  # managed path",
      "NEXUS_DUPLICATE=stale",
      'NEXUS_DUPLICATE="current"',
      "TRAILING=untouched",
      "",
    ].join("\r\n");

    const updated = updateEnvFileContents(
      original,
      {
        NEXUS_HOME: "/new path",
        NEXUS_DUPLICATE: "current",
        NEXUS_WORKTREE_COLOR: "#439edb",
      },
      { valueEncoding: "minimal" },
    );

    expect(updated).toBe([
      "# operator comment",
      "UNKNOWN='keep this encoding'",
      "",
      'export NEXUS_HOME = "/new path"  # managed path',
      "NEXUS_DUPLICATE=current",
      'NEXUS_DUPLICATE="current"',
      "TRAILING=untouched",
      'NEXUS_WORKTREE_COLOR="#439edb"',
      "",
    ].join("\r\n"));
    expect(updated.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("uses JSON encoding for changed values without re-encoding current assignments", () => {
    const original = [
      "NEXUS_CURRENT=plain-value",
      "NEXUS_CHANGED=old",
      "UNKNOWN=\"operator value\"",
      "",
    ].join("\n");

    expect(
      updateEnvFileContents(
        original,
        {
          NEXUS_CURRENT: "plain-value",
          NEXUS_CHANGED: "new",
          NEXUS_ADDED: "added",
        },
        { valueEncoding: "json" },
      ),
    ).toBe([
      "NEXUS_CURRENT=plain-value",
      'NEXUS_CHANGED="new"',
      'UNKNOWN="operator value"',
      'NEXUS_ADDED="added"',
      "",
    ].join("\n"));
  });

  it("does not treat an unquoted dotenv comment as the managed value", () => {
    expect(
      updateEnvFileContents(
        ["NEXUS_COLOR=#439edb", "NEXUS_HOME=old# keep this comment"].join("\n"),
        {
          NEXUS_COLOR: "#439edb",
          NEXUS_HOME: "new",
        },
        { valueEncoding: "minimal" },
      ),
    ).toBe(
      ['NEXUS_COLOR="#439edb"#439edb', "NEXUS_HOME=new# keep this comment"].join("\n"),
    );
  });

  it("is a no-op when every managed duplicate is already current", () => {
    const original = [
      "export NEXUS_HOME = '/same path' # first",
      'NEXUS_HOME="/same path"',
      "UNKNOWN=value",
    ].join("\n");

    expect(updateEnvFileContents(original, { NEXUS_HOME: "/same path" })).toBe(original);
  });
});
