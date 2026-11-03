import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { NexusApiClient } from "./client.js";
import { readConfigFromEnv, type NexusMcpConfig } from "./config.js";
import { createToolDefinitions } from "./tools.js";

export function createNexusMcpServer(config: NexusMcpConfig = readConfigFromEnv()) {
  const server = new McpServer({
    name: "nexus",
    version: "0.1.0",
  });

  const client = new NexusApiClient(config);
  const tools = createToolDefinitions(client);
  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.schema.shape, tool.execute);
  }

  return {
    server,
    tools,
    client,
  };
}

export async function runServer(config: NexusMcpConfig = readConfigFromEnv()) {
  const { server } = createNexusMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
