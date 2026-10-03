import { useCallback, useEffect, useRef, useState } from 'react';
import { kindOf } from './spineModel';
import type { ChangeKind, GitState } from './spineModel';

export function useProjectGit(rootPath: string | null): { git: GitState; refresh: () => void } {
  const [git, setGit] = useState<GitState>({ status: 'loading' });
  const reqId = useRef(0);
  const read = useCallback(async () => {
    const id = ++reqId.current;
    const live = () => reqId.current === id;
    if (!rootPath) { setGit({ status: 'loading' }); return; }
    try {
      const isRepo = await window.cth.gitIsRepo(rootPath);
      if (!live()) return;
      if (!isRepo) { setGit({ status: 'ready', isRepo: false, branch: null, head: null, changed: [] }); return; }
      const [b, log, st] = await Promise.all([window.cth.gitBranch(rootPath), window.cth.gitLog(rootPath, 1), window.cth.gitStatus(rootPath)]);
      if (!live()) return;
      const branch = 'error' in b ? null : b.current;
      const head = Array.isArray(log) && log[0] ? { sha: log[0].sha, shortSha: log[0].shortSha, subject: log[0].subject, time: log[0].time } : null;
      if ('error' in st) { setGit({ status: 'error', message: st.error }); return; }
      const seen = new Map<string, ChangeKind>();
      for (const e of [...st.staged, ...st.unstaged]) seen.set(e.path, kindOf(e.index, e.worktree));
      for (const p of st.untracked) seen.set(p, 'untracked');
      setGit({ status: 'ready', isRepo: true, branch, head, changed: [...seen].map(([path, kind]) => ({ path, kind })) });
    } catch (e) {
      if (live()) setGit({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, [rootPath]);
  useEffect(() => {
    setGit({ status: 'loading' });
    void read();
    const onFocus = () => void read();
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      reqId.current += 1; // invalidate in-flight reads (older path or unmount)
    };
  }, [read]);
  const refresh = useCallback(() => void read(), [read]);
  return { git, refresh };
}
