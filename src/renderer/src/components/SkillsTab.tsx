/**
 * SKILLS — what the coding agents here can already do, and 1,200 more they could.
 *
 * Two modes behind one toggle rather than two tabs: "installed" answers "why did
 * my agent just do that?", "browse" answers "what else is out there?", and they
 * share the same search box because the user's question is usually just a word.
 *
 * Nothing here installs anything. A skill is instructions that run inside an
 * agent holding the user's tools and keys, so adding one is a decision, not a
 * click — the catalog links out and the user chooses.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LocalSkill, CatalogSkill } from '../../../preload';

type Mode = 'installed' | 'browse';

const PROVIDER_LABEL: Record<LocalSkill['provider'], string> = {
  claude: 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex'
};

function Chip({ text, tone = 'quiet' }: { text: string; tone?: 'quiet' | 'accent' }) {
  return <span className="nxh-chip" data-tone={tone === 'accent' ? 'on' : undefined}>{text}</span>;
}

export function SkillsTab({ agentCwd }: { agentCwd?: string }) {
  const [mode, setMode] = useState<Mode>('installed');
  const [query, setQuery] = useState('');
  const [local, setLocal] = useState<LocalSkill[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogSkill[] | null>(null);
  const [catalogMeta, setCatalogMeta] = useState<{ stale: boolean; error?: string; fetchedAt: number } | null>(null);
  const [owner, setOwner] = useState<string>('all');
  const [category, setCategory] = useState<string>('all');
  const [busy, setBusy] = useState(false);
  /** Per-row action state, keyed by catalog url / local path. Keeps one row's
   *  spinner or error from being mistaken for the whole tab failing. */
  const [action, setAction] = useState<Record<string, { busy?: boolean; error?: string; done?: string }>>({});
  /** Uninstall is destructive, so it is two clicks: the first arms this, the
   *  second does it. No modal — the row itself becomes the confirmation. */
  const [confirming, setConfirming] = useState<string | null>(null);

  const loadLocal = useCallback(async () => {
    try { setLocal(await window.cth.skillsLocal(agentCwd)); } catch { setLocal([]); }
  }, [agentCwd]);

  const loadCatalog = useCallback(async (force = false) => {
    setBusy(true);
    try {
      const res = await window.cth.skillsCatalog(force);
      setCatalog(res.skills);
      setCatalogMeta({ stale: res.stale, error: res.error, fetchedAt: res.fetchedAt });
    } catch {
      setCatalog([]);
      setCatalogMeta({ stale: true, error: 'could not reach the catalog', fetchedAt: 0 });
    } finally { setBusy(false); }
  }, []);

  useEffect(() => { void loadLocal(); }, [loadLocal]);
  // The catalog is fetched only when the user actually opens Browse — no network
  // call for someone who just wanted to see what is installed.
  useEffect(() => { if (mode === 'browse' && catalog === null) void loadCatalog(); }, [mode, catalog, loadCatalog]);

  const q = query.trim().toLowerCase();

  const shownLocal = useMemo(() => {
    const list = local ?? [];
    if (!q) return list;
    return list.filter((s) =>
      s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  }, [local, q]);

  const owners = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of catalog ?? []) counts.set(s.owner, (counts.get(s.owner) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [catalog]);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of catalog ?? []) counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [catalog]);

  const shownCatalog = useMemo(() => {
    let list = catalog ?? [];
    if (owner !== 'all') list = list.filter((s) => s.owner === owner);
    if (category !== 'all') list = list.filter((s) => s.category === category);
    if (q) {
      list = list.filter((s) =>
        s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
    }
    // Bounded render: 1,200 rows in a DOM list makes the panel janky, and nobody
    // scrolls past a few hundred. The count below always states the real total.
    return list.slice(0, 300);
  }, [catalog, owner, category, q]);

  const totalMatching = useMemo(() => {
    let list = catalog ?? [];
    if (owner !== 'all') list = list.filter((s) => s.owner === owner);
    if (category !== 'all') list = list.filter((s) => s.category === category);
    if (!q) return list.length;
    return list.filter((s) =>
      s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)).length;
  }, [catalog, owner, category, q]);

  const install = async (c: CatalogSkill) => {
    setAction((a) => ({ ...a, [c.url]: { busy: true } }));
    try {
      const res = await window.cth.skillsInstall(c.url, c.name);
      if (res.ok) {
        setAction((a) => ({ ...a, [c.url]: { done: 'Installed' } }));
        void loadLocal(); // the installed pane must reflect it immediately
      } else {
        setAction((a) => ({ ...a, [c.url]: { error: res.error } }));
      }
    } catch (e) {
      setAction((a) => ({ ...a, [c.url]: { error: e instanceof Error ? e.message : 'install failed' } }));
    }
  };

  const uninstall = async (sk: LocalSkill) => {
    setConfirming(null);
    setAction((a) => ({ ...a, [sk.path]: { busy: true } }));
    try {
      const res = await window.cth.skillsUninstall(sk.path);
      if (res.ok) { setAction((a) => { const n = { ...a }; delete n[sk.path]; return n; }); void loadLocal(); }
      else setAction((a) => ({ ...a, [sk.path]: { error: res.error ?? 'could not remove it' } }));
    } catch (e) {
      setAction((a) => ({ ...a, [sk.path]: { error: e instanceof Error ? e.message : 'uninstall failed' } }));
    }
  };

  const actionClass = (kind: 'primary' | 'quiet' | 'danger') =>
    `nx-btn nx-btn--sm${kind === 'primary' ? ' nx-btn--primary' : kind === 'danger' ? ' nx-btn--danger' : ''}`;

  return (
    <div className="nxh nxh--flush">
      {/* Controls */}
      <div className="nxh__bar">
        <div className="nxh-seg nxh-seg--inline" role="group" aria-label="Skills">
          <button type="button" className="nxh-seg__opt" aria-pressed={mode === 'installed'} onClick={() => setMode('installed')}>
            Installed{local ? ` (${local.length})` : ''}
          </button>
          <button type="button" className="nxh-seg__opt" aria-pressed={mode === 'browse'} onClick={() => setMode('browse')}>
            Browse{catalog ? ` (${catalog.length})` : ''}
          </button>
        </div>
        <input
          className="nxh-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={mode === 'installed' ? 'Search installed skills…' : 'Search the skills catalog…'}
          aria-label={mode === 'installed' ? 'Search installed skills' : 'Search the skills catalog'}
          style={{ flex: 1, minWidth: 140, width: 'auto' }}
        />
        {mode === 'browse' && (
          <select
            className="nxh-select"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            title="Categories as published by the catalog"
            aria-label="Category"
            style={{ maxWidth: 210 }}
          >
            <option value="all">all categories</option>
            {categories.map(([c, n]) => <option key={c} value={c}>{c} ({n})</option>)}
          </select>
        )}
        {mode === 'browse' && (
          <select
            className="nxh-select"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            aria-label="Publisher"
            style={{ maxWidth: 190 }}
          >
            <option value="all">all publishers</option>
            {owners.map(([o, n]) => <option key={o} value={o}>{o} ({n})</option>)}
          </select>
        )}
        <button
          type="button"
          className="nx-btn nx-btn--sm nx-btn--quiet"
          onClick={() => (mode === 'installed' ? void loadLocal() : void loadCatalog(true))}
          disabled={busy}
        >{busy ? 'Loading…' : 'Refresh'}</button>
      </div>

      {/* Body */}
      <div className="nxh__body">
        {mode === 'installed' ? (
          local === null ? <Muted>Scanning…</Muted>
          : shownLocal.length === 0 ? (
            <Muted>
              {local.length === 0
                ? 'No skills installed yet. Open Browse to see what is available.'
                : 'Nothing matches that search.'}
            </Muted>
          ) : (
            <div className="nxh-list">
              {shownLocal.map((s) => (
                <div key={s.id + s.path} className="nxh-card">
                  <div className="nxh-row" style={{ flexWrap: 'nowrap' }}>
                    <span className="nxh-name">{s.name}</span>
                    <Chip text={PROVIDER_LABEL[s.provider]} />
                    <Chip text={s.scope} tone={s.scope === 'project' ? 'accent' : 'quiet'} />
                  </div>
                  {s.description && (
                    <p className="nxh-note">
                      {s.description.length > 220 ? `${s.description.slice(0, 220)}…` : s.description}
                    </p>
                  )}
                  <div className="nxh-path">{s.path}</div>
                  <div className="nxh-row">
                    <button type="button" onClick={() => void window.cth.skillsReveal(s.path)} className={actionClass('quiet')}>
                      open folder
                    </button>
                    {s.scope === 'bundled' ? (
                      // Bundled skills ship inside the app and are re-copied into
                      // every agent on spawn, so "removing" one would silently come
                      // back. Say that instead of offering a button that lies.
                      <span className="nxh-muted">ships with the app</span>
                    ) : confirming === s.path ? (
                      <>
                        <button type="button" onClick={() => void uninstall(s)} className={actionClass('danger')}>
                          delete {s.name}?
                        </button>
                        <button type="button" onClick={() => setConfirming(null)} className={actionClass('quiet')}>cancel</button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirming(s.path)}
                        disabled={action[s.path]?.busy}
                        className={actionClass('quiet')}
                      >{action[s.path]?.busy ? 'removing…' : 'uninstall'}</button>
                    )}
                    {action[s.path]?.error && (
                      <span className="nxh-error" role="alert">{action[s.path]?.error}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )
        ) : catalog === null ? <Muted>Loading the catalog…</Muted>
        : (
          <>
            {catalogMeta?.error && (
              <div className="nxh-callout" data-tone="bad" role="status">
                Showing a cached copy — {catalogMeta.error}.
              </div>
            )}
            <p className="nxh-muted">
              {totalMatching} matching{totalMatching > shownCatalog.length ? ` · showing the first ${shownCatalog.length}` : ''}
              {' · '}curated by abubakarsiddik31/claude-skills-collection
            </p>
            <div className="nxh-list">
              {shownCatalog.map((s) => (
                <div key={s.url + s.name} className="nxh-card">
                  <div className="nxh-row" style={{ flexWrap: 'nowrap' }}>
                    <span className="nxh-name">{s.name}</span>
                    <Chip text={s.category} />
                    <Chip text={s.owner} />
                  </div>
                  <p className="nxh-note">{s.description}</p>
                  <div className="nxh-row">
                    <button
                      type="button"
                      onClick={() => void install(s)}
                      disabled={!!action[s.url]?.busy || !!action[s.url]?.done}
                      className={actionClass(action[s.url]?.done ? 'quiet' : 'primary')}
                    >
                      {action[s.url]?.busy ? 'installing…' : action[s.url]?.done ?? 'install'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void window.cth.openExternal(s.url)}
                      className={actionClass('quiet')}
                    >learn more</button>
                    {action[s.url]?.error && (
                      <span className="nxh-error nxh-grow" role="alert">{action[s.url]?.error}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="nxh-muted" role="status">{children}</p>;
}
