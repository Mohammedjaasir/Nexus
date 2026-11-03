#!/usr/bin/env node
import { runServer } from "./index.js";

void runServer().catch((error) => {
  console.error("Failed to start Nexus MCP server:", error);
  process.exit(1);
});
