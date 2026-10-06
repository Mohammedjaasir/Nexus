import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import { useCanonicalAgents, useRegistryIds } from '@/nexus/agents/agentIdentity';
import { displayNameForId } from '@shared/agentDisplay';
import { openLeadSection } from '@/nexus/agents/workbench/openLeadSection';
import { TaskDetail, parseTasks, type HiveTask } from './TasksKanban';

/**
 * App-wide host for the task detail: whoever calls store.openTaskDetail(id) —
 * a card in the lead agent's Tasks or Needs you — gets the SAME big overlay.
 * Keeps its own 5s ledger poll so an open detail stays fresh while the lead
 * agent edits cards.
 */

const POLL_MS = 5000;

export function TaskDetailOverlay() {
  const taskDetailId = useStore((s) => s.taskDetailId);
  const closeTaskDetail = useStore((s) => s.closeTaskDetail);
  const agents = useStore((s) => s.agents);
  const restorable = useStore((s) => s.restorableAgents);
  const hint = useRegistryIds();
  const canon = useCanonicalAgents();
  const [tasks, setTasks] = useState<HiveTask[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    // parseTasks NORMALIZES (the ledger is a hand-written file; cards may lack
    // dependsOn/priority/etc.) — a raw card without dependsOn crashed the
    // detail once. Never feed TaskDetail unparsed ledger entries.
    try { setTasks(parseTasks(await window.cth.hiveTasks())); } catch { /* keep last good */ }
  }, []);

  useEffect(() => {
    if (!taskDetailId) return;
    void refresh();
    timer.current = setInterval(() => { void refresh(); }, POLL_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [taskDetailId, refresh]);

  if (!taskDetailId) return null;
  const task = tasks.find((t) => t.id === taskDetailId);
  if (!task) return null;

  const nameFor = (id?: string): string | undefined =>
    id ? displayNameForId(id, canon, hint) : undefined;

  const move = async (status: HiveTask['status']) => {
    const next = tasks.map((t) => (t.id === task.id ? { ...t, status } : t));
    setTasks(next); // optimistic
    try {
      const result = await window.cth.hivePatchTask(task.id, { status });
      if (!result.ok) void refresh();
    } catch { void refresh(); }
  };

  const assign = () => {
    // Route through the lead agent's Requests box (which mails the lead agent;
    // the human never writes into another agent's inbox directly).
    const desc = task.description?.trim() ? task.description.trim() : '(no description)';
    openLeadSection('requests', `Task: ${task.title}\nContext: ${desc}\n`, hint);
    closeTaskDetail();
  };

  return (
    <TaskDetail
      task={task}
      all={tasks}
      assigneeName={nameFor(task.assignee)}
      onMove={(s) => void move(s)}
      onAssign={assign}
      onClose={closeTaskDetail}
    />
  );
}
