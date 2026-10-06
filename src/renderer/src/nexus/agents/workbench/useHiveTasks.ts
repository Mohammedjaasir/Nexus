import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { parseTasks, type HiveTask } from '@/components/TasksKanban';

/** The raw ledger entries, aligned index-for-index with parseTasks' output
 *  (parseTasks drops non-objects, then maps one-to-one). */
function rawEntries(raw: unknown): Record<string, unknown>[] {
  const list = (raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks))
    ? (raw as { tasks: unknown[] }).tasks
    : [];
  return list.filter((t): t is Record<string, unknown> => !!t && typeof t === 'object');
}

/** Poll the task ledger while the section is mounted; the interval is cleared
 *  on unmount. `loaded` stays false until the first read lands, so a section
 *  never shows "no tasks" before it has looked. A failed read keeps the last
 *  good list and sets `error` (cleared by the next good read). `rawOf` returns
 *  the unnormalised entry for a task id, so writes can keep fields outside the
 *  parsed schema. */
export function useHiveTasks(intervalMs: number): {
  tasks: HiveTask[];
  setTasks: Dispatch<SetStateAction<HiveTask[]>>;
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  rawOf: (id: string) => Record<string, unknown> | undefined;
} {
  const [tasks, setTasks] = useState<HiveTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const raw = useRef(new Map<string, Record<string, unknown>>());
  const refresh = useCallback(async () => {
    try {
      const data = await window.cth.hiveTasks();
      const parsed = parseTasks(data);
      const entries = rawEntries(data);
      raw.current = new Map(parsed.map((t, i) => [t.id, entries[i]] as const));
      setTasks(parsed);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e)); // keep last good list
    }
    setLoaded(true);
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, intervalMs);
    return () => clearInterval(timer);
  }, [refresh, intervalMs]);
  const rawOf = useCallback((id: string) => raw.current.get(id), []);
  return { tasks, setTasks, loaded, error, refresh, rawOf };
}
