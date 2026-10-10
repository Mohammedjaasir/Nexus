// What the project bench lends the execution controls deep in the Folio (the
// artifact Passport keeps its props, so it reads this instead). Outside a bench
// (the Artifacts page) there is no provider: the controls that open a sheet render
// nothing, and evidence stays readable.
import { createContext, useContext } from 'react';
import type { LogRange } from './evidenceModel';

export interface ExecutionUi {
  projectId: string;
  /** Opens the execution setup sheet. */
  openSetup: () => void;
  /** Opens the writing sheet for an inline kind (requirement or problem statement) in a workspace. */
  openWrite: (w: { workspaceId: string; kind: 'requirement' | 'problem_statement'; artifactId?: string }) => void;
  /** Opens the log reader on a job (at a range when one is given). */
  openLog: (l: { jobId: string; range?: LogRange | null }) => void;
}

export const ExecutionUiContext = createContext<ExecutionUi | null>(null);
export const useExecutionUi = (): ExecutionUi | null => useContext(ExecutionUiContext);
