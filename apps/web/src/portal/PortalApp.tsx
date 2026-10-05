import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, Moon, Sparkles, Sun } from "lucide-react";
import { ApiError } from "../api";
import { Field } from "../sales/ui";
import { useTheme } from "../shell/theme";
import { normalizePhoneE164, PHONE_PROBLEM_MESSAGES, phoneProblem } from "@eureka/shared";
import { portal, portalError, setPortalCsrf, type Applicant } from "./portalApi";
import { PortalJobs } from "./PortalJobs";
import { PortalApplications } from "./PortalApplications";
import "../jobs/jobs.css";

/**
 * The applicant portal ("Eureka Careers"): a separate minimal shell at
 * /portal/* with its own session (one-time email links, no passwords). Same
 * look and theme switch as the staff app; nothing staff-only is reachable.
 */

export function usePortalPath(): [string, (p: string) => void] {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  const go = (p: string) => { window.history.pushState(null, "", p); setPath(p); };
  return [path, go];
}

function Brand() {
  return <span className="brand"><span className="logo"><Sparkles size={16} aria-hidden="true" /></span><span className="brandname">Eureka Careers</span></span>;
}

function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  return (
    <button type="button" className="btn ghost themechip" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}>
      {theme === "dark" ? <Moon size={15} aria-hidden="true" /> : <Sun size={15} aria-hidden="true" />}{theme === "dark" ? "Dark" : "Light"}
    </button>
  );
}

function AuthFrame({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <div className="portal">
      <header className="portaltop"><Brand /><span className="grow" /><ThemeToggle /></header>
      <main className="authcard">
        <h1 tabIndex={-1}>{title}</h1>
        <p className="sub">{sub}</p>
        {children}
      </main>
      <footer className="portalfoot">Eureka Careers · Your data is used only for your job applications.</footer>
    </div>
  );
}

function SignUp({ go }: { go: (p: string) => void }) {
  const [v, setV] = useState({ firstName: "", lastName: "", email: "", phone: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const [sent, setSent] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV((s) => ({ ...s, [k]: e.target.value }));
  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const e: Record<string, string> = {};
    if (!v.firstName.trim()) e.firstName = "Enter your first name.";
    if (!v.lastName.trim()) e.lastName = "Enter your last name.";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email.trim())) e.email = "Enter your email address.";
    if (!normalizePhoneE164(v.phone)) e.phone = PHONE_PROBLEM_MESSAGES[phoneProblem(v.phone) ?? "invalid"];
    setErrors(e); setErr("");
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const r = await portal.signUp({ firstName: v.firstName.trim(), lastName: v.lastName.trim(), email: v.email.trim(), phone: v.phone });
      setSent(r.message);
    } catch (x) { setErr(portalError(x)); } finally { setBusy(false); }
  };
  return (
    <AuthFrame title="Create your account" sub="Apply for jobs and follow your applications. No password: we email you a sign-in link.">
      {sent ? <p className="okbox" role="status">{sent} Check your inbox.</p> : (
        <form onSubmit={submit} noValidate>
          <Field label="First name" error={errors.firstName}>{(p) => <input {...p} value={v.firstName} onChange={set("firstName")} maxLength={80} autoComplete="given-name" />}</Field>
          <Field label="Last name" error={errors.lastName}>{(p) => <input {...p} value={v.lastName} onChange={set("lastName")} maxLength={80} autoComplete="family-name" />}</Field>
          <Field label="Phone" error={errors.phone} hint="With the country code, e.g. +1 469 555 0142">{(p) => <input {...p} value={v.phone} onChange={set("phone")} maxLength={40} type="tel" autoComplete="tel" />}</Field>
          <Field label="Email" error={errors.email}>{(p) => <input {...p} value={v.email} onChange={set("email")} maxLength={254} type="email" autoComplete="email" />}</Field>
          {err && <p className="error" role="alert">{err}</p>}
          <button type="submit" className="btn primary block" disabled={busy}>{busy ? "Working…" : "Sign up"}</button>
        </form>
      )}
      <p className="alt">Already have an account? <button type="button" className="linkbtn" onClick={() => go("/portal/sign-in")}>Sign in</button></p>
    </AuthFrame>
  );
}

function SignIn({ go }: { go: (p: string) => void }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [err, setErr] = useState("");
  const [sent, setSent] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) { setError("Enter your email address."); return; }
    setError(""); setErr(""); setBusy(true);
    try { setSent((await portal.requestLink(email.trim())).message); } catch (x) { setErr(portalError(x)); } finally { setBusy(false); }
  };
  return (
    <AuthFrame title="Sign in" sub="We email you a link that signs you in. It works once and expires in 15 minutes.">
      {sent ? <p className="okbox" role="status">{sent} Check your inbox.</p> : (
        <form onSubmit={submit} noValidate>
          <Field label="Email" error={error}>{(p) => <input {...p} value={email} onChange={(e) => setEmail(e.target.value)} type="email" maxLength={254} autoComplete="email" />}</Field>
          {err && <p className="error" role="alert">{err}</p>}
          <button type="submit" className="btn primary block" disabled={busy}>{busy ? "Working…" : "Email me a sign-in link"}</button>
        </form>
      )}
      <p className="alt">New here? <button type="button" className="linkbtn" onClick={() => go("/portal/sign-up")}>Create an account</button></p>
    </AuthFrame>
  );
}

/**
 * The link's token is in the URL fragment (never sent to servers or logged by
 * them). It is read once, removed from the address bar, and posted only when
 * the applicant confirms, so mail scanners that open links do not burn them.
 */
function Verify({ onSignedIn, go }: { onSignedIn: () => void; go: (p: string) => void }) {
  const token = useRef(new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "");
  const [err, setErr] = useState(token.current ? "" : "This page needs the link from your email.");
  const [busy, setBusy] = useState(false);
  useEffect(() => { window.history.replaceState(null, "", "/portal/verify"); }, []);
  return (
    <AuthFrame title="Sign in to Eureka Careers" sub="Continue to sign in with the link from your email.">
      {err ? <p className="error" role="alert">{err}</p> : null}
      {token.current && !err && (
        <button type="button" className="btn primary block" disabled={busy} onClick={async () => {
          setBusy(true);
          try { await portal.verify(token.current); token.current = ""; onSignedIn(); go("/portal/jobs"); }
          catch (x) { setErr(portalError(x)); } finally { setBusy(false); }
        }}>{busy ? "Signing in…" : "Continue"}</button>
      )}
      <p className="alt"><button type="button" className="linkbtn" onClick={() => go("/portal/sign-in")}>Send me a new link</button></p>
    </AuthFrame>
  );
}

const SCREENS = [["/portal/jobs", "Jobs"], ["/portal/applications", "My applications"]] as const;

function PortalShell({ me, path, go, onSignOut }: { me: Applicant; path: string; go: (p: string) => void; onSignOut: () => void }) {
  const current = path.startsWith("/portal/applications") ? "/portal/applications" : "/portal/jobs";
  return (
    <div className="portal">
      <header className="portaltop">
        <Brand />
        <nav aria-label="Portal">
          {SCREENS.map(([p, label]) => <button key={p} type="button" aria-current={current === p ? "page" : undefined} onClick={() => go(p)}>{label}</button>)}
        </nav>
        <span className="grow" />
        <ThemeToggle />
        <button type="button" className="btn ghost" onClick={onSignOut} aria-label={`Sign out ${me.firstName} ${me.lastName}`}>
          <LogOut size={15} aria-hidden="true" /><span className="brandname">Sign out</span>
        </button>
      </header>
      <main className="portalmain">
        {current === "/portal/applications" ? <PortalApplications /> : <PortalJobs onApplied={() => undefined} go={go} />}
      </main>
      <footer className="portalfoot">Signed in as {me.email}</footer>
    </div>
  );
}

export function PortalApp() {
  const qc = useQueryClient();
  const [path, go] = usePortalPath();
  const me = useQuery({
    queryKey: ["portal", "me"],
    queryFn: async () => {
      try { const m = await portal.me(); setPortalCsrf(m.csrfToken); return m; }
      catch (e) { if (e instanceof ApiError && e.status === 401) return null; throw e; }
    },
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["portal"] });
  if (path.startsWith("/portal/verify")) return <Verify onSignedIn={refresh} go={go} />;
  if (me.isLoading) return <p className="empty">Loading…</p>;
  if (!me.data) return path.startsWith("/portal/sign-in") ? <SignIn go={go} /> : <SignUp go={go} />;
  return (
    <PortalShell me={me.data} path={path} go={go} onSignOut={async () => {
      await portal.signOut().catch(() => undefined);
      setPortalCsrf("");
      qc.clear();
      go("/portal/sign-in");
      refresh();
    }} />
  );
}
