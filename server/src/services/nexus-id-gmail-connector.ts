/**
 * @deprecated Nexus ID is identity-only. Import the Nexus Cloud
 * connector names from `nexus-cloud-connector.ts` for new code.
 *
 * These aliases keep source compatibility while deployments and persisted app
 * definitions move from the former Nexus ID broker prototype.
 */
export {
  GMAIL_CONNECTOR_SCOPES,
  GMAIL_MCP_URL,
  GOOGLE_WORKSPACE_CONNECTOR_PROFILES,
  NexusCloudConnectorError as NexusIdConnectorError,
  createNexusCloudConnector as createNexusIdGmailConnector,
  nexusCloudConnectorCapabilitiesFromEnv as nexusIdGoogleConnectorCapabilitiesFromEnv,
  nexusCloudConnectorConfigFromEnv as nexusIdGmailConnectorConfigFromEnv,
} from "./nexus-cloud-connector.js";

export type {
  NexusCloudConnector as NexusIdGmailConnector,
  NexusCloudConnector as NexusIdGoogleWorkspaceConnector,
  NexusCloudConnectorConfig as NexusIdGmailConnectorConfig,
  NexusCloudConnectorEnvironment as NexusIdConnectorEnvironment,
  NexusCloudConnectorOperation as NexusIdConnectorOperation,
  SealedGmailCredentials,
  SealedGoogleWorkspaceCredentials,
} from "./nexus-cloud-connector.js";
