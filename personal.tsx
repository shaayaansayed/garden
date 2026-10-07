import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useAuiState, useExternalStoreRuntime, type ThreadMessageLike } from '@assistant-ui/react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowDown, ArrowUp, Check, ChevronRight, CircleAlert, Clock3, Copy, ExternalLink, History, Leaf, LockKeyhole, Menu, MessageCircleReply, MessageSquare, Square, Sun, X } from 'lucide-react';
import type { AgentRequest } from './personal-agent';
import type { SunsamaStatus } from './sunsama';
import type { EngageToday, Pick as EngagePick } from './engage';

const labels = { queued: 'Received', running: 'Working', done: 'Reply ready', unanswered: 'Needs attention' };
const active = (r: AgentRequest) => r.status === 'queued' || r.status === 'running';
const Actions = createContext<{ stop: (id: string) => Promise<void> }>({ stop: async () => {} });
const draftKey = 'personal-draft';
const timeZone = 'America/New_York';
type Draft = { id: string; message: string };
type View = 'agent' | 'activity' | 'engage';
const viewFor = (hash: string): View => hash === '#activity' ? 'activity' : hash === '#engage' ? 'engage' : 'agent';
function savedDraft(): Draft | null {
  try { const d = JSON.parse(sessionStorage.getItem(draftKey) || 'null'); return d && typeof d.id === 'string' && typeof d.message === 'string' ? d : null; } catch { return null; }
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch('/personal/' + path, { credentials: 'same-origin', signal: AbortSignal.timeout(30_000), ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  if (response.redirected || response.status === 401) throw new Error('Your session expired. Reload this page to sign in. Your draft is saved.');
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error || 'Could not reach the agent. Try again; your request ID will be reused.');
  }
  return response.json() as Promise<T>;
}
function errorText(error: unknown) { return error instanceof Error && error.name !== 'TimeoutError' ? error.message : 'Connection interrupted. Try again; your request ID will be reused.'; }
function Status({ status }: { status: AgentRequest['status'] }) {
  const Icon = status === 'done' ? Check : status === 'unanswered' ? CircleAlert : Clock3;
  return <span className={'status ' + status}><Icon size={14} aria-hidden="true" />{labels[status]}</span>;
}
function SunsamaConnection() {
  const [status, setStatus] = useState<SunsamaStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(() => {
    const url = new URL(location.href), outcome = url.searchParams.get('sunsama');
    if (outcome) { url.searchParams.delete('sunsama'); history.replaceState(null, '', url); }
    return outcome === 'error' ? 'Sign-in was not completed. Try connecting again.' : '';
  });
  const [notice, setNotice] = useState('');
  const refresh = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let disposed = false, running = false, timer: ReturnType<typeof setTimeout>;
    refresh.current = async () => {
      if (disposed || running) return;
      running = true; clearTimeout(timer);
      try {
        const next = await api<SunsamaStatus>('integrations/sunsama');
        if (!disposed) {
          setStatus(next);
          if (next.state === 'connecting') timer = setTimeout(() => void refresh.current(), 3000);
        }
      } catch { if (!disposed) setError('Could not check Sunsama. Try connecting again.'); }
      finally { running = false; }
    };
    const visible = () => { if (!document.hidden) void refresh.current(); };
    document.addEventListener('visibilitychange', visible);
    void refresh.current();
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, []);
  async function connect() {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api<{ state: string; authUrl?: string }>('integrations/sunsama/connect', {});
      if (result.authUrl) { location.assign(result.authUrl); return; }
      await refresh.current();
    } catch (e) { setError(e instanceof Error && e.name !== 'TimeoutError' ? e.message : 'Connection interrupted. Try connecting again.'); }
    finally { setBusy(false); }
  }
  async function disconnect() {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api<{ revoked: boolean }>('integrations/sunsama/disconnect', {});
      setStatus({ state: 'disconnected', tools: 0 });
      setNotice(result.revoked ? 'Disconnected.' : 'Disconnected here. Remove this connection in Sunsama too; revocation could not be confirmed.');
    } catch (e) { setError(e instanceof Error && e.name !== 'TimeoutError' ? e.message : 'Could not confirm disconnection. Try again.'); }
    finally { setBusy(false); }
  }
  const connected = status?.state === 'ready';
  const label = !status ? 'Checking connection…' : connected ? 'Connected' : status.state === 'connecting' ? 'Connecting…' : status.state === 'authenticating' ? 'Sign-in needed' : status.state === 'failed' ? 'Connection needs attention' : 'Plan and update your tasks';
  return <section className="sunsama-connection" aria-label="Sunsama connection">
    <h2><Sun size={17} aria-hidden="true" />Sunsama</h2>
    <p role="status">{label}{connected && <Check size={13} aria-hidden="true" />}</p>
    {connected ? <button className="quiet" disabled={busy} onClick={() => void disconnect()}>{busy ? 'Disconnecting…' : 'Disconnect Sunsama'}</button> : <button className="connect-button" disabled={busy} onClick={() => void connect()}>{busy ? 'Connecting…' : status?.state === 'authenticating' ? 'Continue Sunsama sign-in' : 'Connect Sunsama'}</button>}
    {!connected && status && status.state !== 'disconnected' && <button className="quiet" disabled={busy} onClick={() => void disconnect()}>Disconnect</button>}
    {error && <p className="connection-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
function Message() {
  const message = useAuiState(s => s.message);
  const row = message.metadata.custom?.request as AgentRequest;
  const user = message.role === 'user';
  const { stop } = useContext(Actions);
  const [stopping, setStopping] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const text = message.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
  return <MessagePrimitive.Root className={'message ' + (user ? 'user' : 'assistant')} id={user ? 'request-' + row.id : undefined}>
    <div className="message-heading"><span className="speaker">{user ? 'You' : <><Leaf size={16} aria-hidden="true" />Personal agent</>}</span>{user ? <time dateTime={row.created}>{new Date(row.created).toLocaleString([], { timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time> : <Status status={row.status} />}</div>
    <div className="message-body">{user ? <p className="verbatim">{text}</p> : <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>, img: ({ alt }) => <span>{alt || 'Image omitted'}</span> }}>{text}</Markdown>}</div>
    {!user && <div className="message-actions">{active(row) ? <button className="quiet" disabled={stopping} onClick={async () => { setStopping(true); try { await stop(row.id); } finally { setStopping(false); } }}><Square size={13} aria-hidden="true" />{stopping ? 'Stopping…' : 'Stop task'}</button> : text && <button className="quiet" onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setCopyError(false); setTimeout(() => setCopied(false), 2000); } catch { setCopyError(true); } }}><Copy size={14} aria-hidden="true" />{copyError ? 'Select text to copy' : copied ? 'Copied' : 'Copy reply'}</button>}</div>}
  </MessagePrimitive.Root>;
}
// Engage: an inbox of today's posts worth a reply. Reply, Done, or Skip marks a post handled; marks live in this browser for the day.
const laneNames: Record<string, string> = {
  'ai evaluation': 'AI evaluation', 'ai care delivery': 'AI in care delivery', 'ai adoption': 'AI adoption', quality: 'Quality measures',
  'clinical ops': 'Clinical ops', 'clinical workflows': 'Clinical workflows', 'value based care': 'Value-based care', 'payer pharmacy': 'Payers and pharmacy',
  'provider economics': 'Provider economics', 'public programs': 'Medicare and Medicaid', 'healthtech business': 'Health tech business', robotics: 'Robotics',
  'ai technical': 'General AI', 'startup general': 'Startups', 'healthcare other': 'Healthcare',
};
const angleVerbs: Record<string, string> = { 'ask question': 'Ask', 'add evidence': 'Add evidence', 'push back': 'Push back', 'share experience': 'Share experience' };
const hookPhrases: Record<string, string> = { 'unstated assumption': 'about the unstated assumption', 'missing tradeoff': 'on the missing tradeoff', mechanism: 'on how it actually works',
  'data context': 'on what the numbers leave out', implementation: 'on how it plays out in practice' };
const compact = (n?: number) => n === undefined ? '' : n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1e3)}k` : String(n);
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { timeZone, hour: 'numeric', minute: '2-digit' });
// Pulls run at 17:00 and 22:00 UTC (wrangler.jsonc); show the next one in New York time.
function nextPull(now = new Date()) {
  const slots = [17, 22, 41].map(h => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h));
  return clock(new Date(slots.find(t => t > now.getTime())!).toISOString());
}

type MarkState = 'replied' | 'done' | 'skipped';
type Marks = Record<string, { state: MarkState; at: string }>;
const markLabels: Record<MarkState, string> = { replied: 'Replied', done: 'Done', skipped: 'Skipped' };
function useMarks(date?: string) {
  const key = 'engage:marks:' + date;
  const [marks, setMarks] = useState<Marks>({});
  useEffect(() => {
    if (!date) return;
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k?.startsWith('engage:marks:') && k !== key) localStorage.removeItem(k); }
      setMarks(JSON.parse(localStorage.getItem(key) || '{}'));
    } catch { setMarks({}); }
  }, [key]);
  // Functional updates so quick successive marks never overwrite each other.
  const update = (fn: (prev: Marks) => Marks) => setMarks(prev => { const next = fn(prev); try { localStorage.setItem(key, JSON.stringify(next)); } catch {} return next; });
  return { marks, mark: (id: string, state: MarkState) => update(prev => ({ ...prev, [id]: { state, at: new Date().toISOString() } })),
    unmark: (id: string) => update(prev => { const { [id]: _, ...rest } = prev; return rest; }) };
}

// Post text: real links and @mentions become links (React escapes everything else), long posts clamp with a toggle.
const TOKEN = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?]|(?<![\w@])@\w{1,15})/g;
const linkify = (text: string) => text.split(TOKEN).map((part, i) => i % 2 === 0 ? part
  : <a key={i} href={part.startsWith('@') ? `https://x.com/${part.slice(1)}` : part} target="_blank" rel="noopener noreferrer">
    {part.startsWith('@') ? part : (s => s.length > 40 ? s.slice(0, 39) + '…' : s)(part.replace(/^https?:\/\/(www\.)?/, ''))}</a>);
function PostText({ text, open, onToggle, oneLine }: { text: string; open: boolean; onToggle: () => void; oneLine?: boolean }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current; if (!el || open || oneLine) return;
    const check = () => setLong(el.scrollHeight > el.clientHeight + 1);
    check(); const ro = new ResizeObserver(check); ro.observe(el); return () => ro.disconnect();
  }, [text, open, oneLine]);
  return <><p ref={ref} className={'pick-text' + (oneLine ? ' one-line' : open ? '' : ' clamped')}>{linkify(text.replace(/\n\s*\n+/g, '\n'))}</p>
    {!oneLine && (long || open) && <button className="text-toggle" aria-expanded={open} onClick={onToggle}>{open ? 'Show less' : 'Show more'}</button>}</>;
}

function PickRow({ p, rank, pullAt, mark, selected, expanded, onSelect, onToggle, onMark, onUndo, rowRef }: {
  p: EngagePick; rank: number; pullAt: string; mark?: Marks[string]; selected: boolean; expanded: boolean;
  onSelect: () => void; onToggle: () => void; onMark: (s: MarkState) => void; onUndo: () => void; rowRef: (el: HTMLLIElement | null) => void;
}) {
  const posted = Date.parse(pullAt) - p.ageHours * 3_600_000, hours = Math.max(0, Math.round((Date.now() - posted) / 3_600_000));
  const verb = angleVerbs[p.angle], hook = hookPhrases[p.hook];
  return <li ref={rowRef} id={'pick-' + p.id} tabIndex={selected ? 0 : -1} aria-current={selected || undefined} onClick={e => { onSelect(); if (e.target === e.currentTarget || !(e.target as HTMLElement).closest('a, button')) e.currentTarget.focus({ preventScroll: true }); }}
    className={'pick' + (selected ? ' selected' : '') + (mark ? ' handled' : '')}>
    <span className="rank" aria-hidden="true">{mark ? (mark.state === 'skipped' ? '–' : <Check size={14} />) : rank}</span>
    <div className="pick-body">
      <div className="pick-head"><strong>{p.name}</strong><span>@{p.handle}</span>
        {p.followers !== undefined && <span className="num" aria-label={`${compact(p.followers)} followers`}>{compact(p.followers)}</span>}
        <time className="num" dateTime={new Date(posted).toISOString()}>{hours < 1 ? 'now' : `${hours}h`}</time>
        <span className={'num' + (p.replies >= 20 ? ' crowded' : '')}>{p.replies} {p.replies === 1 ? 'reply' : 'replies'}</span>
        <span className="lane">{laneNames[p.lane] ?? p.lane}</span></div>
      <PostText text={p.text} open={expanded} onToggle={onToggle} oneLine={!!mark} />
      {mark ? <p className="pick-status">{markLabels[mark.state]} {clock(mark.at)} <button className="link" onClick={e => { e.stopPropagation(); onUndo(); }}>Undo</button></p> : <>
        {verb && <p className="angle"><MessageCircleReply size={16} aria-hidden="true" /><strong>{verb}</strong>{hook && <span>{hook}</span>}</p>}
        <div className="pick-actions">
          <a className="reply" href={p.url} target="_blank" rel="noopener noreferrer" onClick={() => onMark('replied')}>Reply on X<ExternalLink size={15} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a>
          <button className="ghost bordered" onClick={e => { e.stopPropagation(); onMark('done'); }}>Done</button>
          <button className="ghost" onClick={e => { e.stopPropagation(); onMark('skipped'); }}>Skip</button>
          {selected && <span className="keys" aria-hidden="true"><kbd>j</kbd><kbd>k</kbd> move <kbd>↵</kbd> reply <kbd>d</kbd> done <kbd>s</kbd> skip <kbd>u</kbd> undo</span>}
        </div></>}
    </div>
  </li>;
}

function EngageView() {
  const [today, setToday] = useState<EngageToday>();
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string>();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [openPulls, setOpenPulls] = useState<Record<string, boolean>>({});
  const [said, setSaid] = useState('');
  const last = useRef<string | undefined>(undefined);
  const rows = useRef(new Map<string, HTMLLIElement>());
  const { marks, mark, unmark } = useMarks(today?.date);
  const load = useRef(async () => {});
  load.current = async () => { try { setToday(await api<EngageToday>('engage/today')); setError(''); } catch (e) { setError(errorText(e)); } };
  useEffect(() => {
    void load.current();
    const timer = setInterval(() => { if (!document.hidden) void load.current(); }, 300_000);
    const onShow = () => { if (!document.hidden) void load.current(); };
    document.addEventListener('visibilitychange', onShow);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onShow); };
  }, []);
  const pulls = [...(today?.pulls ?? [])].reverse();
  const all = pulls.flatMap(pull => pull.picks.map(p => ({ p, pull })));
  const open = all.filter(({ p }) => !marks[p.id]).length;
  const visible = all.filter(({ p, pull }) => openPulls[pull.at] || pull.picks.some(x => !marks[x.id]));
  const act = (id: string, state: MarkState) => { mark(id, state); last.current = id; setSaid(`${markLabels[state]}.`); };
  const undo = (id = last.current) => { if (id && marks[id]) { unmark(id); setSaid('Marked open again.'); } };
  const move = (step: number) => {
    const i = visible.findIndex(({ p }) => p.id === selected), next = visible[Math.min(visible.length - 1, Math.max(0, i + step))];
    if (!next) return;
    setSelected(next.p.id);
    const el = rows.current.get(next.p.id); el?.focus({ preventScroll: true }); el?.scrollIntoView({ block: 'nearest' });
  };
  // Shortcuts listen on the window while this tab is open, so j works before any row has focus. Text fields are left alone.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => { const h = (e: KeyboardEvent) => keyRef.current(e); window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, []);
  keyRef.current = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (e.metaKey || e.ctrlKey || e.altKey || target.closest('input, textarea, [contenteditable], [role="dialog"]')) return;
    if (e.key === 'Enter' && target.tagName !== 'LI' && target.tagName !== 'BODY') return;
    const current = visible.find(({ p }) => p.id === selected)?.p;
    const keys: Record<string, () => void> = {
      j: () => move(1), ArrowDown: () => move(1), k: () => move(-1), ArrowUp: () => move(-1),
      Enter: () => { if (current && !marks[current.id]) { window.open(current.url, '_blank', 'noopener'); act(current.id, 'replied'); } },
      o: () => { if (current && !marks[current.id]) { window.open(current.url, '_blank', 'noopener'); act(current.id, 'replied'); } },
      d: () => { if (current && !marks[current.id]) act(current.id, 'done'); }, s: () => { if (current && !marks[current.id]) act(current.id, 'skipped'); },
      u: () => undo(), e: () => { if (current) setExpanded(x => ({ ...x, [current.id]: !x[current.id] })); },
    };
    const run = keys[e.key];
    if (run) { e.preventDefault(); run(); }
  };
  return <section className="activity engage" aria-labelledby="engage-title">
    <header className="engage-top"><h1 id="engage-title">Engage</h1>
      {today && <p className="engage-status num">{all.length ? (open ? <><strong>{open} open</strong> of {all.length} today</> : <strong>All {all.length} handled</strong>) : 'Nothing yet today'} · next pull about {nextPull()}</p>}</header>
    <div className="sr-only" role="status" aria-live="polite">{said}</div>
    {error && <div className="engage-error" role="alert"><CircleAlert size={16} aria-hidden="true" /><span>Couldn’t load today’s posts. {error}</span><button className="ghost" onClick={() => void load.current()}>Try again</button></div>}
    {!today && !error ? <ol className="picks" aria-busy="true" aria-label="Loading today’s posts">{[0, 1, 2].map(i => <li key={i} className="pick skeleton"><span /><span /><span /></li>)}</ol>
      : today && !pulls.length ? <p className="engage-empty">Nothing yet today. The first pull lands about {nextPull()}.</p>
      : pulls.map(pull => {
        const left = pull.picks.filter(p => !marks[p.id]).length, collapsed = pull.picks.length > 0 && !left && !openPulls[pull.at];
        return <section key={pull.at} className="pull" aria-labelledby={'pull-' + pull.at}>
          <h2 id={'pull-' + pull.at} className="pull-head num"><span className="pull-time">{clock(pull.at)}</span><span className="pull-meta">{pull.picks.length} picks · {pull.scanned} scanned</span>
            <span className="pull-open">{!pull.picks.length ? '' : left ? `${left} open` : <button className="link" aria-expanded={!collapsed} onClick={() => setOpenPulls(x => ({ ...x, [pull.at]: !x[pull.at] }))}>All handled{collapsed ? ', show' : ', hide'}</button>}</span></h2>
          {!pull.picks.length ? <p className="engage-empty">Nothing worth a reply in this pull.</p> : !collapsed && <ol className="picks">{pull.picks.map((p, i) =>
            <PickRow key={p.id} p={p} rank={i + 1} pullAt={pull.at} mark={marks[p.id]} selected={selected === p.id} expanded={!!expanded[p.id]}
              rowRef={el => { if (el) rows.current.set(p.id, el); else rows.current.delete(p.id); }}
              onSelect={() => setSelected(p.id)} onToggle={() => setExpanded(x => ({ ...x, [p.id]: !x[p.id] }))}
              onMark={s => act(p.id, s)} onUndo={() => undo(p.id)} />)}</ol>}
        </section>;
      })}
  </section>;
}

function App() {
  const pending = useRef<Draft | null>(savedDraft());
  const [draft, setDraft] = useState(pending.current?.message || '');
  const [rows, setRows] = useState<AgentRequest[]>([]);
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [error, setError] = useState('');
  const [syncError, setSyncError] = useState('');
  const [notice, setNotice] = useState('');
  const [view, setView] = useState<View>(viewFor(location.hash));
  const [menu, setMenu] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!menu) return;
    const previous = document.activeElement as HTMLElement;
    const targets = () => [...sidebar.current!.querySelectorAll<HTMLElement>('a,button')].filter(e => e.offsetParent !== null);
    targets()[0]?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setMenu(false); }
      if (e.key === 'Tab') { const list = targets(), first = list[0], last = list.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, [menu]);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const count = rows.filter(active).length;
  useEffect(() => {
    if (view !== 'agent' || loading || !location.hash.startsWith('#request-')) return;
    const timer = setTimeout(() => document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'center' }), 100);
    return () => clearTimeout(timer);
  }, [view, loading]);
  useEffect(() => {
    const onHash = () => { setView(viewFor(location.hash)); setMenu(false); };
    addEventListener('hashchange', onHash); return () => removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    let disposed = false, busy = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (busy || disposed) return;
      busy = true; clearTimeout(timer);
      try {
        const history = await api<AgentRequest[]>('requests');
        const merged = new Map([...rowsRef.current, ...history].map(r => [r.id, r]));
        for (const row of merged.values()) if (active(row)) merged.set(row.id, await api<AgentRequest>('requests/' + row.id));
        if (!disposed) {
          const next = [...merged.values()].sort((a, b) => a.created.localeCompare(b.created));
          const changed = next.filter(r => rowsRef.current.some(old => old.id === r.id && old.status !== r.status));
          if (changed.length) setNotice(changed.map(r => labels[r.status]).join('. '));
          setRows(prev => JSON.stringify(prev) === JSON.stringify(next) ? prev : next);
          setLoading(false); setSyncError('');
        }
      } catch (e) { if (!disposed) { setSyncError(errorText(e)); setLoading(false); } }
      finally { busy = false; if (!disposed) timer = setTimeout(refresh, rowsRef.current.some(active) ? 3000 : 15000); }
    };
    refreshRef.current = refresh;
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', visible); window.addEventListener('online', visible);
    void refresh();
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('online', visible); };
  }, []);
  function saveDraft(message: string) {
    setDraft(message);
    if (!pending.current || pending.current.message !== message.trim()) pending.current = { id: crypto.randomUUID(), message: message.trim() };
    try { sessionStorage.setItem(draftKey, JSON.stringify({ ...pending.current, message })); } catch {}
  }
  async function submit(message: string) {
    message = message.trim(); if (!message || sendingRef.current) return;
    if (!pending.current || pending.current.message.trim() !== message) pending.current = { id: crypto.randomUUID(), message };
    const request = { ...pending.current, message };
    try { sessionStorage.setItem(draftKey, JSON.stringify(request)); } catch {}
    sendingRef.current = true; setSending(true); setError(''); setNotice('Sending…');
    try {
      const row = await api<AgentRequest>('requests', request);
      setRows(prev => [...prev.filter(r => r.id !== row.id), row].sort((a, b) => a.created.localeCompare(b.created)));
      pending.current = null; setDraft(''); try { sessionStorage.removeItem(draftKey); } catch {}
      setNotice('Received. The agent will reply here; you can leave this page.');
      void refreshRef.current();
    } catch (e) { setError(errorText(e)); setNotice(''); }
    finally { sendingRef.current = false; setSending(false); input.current?.focus(); }
  }
  const messages = useMemo<ThreadMessageLike[]>(() => rows.flatMap(row => [
    { id: row.id + '-user', role: 'user', content: [{ type: 'text', text: row.message }], createdAt: new Date(row.created), metadata: { custom: { request: row } } },
    { id: row.id + '-assistant', role: 'assistant', content: [{ type: 'text', text: row.text || row.reason || (row.status === 'queued' ? 'Your message is saved and waiting for the agent.' : row.status === 'running' ? 'Working on your message. You can leave this page and return for the reply.' : 'No response was returned.') }], status: active(row) ? { type: 'running' } : { type: 'complete', reason: 'stop' }, metadata: { custom: { request: row } } },
  ]), [rows]);
  const runtime = useExternalStoreRuntime({ messages, convertMessage: (message: ThreadMessageLike) => message, isRunning: count > 0, onNew: async m => { await submit(m.content.filter(p => p.type === 'text').map(p => p.text).join('\n')); } });
  async function stop(id: string) {
    try { await api('requests/' + id + '/cancel', {}); setNotice('Stop requested. Any completed edits remain saved.'); await refreshRef.current(); } catch (e) { setError(errorText(e)); }
  }
  return <AssistantRuntimeProvider runtime={runtime}><Actions.Provider value={{ stop }}><div className="portal">
    <a className="skip" href="#main">Skip to content</a>
    <aside ref={sidebar} role={menu ? "dialog" : undefined} aria-modal={menu || undefined} className={'sidebar ' + (menu ? 'open' : '')} aria-label="Workspace navigation">
      <div className="brand"><span className="brand-mark"><Leaf size={23} aria-hidden="true" /></span><span>Shay’s Space<small>Personal</small></span><button className="icon mobile-close" aria-label="Close navigation" onClick={() => setMenu(false)}><X size={20} /></button></div>
      <nav aria-label="Personal"><a href="#agent" aria-current={view === 'agent' ? 'page' : undefined} onClick={() => setMenu(false)}><MessageSquare size={18} aria-hidden="true" />Agent<ChevronRight className="nav-arrow" size={15} /></a><a href="#activity" aria-current={view === 'activity' ? 'page' : undefined} onClick={() => setMenu(false)}><History size={18} aria-hidden="true" />Activity{count > 0 && <span className="count">{count}</span>}</a><a href="#engage" aria-current={view === 'engage' ? 'page' : undefined} onClick={() => setMenu(false)}><MessageCircleReply size={18} aria-hidden="true" />Engage</a></nav>
      <SunsamaConnection />
      <div className="sidebar-note"><p>A little room for everything.</p><span>Your notes, questions, and things to take care of.</span></div>
      <div className="sidebar-bottom"><LockKeyhole size={15} aria-hidden="true" /><span>Private workspace</span><a href="/" aria-label="Go to public site">Public site</a></div>
    </aside>
    {menu && <button className="scrim" aria-label="Close navigation" onClick={() => setMenu(false)} />}
    <main id="main" inert={menu} className="workspace" tabIndex={-1}>
      <header className="toolbar"><div className="page-title"><button className="icon mobile-menu" aria-label="Open navigation" aria-expanded={menu} onClick={() => setMenu(true)}><Menu size={21} /></button><span>Personal <span className="separator">/</span> <strong>{view === 'agent' ? 'Agent' : view === 'engage' ? 'Engage' : 'Activity'}</strong></span></div><span className="connection"><span className={count ? 'dot working' : 'dot'} />{count ? `${count} working` : 'Obsidian vault'}</span></header>
      {(error || syncError) && <div className="error" role="alert"><CircleAlert size={18} /><span>{error || syncError}</span><button className="quiet" onClick={() => void refreshRef.current()}>Reconnect</button></div>}
      <div className="sr-only" role="status" aria-live="polite">{notice}</div>
      {view === 'agent' ? <ThreadPrimitive.Root className="thread"><ThreadPrimitive.Viewport className="conversation">
        <div className="transcript">{loading ? <p className="empty-status">Loading messages…</p> : !rows.length ? <div className="welcome"><Leaf size={32} strokeWidth={1.3} /><h1>What’s on your mind?</h1><p>A note to remember, a question to explore,<br />or something to take off your list.</p><div className="suggestions">{['Help me catch up on my journal', 'Summarize my recent notes'].map(s => <button key={s} onClick={() => { saveDraft(s); input.current?.focus(); }}>{s}<ArrowUp size={16} /></button>)}</div></div> : <><p className="history-note">Recent conversation <span>Messages from you and Instinct</span></p><ThreadPrimitive.Messages components={{ Message }} /></>}</div>
        <ThreadPrimitive.ViewportFooter className="scroll-footer"><ThreadPrimitive.ScrollToBottom className="scroll-bottom" aria-label="Jump to latest message"><ArrowDown size={17} /></ThreadPrimitive.ScrollToBottom></ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport><div className="composer-area"><form id="compose" onSubmit={e => { e.preventDefault(); void submit(draft); }}><label htmlFor="message">Message</label><textarea ref={input} id="message" name="message" value={draft} onChange={e => saveDraft(e.target.value)} placeholder="Ask, remember, or hand something off…" rows={2} maxLength={8000} required readOnly={sending} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(draft); } }} /><div className="composer-bottom"><span>Works with your Obsidian vault</span><button id="send" className="send" type="submit" disabled={!draft.trim() || sending}>{sending ? 'Sending…' : 'Send message'}<ArrowUp size={16} /></button></div></form><div className="composer-hint"><span>{notice || 'A reply confirms the outcome of each request.'}</span><kbd>⌘ / Ctrl + Enter</kbd></div></div></ThreadPrimitive.Root> : view === 'engage' ? <EngageView /> : <section className="activity"><h1>Activity</h1><p className="lede">Recent requests and their outcomes.</p>{loading ? <p>Loading activity…</p> : !rows.length ? <p>No messages yet. <a href="#agent">Send your first message</a>.</p> : <div className="activity-list">{[...rows].reverse().map(row => <a key={row.id} className="activity-row" href={'#request-' + row.id} onClick={() => { setView('agent'); setTimeout(() => document.getElementById('request-' + row.id)?.scrollIntoView({ block: 'center' }), 80); }}><div><Status status={row.status} /><time dateTime={row.created}>{new Date(row.created).toLocaleString([], { timeZone })}</time></div><p>{row.message}</p><ChevronRight size={18} /></a>)}</div>}<p className="activity-hint">“Reply ready” means the agent responded. Read the reply to confirm any edits.</p></section>}
    </main>
  </div></Actions.Provider></AssistantRuntimeProvider>;
}
createRoot(document.getElementById('root')!).render(<App />);
