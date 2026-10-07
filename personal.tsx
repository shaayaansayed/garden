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
// Engage: today's posts worth a reply, one section per scheduled pull, newest pull first.
const laneNames: Record<string, string> = {
  'ai evaluation': 'AI evaluation', 'ai care delivery': 'AI in care delivery', 'ai adoption': 'AI adoption', quality: 'Quality measures',
  'clinical ops': 'Clinical ops', 'clinical workflows': 'Clinical workflows', 'value based care': 'Value-based care', 'payer pharmacy': 'Payers and pharmacy',
  'provider economics': 'Provider economics', 'public programs': 'Medicare and Medicaid', 'healthtech business': 'Health tech business', robotics: 'Robotics',
  'ai technical': 'General AI', 'startup general': 'Startups', 'healthcare other': 'Healthcare',
};
const angleVerbs: Record<string, string> = { 'ask question': 'Ask about', 'add evidence': 'Add evidence on', 'push back': 'Push back on', 'share experience': 'Share experience on' };
const hookPhrases: Record<string, string> = { 'unstated assumption': 'the unstated assumption', 'missing tradeoff': 'the missing tradeoff', mechanism: 'how it actually works',
  'data context': 'what the numbers leave out', implementation: 'how it plays out in practice' };
const compact = (n?: number) => n === undefined ? '' : n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1e3)}k` : String(n);
function replyIdea(p: EngagePick) {
  const verb = angleVerbs[p.angle], hook = hookPhrases[p.hook];
  return verb && hook ? `${verb} ${hook}.` : verb ? `${verb} the main claim.` : '';
}
// Post text: real links and @mentions become links (React escapes everything else), long posts clamp with a toggle.
const TOKEN = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?]|(?<![\w@])@\w{1,15})/g;
const linkify = (text: string) => text.split(TOKEN).map((part, i) => i % 2 === 0 ? part
  : <a key={i} href={part.startsWith('@') ? `https://x.com/${part.slice(1)}` : part} target="_blank" rel="noopener noreferrer">
    {part.startsWith('@') ? part : (s => s.length > 40 ? s.slice(0, 39) + '…' : s)(part.replace(/^https?:\/\/(www\.)?/, ''))}</a>);
function PostText({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false), [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current; if (!el || open) return;
    const check = () => setLong(el.scrollHeight > el.clientHeight + 1);
    check(); const ro = new ResizeObserver(check); ro.observe(el); return () => ro.disconnect();
  }, [text, open]);
  return <><p ref={ref} className={open ? 'pick-text' : 'pick-text clamped'}>{linkify(text.replace(/\n\s*\n+/g, '\n'))}</p>
    {(long || open) && <button className="quiet more" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Show more'}</button>}</>;
}
function EngageView() {
  const [today, setToday] = useState<EngageToday>();
  const [error, setError] = useState('');
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
  return <section className="activity engage" aria-labelledby="engage-title">
    <h1 id="engage-title">Engage</h1>
    <p className="lede">Posts from your feed worth a reply today. New posts arrive around 1pm and 6pm, and the list starts fresh each morning.</p>
    {error && <div className="engage-error" role="alert"><CircleAlert size={16} aria-hidden="true" /><span>Couldn’t load today’s posts. {error}</span><button className="quiet" onClick={() => void load.current()}>Try again</button></div>}
    {!today && !error ? <p className="empty-status">Loading today’s posts…</p>
      : today && !pulls.length ? <p className="engage-empty">Nothing pulled yet today. The first pull runs around 1pm New York time.</p>
      : pulls.map(pull => {
        const label = new Date(pull.at).toLocaleTimeString([], { timeZone, hour: 'numeric', minute: '2-digit' });
        return <section key={pull.at} className="pull" aria-labelledby={'pull-' + pull.at}>
          <h2 id={'pull-' + pull.at}>{label} pull</h2>
          <p className="pull-meta">{pull.picks.length} of {pull.scanned} posts scanned</p>
          {!pull.picks.length ? <p className="engage-empty">Nothing worth a reply in this pull.</p> : <ol className="picks">{pull.picks.map(p => {
            const hours = Math.max(0, Math.round((Date.now() - Date.parse(pull.at)) / 3_600_000 + p.ageHours));
            const idea = replyIdea(p);
            return <li key={p.id} className="pick">
              <div className="pick-head"><strong>{p.name}</strong><span>@{p.handle}</span>{p.followers !== undefined && <span>{compact(p.followers)} followers</span>}<time>{hours < 1 ? 'just now' : `${hours}h ago`}</time><span className="lane">{laneNames[p.lane] ?? p.lane}</span></div>
              <PostText text={p.text} />
              <div className="pick-foot">{idea ? <p className="idea"><MessageCircleReply size={15} aria-hidden="true" />{idea}</p> : <span />}<a className="reply" href={p.url} target="_blank" rel="noopener noreferrer">Reply on X<ExternalLink size={15} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a></div>
            </li>;
          })}</ol>}
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
