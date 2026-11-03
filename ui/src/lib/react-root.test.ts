import { describe, expect, it, vi } from "vitest";
import type { Root } from "react-dom/client";
import {
  getOrCreateNexusReactRoot,
  type NexusReactRootHost,
} from "./react-root";

describe("getOrCreateNexusReactRoot", () => {
  it("reuses the existing root when the entry module runs again", () => {
    const host: NexusReactRootHost = {};
    const container = {} as Parameters<typeof getOrCreateNexusReactRoot>[1];
    const root = { render: vi.fn(), unmount: vi.fn() } as unknown as Root;
    const createRoot = vi.fn(() => root);

    expect(getOrCreateNexusReactRoot(host, container, createRoot)).toBe(root);
    expect(getOrCreateNexusReactRoot(host, container, createRoot)).toBe(root);
    expect(createRoot).toHaveBeenCalledTimes(1);
    expect(createRoot).toHaveBeenCalledWith(container);
  });
});
