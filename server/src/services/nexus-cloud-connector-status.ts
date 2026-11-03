import {
  nexusCloudConnectorEnrollmentStatus,
  type NexusCloudConnectorEnrollmentStatus,
} from "./nexus-cloud-connector-enrollment.js";
import {
  createNexusCloudConnector,
  nexusCloudConnectorConfigFromEnv,
} from "./nexus-cloud-connector.js";

export async function reconcileNexusCloudConnectorEnrollmentStatus(
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
): Promise<NexusCloudConnectorEnrollmentStatus> {
  const local = nexusCloudConnectorEnrollmentStatus(env);
  if (!local.configured) return local;
  const config = nexusCloudConnectorConfigFromEnv(env);
  if (!config) return { ...local, configured: false, status: "not_configured" };
  try {
    const status = await createNexusCloudConnector({ config, request }).getInstanceStatus();
    if (status === "active") return { ...local, configured: true, status: "active" };
    if (status === "suspended") return { ...local, configured: false, status: "suspended" };
    return { ...local, configured: false, status: "not_configured" };
  } catch {
    return { ...local, configured: false, status: "unverified" };
  }
}
