import { createRoot, type Root } from "react-dom/client";

export interface NexusReactRootHost {
  __nexusReactRoot?: Root;
}

type CreateRoot = (container: Parameters<typeof createRoot>[0]) => Root;

/**
 * Keep one React root per browser window even if Vite evaluates the entry
 * module more than once during a development reload.
 */
export function getOrCreateNexusReactRoot(
  host: object,
  container: Parameters<typeof createRoot>[0],
  create: CreateRoot = createRoot,
): Root {
  const rootHost = host as NexusReactRootHost;
  if (rootHost.__nexusReactRoot) return rootHost.__nexusReactRoot;

  const root = create(container);
  rootHost.__nexusReactRoot = root;
  return root;
}
