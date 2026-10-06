import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { parseTasks, type HiveTask } from '@/components/TasksKanban';

/** Poll the task ledger while the section is mounted; the interval is cleared
 *  on unmount. `loaded` stays false until the first read lands, so a section
 *  never shows "no tasks" before it has looked. A failed read keeps the last
 *  good list. */
export function useHiveTasks(intervalMs: number): {
  tasks: HiveTask[];
  setTasks: Dispatch<SetStateAction<HiveTask[]>>;
  loaded: boolean;
  refresh: () => Promise<void>;
} {
  const [tasks, setTasks] = useState<HiveTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const refresh = useCallback(async () => {
    try { setTasks(parseTasks(await window.cth.hiveTasks())); } catch { /* keep last good */ }
    setLoaded(true);
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, intervalMs);
    return () => clearInterval(timer);
  }, [refresh, intervalMs]);
  return { tasks, setTasks, loaded, refresh };
}
