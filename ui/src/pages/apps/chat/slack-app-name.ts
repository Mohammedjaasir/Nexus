import { defaultSlackAppConfiguration } from "@nexusai/shared";

export function slackBotNameForAgent(agentName: string): string {
  return defaultSlackAppConfiguration(agentName).botName;
}

export function defaultSlackAppName(agentName: string): string {
  return defaultSlackAppConfiguration(agentName).appName;
}
