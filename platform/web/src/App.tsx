import { useEffect, useMemo, useState } from "react";
import {
  IconActivityHeartbeat, IconArrowLeft, IconBox, IconCheck, IconChevronDown,
  IconCircleCheckFilled, IconClipboard, IconCopy, IconExternalLink,
  IconGlobe, IconKey, IconLink, IconLoader2, IconMenu2, IconPlayerPause,
  IconPlus, IconServer2, IconShield, IconTerminal2, IconTrash, IconX,
} from "@tabler/icons-react";
import {
  createInstance, createPairingCode, deleteInstance, issueToken, listInstances,
  getCurrentUser, openInstance, redeemInvite, suspendInstance, type CurrentUser,
  type Instance, type InstanceStatus,
} from "./api";
import { authClient } from "./auth-client";

type View = "instances" | "activity" | "security" | "new";

const statusCopy: Record<InstanceStatus, string> = {
  pending: "Pending", provisioning: "Provisioning", awaiting_agent: "Awaiting agent",
  connecting: "Connecting", online: "Online", degraded: "Degraded", offline: "Offline",
  suspending: "Suspending", suspended: "Suspended", deleting: "Deleting",
  delete_failed: "Delete failed", deleted: "Deleted",
};

function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds} seconds ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes ago`;
  return `${Math.round(seconds / 3600)} hours ago`;
}

function Status({ value }: { value: InstanceStatus }) {
  return <span className={`status status-${value}`}><span className="status-dot" />{statusCopy[value]}</span>;
}

function Sidebar({ view, setView, open, close }: { view: View; setView: (view: View) => void; open: boolean; close: () => void }) {
  const items = [
    { id: "instances" as const, label: "Instances", icon: IconServer2 },
    { id: "activity" as const, label: "Activity", icon: IconActivityHeartbeat },
    { id: "security" as const, label: "Security", icon: IconShield },
  ];
  return <aside className={`sidebar ${open ? "sidebar-open" : ""}`}>
    <button className="mobile-close" onClick={close} aria-label="Close navigation"><IconX /></button>
    <div className="brand"><img src="/logo.png" alt="" /><div><strong>opencodex</strong><span>Remote</span></div></div>
    <nav aria-label="Primary navigation">
      {items.map(({ id, label, icon: Icon }) => <button key={id} className={view === id || (view === "new" && id === "instances") ? "active" : ""} onClick={() => { setView(id); close(); }}><Icon /><span>{label}</span></button>)}
    </nav>
    <button className="collapse"><IconArrowLeft /><span>Collapse</span></button>
  </aside>;
}

function HealthNode({ icon: Icon, title, value, ok = true }: { icon: typeof IconBox; title: string; value: string; ok?: boolean }) {
  return <div className="health-node">
    <div className="health-icon"><Icon /><span className={ok ? "check" : "warn"}>{ok ? <IconCheck /> : "!"}</span></div>
    <strong>{title}</strong><span className={ok ? "healthy" : "warning"}>{value}</span>
  </div>;
}

function Detail({ instance, onChanged }: { instance: Instance; onChanged: () => Promise<void> }) {
  const [notice, setNotice] = useState<string | null>(null);
  const hostname = `${instance.slug}.${import.meta.env.VITE_INSTANCE_DOMAIN ?? "ocx.run"}`;
  const healthy = instance.status === "online";

  async function copy(value: string, message: string) {
    await navigator.clipboard.writeText(value);
    setNotice(message); setTimeout(() => setNotice(null), 1800);
  }
  async function handleOpen() {
    const url = await openInstance(instance.id);
    if (url.startsWith("#")) setNotice("Demo instance is ready"); else window.location.assign(url);
  }
  async function rotate() {
    const issued = await issueToken(instance.id);
    await copy(issued.token, "New API token copied — it will not be shown again");
  }
  async function suspend() {
    if (!window.confirm(`Suspend ${instance.name}? Active connections will close immediately.`)) return;
    await suspendInstance(instance.id); await onChanged();
  }
  async function remove() {
    if (!window.confirm(`Delete ${instance.name}? The hostname will be reserved for 30 days.`)) return;
    await deleteInstance(instance.id); await onChanged();
  }
  return <section className="detail-card" aria-label={`${instance.name} details`}>
    <div className="detail-heading"><div><h2>{hostname}</h2><Status value={instance.status} /></div><button className="primary" onClick={handleOpen}>Open instance <IconExternalLink /></button></div>
    {notice && <div className="toast" role="status">{notice}</div>}
    <div className="health-row">
      <HealthNode icon={IconBox} title="OpenCodex" value={healthy ? "Healthy" : "Degraded"} ok={healthy} />
      <HealthNode icon={IconTerminal2} title="Agent" value={healthy ? "Healthy" : "Healthy"} />
      <HealthNode icon={IconLink} title="Tunnel" value={healthy ? "Connected" : "Reconnecting"} ok={healthy} />
      <HealthNode icon={IconGlobe} title="Gateway check" value={healthy ? "Healthy" : "Delayed"} ok={healthy} />
    </div>
    <dl className="facts">
      <div><dt>Hostname</dt><dd>{hostname}<button className="icon-button" onClick={() => copy(hostname, "Hostname copied")} aria-label="Copy hostname"><IconCopy /></button></dd></div>
      <div><dt>Version</dt><dd>2.7.41</dd></div>
      <div><dt>Last seen</dt><dd>{relativeTime(instance.updatedAt)}</dd></div>
    </dl>
    <div className="actions"><span>Actions</span>
      <button onClick={rotate}><IconShield />Rotate credentials</button>
      <button onClick={suspend}><IconPlayerPause />Suspend</button>
      <button className="danger" onClick={remove}><IconTrash />Delete</button>
    </div>
  </section>;
}

function Instances({ instances, selected, select, refresh, newInstance }: { instances: Instance[]; selected: Instance | null; select: (id: string) => void; refresh: () => Promise<void>; newInstance: () => void }) {
  return <>
    <header className="page-header"><h1>Instances</h1><div className="account"><button className="primary" onClick={newInstance}><IconPlus />New instance</button><span className="divider" /><span className="avatar">GH</span><span>octocat</span><IconChevronDown /></div></header>
    <div className="instance-layout">
      <section className="instance-list" aria-label="Instances">
        <div className="table-head"><span>Name</span><span>Hostname</span><span>Status</span><span>Last seen</span></div>
        {instances.map(instance => <button key={instance.id} className={`instance-row ${selected?.id === instance.id ? "selected" : ""}`} onClick={() => select(instance.id)}>
          <span className="instance-name"><span className={`tiny-dot status-${instance.status}`} />{instance.name}</span>
          <span>{instance.slug}.ocx.run</span><Status value={instance.status} /><span>{relativeTime(instance.updatedAt)}</span>
        </button>)}
        {!instances.length && <div className="empty"><IconServer2 /><strong>No instances yet</strong><span>Create a private endpoint for your Linux server.</span><button className="primary" onClick={newInstance}>New instance</button></div>}
      </section>
      {selected ? <Detail instance={selected} onChanged={refresh} /> : <section className="detail-card empty-detail">Select an instance</section>}
    </div>
  </>;
}

function Stepper({ step }: { step: number }) {
  return <div className="stepper">{["Instance", "Install Agent", "Verify"].map((label, index) => <div className={`step ${step >= index + 1 ? "current" : ""}`} key={label}><span>{step > index + 1 ? <IconCheck /> : index + 1}</span><strong>{label}</strong></div>)}</div>;
}

function NewInstance({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => Promise<void> }) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState("home-server");
  const [slug, setSlug] = useState("home-server");
  const [instance, setInstance] = useState<Instance | null>(null);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null);
  const [seconds, setSeconds] = useState(600);
  const [error, setError] = useState<string | null>(null);
  const command = `curl -fsSL https://install.ocx.run/agent.sh | sudo sh`;

  useEffect(() => {
    if (!pairing) return;
    const tick = () => setSeconds(Math.max(0, Math.floor((new Date(pairing.expiresAt).getTime() - Date.now()) / 1000)));
    tick(); const timer = window.setInterval(tick, 1000); return () => window.clearInterval(timer);
  }, [pairing]);

  async function reserve() {
    setError(null);
    try {
      const created = await createInstance(name, slug);
      setInstance(created);
      const code = await createPairingCode(created.id);
      setPairing(code); setStep(2);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create instance"); }
  }
  async function verify() { setStep(3); await onCreated(); }
  const time = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return <>
    <header className="page-header"><h1>New instance</h1></header><Stepper step={step} />
    <section className="onboarding-card">
      {step === 1 ? <div className="instance-form">
        <label>Instance name<input value={name} onChange={event => { setName(event.target.value); setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-")); }} /></label>
        <label>Address<div className="address-input"><input value={slug} onChange={event => setSlug(event.target.value.toLowerCase())} /><span>.ocx.run</span></div></label>
        <p>Choose a stable name for your private OpenCodex instance.</p>
        {error && <div className="form-error">{error}</div>}
        <div className="footer-actions"><button onClick={onCancel}>Cancel</button><button className="primary" onClick={reserve}>Reserve instance</button></div>
      </div> : step === 2 ? <>
        <div className="reserved"><label>Instance name<input readOnly value={instance?.name ?? name} /></label><label>Address<input readOnly value={`${instance?.slug ?? slug}.ocx.run`} /></label><p>We’ve reserved this hostname for your new private instance.</p></div>
        <div className="install-grid"><div className="install-column"><h2>Install the Linux Agent</h2><p>Run this command on the server where OpenCodex is installed.</p><pre>{command}</pre><button className="copy-command" onClick={() => navigator.clipboard.writeText(command)}><IconClipboard />Copy command</button><hr /><h2>Pair this Agent</h2><p>Enter this code when prompted by the agent.</p><div className="pairing-code"><strong>{pairing?.code.match(/.{1,4}/g)?.join("-")}</strong><span>◷ Expires in {time}</span></div><p>The code can be used once and does not contain a long-lived credential.</p></div>
          <div className="verify-column"><h2>Verify</h2><p>We’ll check the connection once the agent is paired.</p>{[[IconBox,"OpenCodex detected"],[IconTerminal2,"Agent authenticated"],[IconLink,"Tunnel connected"],[IconGlobe,"Gateway health check"]].map(([Icon,label]) => <div className="verify-row" key={label as string}><span><Icon /></span><strong>{label as string}</strong><em>● &nbsp;Waiting</em></div>)}</div></div>
        <div className="footer-actions"><button onClick={onCancel}>Cancel</button><button className="primary" onClick={verify}>I’ve paired the Agent</button></div>
      </> : <div className="success-state"><IconCircleCheckFilled /><h2>Instance verification started</h2><p>Health becomes Online when OpenCodex, the Agent, Tunnel, and Gateway checks are all fresh.</p><button className="primary" onClick={onCancel}>Back to instances</button></div>}
    </section>
  </>;
}

function SecondaryPage({ view, instances }: { view: "activity" | "security"; instances: Instance[] }) {
  return <><header className="page-header"><h1>{view === "activity" ? "Activity" : "Security"}</h1></header><section className="secondary-card">
    {view === "activity" ? <><IconActivityHeartbeat /><h2>Recent instance activity</h2>{instances.map(item => <div className="activity-row" key={item.id}><Status value={item.status} /><span>{item.name}</span><time>{relativeTime(item.updatedAt)}</time></div>)}</> : <><IconKey /><h2>Access is instance-scoped</h2><p>Browser sessions stay on one hostname. CLI tokens can call only <code>/v1/*</code>, expire after 30 days, and are stored as SHA-256 hashes.</p><div className="security-note"><IconShield />Gateway assertions expire after 30 seconds and are verified again by the local Agent and OpenCodex management API.</div></>}
  </section></>;
}

export function App() {
  const [view, setView] = useState<View>("instances");
  const [instances, setInstances] = useState<Instance[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [invite, setInvite] = useState("");
  async function refresh() {
    try {
      const currentUser = await getCurrentUser();
      setUser(currentUser);
      const data = currentUser.status === "active" ? await listInstances() : [];
      setInstances(data); setSelectedId(current => current && data.some(item => item.id === current) ? current : data[0]?.id ?? null); setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load instances"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  const selected = useMemo(() => instances.find(item => item.id === selectedId) ?? null, [instances, selectedId]);
  async function signIn() { await authClient.signIn.social({ provider: "github", callbackURL: "/" }); }
  async function acceptInvite() {
    try { await redeemInvite(invite); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Invite rejected"); }
  }
  return <div className="app-shell"><Sidebar view={view} setView={setView} open={menu} close={() => setMenu(false)} /><main><button className="mobile-menu" onClick={() => setMenu(true)} aria-label="Open navigation"><IconMenu2 /></button>
    {loading ? <div className="loading"><IconLoader2 />Loading instances</div> : error === "not found" ? <div className="access-card"><IconShield /><h1>Private access</h1><p>Sign in with the GitHub account that received an invitation.</p><button className="primary" onClick={signIn}>Continue with GitHub</button></div> : user?.status === "pending_invite" ? <div className="access-card"><IconKey /><h1>Redeem your invite</h1><p>Paste the one-time invitation token. It expires 24 hours after it was created.</p><input value={invite} onChange={event => setInvite(event.target.value)} placeholder="Invitation token" /><button className="primary" onClick={acceptInvite}>Redeem invite</button>{error && <span className="form-error">{error}</span>}</div> : error ? <div className="load-error"><IconShield />{error}<button onClick={refresh}>Retry</button></div> : view === "instances" ? <Instances instances={instances} selected={selected} select={setSelectedId} refresh={refresh} newInstance={() => setView("new")} /> : view === "new" ? <NewInstance onCancel={() => setView("instances")} onCreated={refresh} /> : <SecondaryPage view={view} instances={instances} />}
  </main></div>;
}
