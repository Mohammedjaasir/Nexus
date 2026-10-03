import { useCallback, useEffect, useState } from 'react';
import type { ChangeKind, GitState } from './spineModel';

function kindOf(index: string, worktree: string): ChangeKind {
  const c = (index.trim() || worktree.trim())[0];
  return c === 'A' ? 'added' : c === 'D' ? 'deleted' : c === 'R' ? 'renamed' : 'modified';
}

export function useProjectGit(rootPath: string | null): { git: GitState; refresh: () => void } {
  const [git, setGit] = useState<GitState>({ status: 'loading' });
  const read = useCallback(async () => {
    if (!rootPath) return;
    try {
      const isRepo = await window.cth.gitIsRepo(rootPath);
      if (!isRepo) { setGit({ status: 'ready', isRepo: false, branch: null, head: null, changed: [] }); return; }
      const [b, log, st] = await Promise.all([window.cth.gitBranch(rootPath), window.cth.gitLog(rootPath, 1), window.cth.gitStatus(rootPath)]);
      const branch = 'error' in b ? null : b.current;
      const head = Array.isArray(log) && log[0] ? { sha: log[0].sha, shortSha: log[0].shortSha, subject: log[0].subject, time: log[0].time } : null;
      if ('error' in st) { setGit({ status: 'error', message: st.error }); return; }
      const seen = new Map<string, ChangeKind>();
      for (const e of [...st.staged, ...st.unstaged]) seen.set(e.path, kindOf(e.index, e.worktree));
      for (const p of st.untracked) seen.set(p, 'untracked');
      setGit({ status: 'ready', isRepo: true, branch, head, changed: [...seen].map(([path, kind]) => ({ path, kind })) });
    } catch (e) {
      setGit({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, [rootPath]);
  useEffect(() => {
    void read();
    const onFocus = () => void read();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [read]);
  return { git, refresh: () => void read() };
}
