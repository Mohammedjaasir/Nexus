import type { AssistantPort } from './port';
import { useLeadAgentPort } from './leadAgentPort';

/** The ONLY place that decides which assistant backend the UI talks to. */
export function useAssistant(): AssistantPort {
  return useLeadAgentPort();
}
