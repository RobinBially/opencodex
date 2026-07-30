import { useCallback, useEffect, useState } from "react";
import { readJsonOrThrow } from "../fetch-json";
import { IconCheck, IconExternal, IconGithub, IconGlobe, IconLock, IconRefresh, IconTerminal } from "../icons";
import { useT } from "../i18n/shared";
import { Notice } from "../ui";

type RemoteStatus =
  | { state: "signed_out"; controlPlaneUrl: string; serviceReachable: boolean; error?: string }
  | {
    state: "pending";
    controlPlaneUrl: string;
    serviceReachable: boolean;
    authorizeUrl: string;
    userCode: string;
    expiresAt: string;
    error?: string;
  }
  | {
    state: "connected";
    controlPlaneUrl: string;
    serviceReachable: boolean;
    deviceId: string;
    account: { name: string; email: string; githubNumericId: string };
    passwordSet: boolean;
    canActivate: boolean;
    instance: {
      id: string;
      name: string;
      slug: string;
      status: "pending" | "provisioning" | "awaiting_agent" | "connecting" | "online" | "degraded" | "offline" | "suspending" | "suspended" | "deleting" | "delete_failed" | "deleted";
      publicUrl: string;
    } | null;
    error?: string;
  };

async function requestRemote<T = RemoteStatus>(apiBase: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, init);
  const body = await readJsonOrThrow<T>(response);
  if (!body) throw new Error("empty remote response");
  return body;
}

function RemoteSteps({ status }: { status: RemoteStatus }) {
  const t = useT();
  const accountDone = status.state === "connected";
  const passwordDone = accountDone && status.passwordSet;
  const tunnelDone = accountDone && status.instance !== null && ["online", "degraded"].includes(status.instance.status);
  return <div className="remote-steps" aria-label={t("remote.progressLabel")}>
    {[
      { label: t("remote.stepAccount"), done: accountDone, current: !accountDone },
      { label: t("remote.stepPassword"), done: passwordDone, current: accountDone && !passwordDone },
      { label: t("remote.stepTunnel"), done: tunnelDone, current: passwordDone && !tunnelDone },
    ].map((step, index) => <div className={`remote-step${step.done ? " is-done" : ""}${step.current ? " is-current" : ""}`} key={step.label}>
      <span>{step.done ? <IconCheck /> : index + 1}</span><strong>{step.label}</strong>
    </div>)}
  </div>;
}

export default function Remote({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [instanceName, setInstanceName] = useState("");
  const [slug, setSlug] = useState("");
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const next = await requestRemote(apiBase, "/api/remote/status");
      setStatus(next);
      setError(next.error ?? null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("remote.loadFailed"));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [apiBase, t]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [refresh]);

  useEffect(() => {
    const waitingForDevice = status?.state === "pending";
    const waitingForInstance = status?.state === "connected" && !!status.instance
      && ["pending", "provisioning", "connecting"].includes(status.instance.status);
    if (!waitingForDevice && !waitingForInstance) return;
    const timer = window.setInterval(() => { void refresh(true); }, 2_000);
    return () => window.clearInterval(timer);
  }, [refresh, status]);

  const startLogin = async () => {
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    setBusy(true);
    setError(null);
    try {
      const next = await requestRemote(apiBase, "/api/remote/link", { method: "POST" });
      setStatus(next);
      if (next.state === "pending") {
        if (popup) popup.location.href = next.authorizeUrl;
        else window.open(next.authorizeUrl, "_blank", "noopener,noreferrer");
      } else popup?.close();
    } catch (reason) {
      popup?.close();
      setError(reason instanceof Error ? reason.message : t("remote.startFailed"));
    } finally {
      setBusy(false);
    }
  };

  const cancelLogin = async () => {
    setBusy(true);
    try {
      setStatus(await requestRemote(apiBase, "/api/remote/link/cancel", { method: "POST" }));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("remote.cancelFailed"));
    } finally {
      setBusy(false);
    }
  };

  const savePassword = async () => {
    if (password.length < 10) { setError(t("remote.passwordLength")); return; }
    if (password !== confirmation) { setError(t("remote.passwordMismatch")); return; }
    setBusy(true);
    setError(null);
    try {
      const next = await requestRemote(apiBase, "/api/remote/password", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      setStatus(next);
      setPassword("");
      setConfirmation("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("remote.passwordFailed"));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm(t("remote.disconnectConfirm"))) return;
    setBusy(true);
    try {
      setStatus(await requestRemote(apiBase, "/api/remote/device", { method: "DELETE" }));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("remote.disconnectFailed"));
    } finally {
      setBusy(false);
    }
  };

  const activate = async () => {
    const cleanSlug = slug.trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(cleanSlug)) {
      setError(t("remote.domainInvalid"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setStatus(await requestRemote(apiBase, "/api/remote/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: instanceName.trim() || cleanSlug, slug: cleanSlug }),
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("remote.activateFailed"));
    } finally {
      setBusy(false);
    }
  };

  const prepareConnector = async () => {
    setBusy(true);
    setError(null);
    try {
      setPairing(await requestRemote<{ code: string; expiresAt: string }>(apiBase, "/api/remote/pairing-code", {
        method: "POST",
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("remote.pairingFailed"));
    } finally {
      setBusy(false);
    }
  };

  return <div className="remote-page">
    <div className="page-head"><div><h2>{t("remote.title")}</h2><p className="page-sub remote-page-sub">{t("remote.subtitle")}</p></div>
      <button className="btn btn-ghost btn-icon" type="button" onClick={() => void refresh()} disabled={loading} aria-label={t("remote.refresh")} title={t("remote.refresh")}><IconRefresh /></button>
    </div>
    {status && <RemoteSteps status={status} />}
    {error && <Notice tone="err">{error}</Notice>}
    {loading && !status ? <section className="panel remote-loading"><IconRefresh /><span>{t("remote.loading")}</span></section>
      : status?.state === "signed_out" ? <>
        <section className="panel panel-accent remote-hero">
          <div className="remote-hero-icon"><IconGlobe /></div><div><h3>{t("remote.signedOutTitle")}</h3><p>{t("remote.signedOutBody")}</p>
          <button className="btn btn-primary" type="button" onClick={() => void startLogin()} disabled={busy}><IconGithub />{busy ? t("remote.starting") : t("remote.signIn")}</button></div>
        </section>
        <section className="remote-explain-grid">
          <div className="card remote-explain"><IconGithub /><strong>{t("remote.identityTitle")}</strong><span>{t("remote.identityBody")}</span></div>
          <div className="card remote-explain"><IconLock /><strong>{t("remote.deviceTitle")}</strong><span>{t("remote.deviceBody")}</span></div>
          <div className="card remote-explain"><IconGlobe /><strong>{t("remote.tunnelTitle")}</strong><span>{t("remote.tunnelBody")}</span></div>
        </section>
      </> : status?.state === "pending" ? <section className="panel remote-hero remote-pending">
        <div className="remote-hero-icon"><IconGithub /></div><div><h3>{t("remote.pendingTitle")}</h3><p>{t("remote.pendingBody")}</p>
        <div className="remote-code"><span>{t("remote.codeLabel")}</span><strong>{status.userCode.match(/.{1,4}/g)?.join(" ")}</strong></div>
        <div className="remote-actions"><a className="btn btn-primary" href={status.authorizeUrl} target="_blank" rel="noreferrer"><IconExternal />{t("remote.openBrowser")}</a><button className="btn btn-ghost" type="button" onClick={() => void cancelLogin()} disabled={busy}>{t("common.cancel")}</button></div>
        <span className="remote-waiting" role="status">{t("remote.waiting")}</span></div>
      </section> : status?.state === "connected" ? <>
        <section className="card remote-account-card"><div className="remote-account-icon"><IconCheck /></div><div><span>{t("remote.connectedAs")}</span><strong>{status.account.name}</strong><small>{status.account.email}</small></div><button className="btn btn-danger btn-sm" type="button" onClick={() => void disconnect()} disabled={busy}>{t("remote.disconnect")}</button></section>
        {!status.passwordSet ? <section className="panel remote-password-panel"><div className="panel-head"><IconLock /><div><h3>{t("remote.passwordTitle")}</h3><p>{t("remote.passwordBody")}</p></div></div>
          <div className="remote-password-grid"><label><span>{t("remote.passwordLabel")}</span><input className="input" type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} /></label>
          <label><span>{t("remote.passwordConfirm")}</span><input className="input" type="password" autoComplete="new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label></div>
          <div className="remote-actions"><button className="btn btn-primary" type="button" onClick={() => void savePassword()} disabled={busy}>{busy ? t("common.saving") : t("remote.savePassword")}</button></div>
        </section> : !status.canActivate ? <section className="panel remote-password-panel"><div className="panel-head"><IconLock /><div><h3>{t("remote.privateBetaTitle")}</h3><p>{t("remote.privateBetaBody")}</p></div></div></section>
          : !status.instance ? <section className="panel remote-password-panel"><div className="panel-head"><IconGlobe /><div><h3>{t("remote.domainTitle")}</h3><p>{t("remote.domainBody")}</p></div></div>
            <div className="remote-password-grid"><label><span>{t("remote.deviceNameLabel")}</span><input className="input" value={instanceName} onChange={event => setInstanceName(event.target.value)} placeholder={t("remote.deviceNamePlaceholder")} /></label>
            <label><span>{t("remote.domainLabel")}</span><div className="remote-domain-input"><input className="input" value={slug} onChange={event => setSlug(event.target.value.toLowerCase())} placeholder="my-ocx" /><span>{t("remote.domainSuffix")}</span></div></label></div>
            <div className="remote-actions"><button className="btn btn-primary" type="button" onClick={() => void activate()} disabled={busy}>{busy ? t("remote.activating") : t("remote.activate")}</button></div>
          </section> : ["pending", "provisioning"].includes(status.instance.status) ? <section className="panel panel-accent remote-hero remote-ready"><div className="remote-hero-icon"><IconRefresh /></div><div><h3>{t("remote.provisioningTitle")}</h3><p>{t("remote.provisioningBody")}</p><strong className="remote-address">{status.instance.publicUrl}</strong></div></section>
            : ["awaiting_agent", "offline"].includes(status.instance.status) ? <section className="panel remote-password-panel"><div className="panel-head"><IconTerminal /><div><h3>{t("remote.connectorTitle")}</h3><p>{t("remote.connectorBody")}</p></div></div>
              <strong className="remote-address">{status.instance.publicUrl}</strong>
              {pairing ? <div className="remote-code"><span>{t("remote.pairingCode")}</span><strong>{pairing.code.match(/.{1,4}/g)?.join(" ")}</strong></div> : null}
              <div className="remote-actions"><button className="btn btn-primary" type="button" onClick={() => void prepareConnector()} disabled={busy}>{busy ? t("remote.preparingConnector") : t("remote.prepareConnector")}</button></div>
              <span className="remote-next-note">{t("remote.connectorRequirement")}</span>
            </section> : status.instance.status === "connecting" ? <section className="panel panel-accent remote-hero remote-ready"><div className="remote-hero-icon"><IconRefresh /></div><div><h3>{t("remote.connectingTitle")}</h3><p>{t("remote.connectingBody")}</p><strong className="remote-address">{status.instance.publicUrl}</strong></div></section>
              : ["online", "degraded"].includes(status.instance.status) ? <section className="panel panel-accent remote-hero remote-ready"><div className="remote-hero-icon"><IconCheck /></div><div><h3>{t("remote.readyTitle")}</h3><p>{t("remote.readyBody")}</p><a className="btn btn-primary remote-open" href={status.instance.publicUrl} target="_blank" rel="noreferrer"><IconExternal />{t("remote.openRemote")}</a></div></section>
                : <section className="panel remote-password-panel"><div className="panel-head"><IconGlobe /><div><h3>{t("remote.unavailableTitle")}</h3><p>{t("remote.unavailableBody")}</p></div></div></section>}
      </> : null}
  </div>;
}
