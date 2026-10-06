import { useEffect, useId, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import { leadAgentId, visibleAgents } from '@shared/agentDisplay';
import { Button } from '../../ui/Button';
import { useAgentDisplay } from '../agentIdentity';
import { requestBody } from './teamModel';

/** The request box's draft, held by the workbench frame so it survives
 *  switching sections. `suggest` is an agent id, or '' for no suggestion. */
export interface RequestDraft { text: string; suggest: string }

/** Requests: everything the human asks for goes to the lead agent, never
 *  straight into another agent's inbox. The lead agent writes the task card
 *  and assigns it; a suggested agent is forwarded as a hint it may ignore. */
export function RequestsSection({ draft, onDraft }: { draft: RequestDraft; onDraft: (d: RequestDraft) => void }) {
  const allAgents = useStore((s) => s.agents);
  const { display, hint } = useAgentDisplay();
  const agents = visibleAgents(allAgents, hint);
  const leadId = leadAgentId(allAgents, hint);
  const others = agents.filter((a) => a.id !== leadId && !a.isGod);
  const labelOf = (id: string): string => display.get(id)?.label ?? 'Agent';
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (clearTimer.current) clearTimeout(clearTimer.current); }, []);
  const textId = useId();
  const suggestId = useId();
  const helpId = useId();

  const send = async (): Promise<void> => {
    if (!draft.text.trim() || sending) return;
    const picked = draft.suggest ? others.find((a) => a.id === draft.suggest) : undefined;
    const suggested = picked ? { id: picked.id, label: labelOf(picked.id) } : undefined;
    setSending(true);
    try {
      const res = await window.cth.hiveSend(
        { to: 'god', act: 'request', subject: 'Task from the human', body: requestBody(draft.text, suggested) },
        'human'
      );
      if (res.ok) {
        onDraft({ text: '', suggest: '' });
        setResult(`Sent to the lead agent${suggested ? ` (suggesting ${suggested.label})` : ''}`);
      } else {
        setResult(`Could not send: ${res.error ?? 'unknown error'}`);
      }
    } catch (e) {
      setResult(`Could not send: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSending(false);
      if (clearTimer.current) clearTimeout(clearTimer.current);
      clearTimer.current = setTimeout(() => setResult(null), 6000);
    }
  };

  return (
    <div className="nxs">
      <div className="nxs__inner nxs__inner--narrow">
        <header className="nxs__head">
          <h3 className="nxs__title">Requests</h3>
          <p className="nxs__lede" id={helpId}>
            The lead agent breaks a request into tasks, writes the task cards and assigns them. Nothing is sent until you press Send to lead agent.
          </p>
        </header>
        <form
          className="nxs__group nxs-form"
          onSubmit={(e) => { e.preventDefault(); void send(); }}
        >
          <div className="nxs-field">
            <label className="nxs-label" htmlFor={textId}>Request for the lead agent</label>
            <textarea
              id={textId}
              className="nxs-textarea"
              rows={6}
              value={draft.text}
              aria-describedby={helpId}
              placeholder="Describe the work… (Ctrl+Enter to send)"
              onChange={(e) => onDraft({ ...draft, text: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }}
            />
          </div>
          <div className="nxs-field">
            <label className="nxs-label" htmlFor={suggestId}>Suggest an agent (optional)</label>
            <select id={suggestId} className="nxs-select" value={draft.suggest} onChange={(e) => onDraft({ ...draft, suggest: e.target.value })}>
              <option value="">No suggestion; the lead agent decides</option>
              {others.map((a) => <option key={a.id} value={a.id}>{labelOf(a.id)}</option>)}
            </select>
          </div>
          <div className="nxs-actions">
            <Button type="submit" variant="primary" icon="send" disabled={!draft.text.trim() || sending}>
              {sending ? 'Sending…' : 'Send to lead agent'}
            </Button>
            <span className="nxs__status" role="status">{result ?? ''}</span>
          </div>
        </form>
      </div>
    </div>
  );
}
