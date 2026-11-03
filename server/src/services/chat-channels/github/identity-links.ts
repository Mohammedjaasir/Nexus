import type { chatExternalPrincipals } from "@nexusai/db";

export function githubIdentityFields(
  principal: Pick<typeof chatExternalPrincipals.$inferSelect, "externalId" | "handle">,
) {
  return { githubUserId: principal.externalId, githubLogin: principal.handle };
}
