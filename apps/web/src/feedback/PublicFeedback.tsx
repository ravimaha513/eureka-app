import { useEffect, useState } from "react";
import "./feedback.css";

interface Invitation {
  firstName: string | null;
  clientName: string | null;
  startsAt: string;
  expiresAt: string;
}

const unavailable = "This feedback link is no longer available. It may have expired or already been used. Please contact your recruiter.";

/** Token-authenticated form: no staff session, CSRF token, or personal-data storage. */
export function PublicFeedback({ token }: { token: string }) {
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [closed, setClosed] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);
  const [rating, setRating] = useState("");
  const [notes, setNotes] = useState("");
  const [format, setFormat] = useState("");
  const [topics, setTopics] = useState("");
  const [difficultQuestions, setDifficultQuestions] = useState("");
  const [durationMin, setDurationMin] = useState("");
  const [nextStep, setNextStep] = useState("");
  const [attempt, setAttempt] = useState(0);
  const validToken = /^[A-Za-z0-9_-]{43}$/.test(token);
  const path = `/api/public/feedback/${encodeURIComponent(token)}`;

  useEffect(() => {
    document.title = "Interview feedback | Eureka";
    const policy = document.createElement("meta");
    policy.name = "referrer";
    policy.content = "no-referrer";
    document.head.append(policy);
    return () => { policy.remove(); };
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true); setError(""); setClosed(false); setInvitation(null); setSubmitted(false);
    if (!validToken) {
      setClosed(true); setError(unavailable); setLoading(false);
      return () => abort.abort();
    }
    void (async () => {
      try {
        const res = await fetch(path, { credentials: "omit", referrerPolicy: "no-referrer", signal: abort.signal });
        if (res.status === 404 || res.status === 410) {
          setClosed(true); setError(unavailable);
        } else if (!res.ok) {
          setError(res.status === 429 ? "Too many attempts. Please wait a minute and try again." : "We couldn't load your invitation. Please try again.");
        } else {
          setInvitation(await res.json() as Invitation);
        }
      } catch {
        if (!abort.signal.aborted) setError("We couldn't connect. Check your connection and try again.");
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    })();
    return () => abort.abort();
  }, [path, validToken, attempt]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!rating || sending || closed || submitted) return;
    const topicList = topics.split(",").map((t) => t.trim()).filter(Boolean);
    if (topicList.length > 20 || topicList.some((t) => t.length > 100)) {
      setError("Use up to 20 topics, with no more than 100 characters per topic.");
      return;
    }
    setSending(true); setError("");
    try {
      const res = await fetch(path, {
        method: "POST", credentials: "omit", referrerPolicy: "no-referrer",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rating: Number(rating), ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(format.trim() ? { format: format.trim() } : {}),
          ...(topicList.length ? { topics: topicList } : {}),
          ...(difficultQuestions.trim() ? { difficultQuestions: difficultQuestions.trim() } : {}),
          ...(durationMin ? { durationMin: Number(durationMin) } : {}),
          ...(nextStep.trim() ? { nextStep: nextStep.trim() } : {}),
        }),
      });
      if (res.ok) {
        setSubmitted(true); setNotes(""); setFormat(""); setTopics("");
        setDifficultQuestions(""); setDurationMin(""); setNextStep("");
      } else if (res.status === 404 || res.status === 410) {
        setClosed(true); setError(unavailable);
      } else {
        setError(res.status === 429 ? "Too many attempts. Please wait a minute and try again. Your feedback is still here."
          : res.status === 422 ? "Please check your answers and the field length limits."
          : "We couldn't confirm your submission. Please try again. Your feedback is still here.");
      }
    } catch {
      setError("We couldn't confirm your submission. Check your connection and try again. Your feedback is still here.");
    } finally { setSending(false); }
  };

  return (
    <main className="feedback-page">
      <div className="feedback-card">
        <div className="feedback-brand">Eureka</div>
        <h1>Interview feedback</h1>
        {loading ? <p role="status">Loading your invitation…</p> : submitted ? (
          <div role="status"><h2>Thank you for your feedback</h2><p>Your response has been saved with your interview. You can close this page.</p></div>
        ) : (
          <>
            {error && <p role="alert" className="feedback-error">{error}</p>}
            {!invitation && !closed && <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>Try again</button>}
            {invitation && !closed && (
              <>
                <p>{invitation.firstName ? `Hi ${invitation.firstName}. ` : ""}Tell us how your interview{invitation.clientName ? ` with ${invitation.clientName}` : ""} went.</p>
                <p className="feedback-date">{new Date(invitation.startsAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} (your local time)</p>
                <form onSubmit={(e) => void submit(e)}>
                  <fieldset disabled={sending}>
                    <legend>How was your interview? <span>(required)</span></legend>
                    <div className="feedback-ratings">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <label key={n}><input type="radio" name="rating" value={n} checked={rating === String(n)} onChange={(e) => setRating(e.target.value)} required />{n}</label>
                      ))}
                    </div>
                    <p className="feedback-hint">1 = very difficult · 5 = very positive</p>
                    <label className="feedback-label" htmlFor="feedback-format">Interview format <span>(optional)</span></label>
                    <select id="feedback-format" value={format} onChange={(e) => setFormat(e.target.value)}>
                      <option value="">Choose a format</option>
                      <option>Video</option><option>Phone</option><option>In person</option><option>Online assessment</option><option>Other</option>
                    </select>
                    <label className="feedback-label" htmlFor="feedback-duration">Duration in minutes <span>(optional)</span></label>
                    <input id="feedback-duration" type="number" min={0} max={1440} step={1} value={durationMin} onChange={(e) => setDurationMin(e.target.value)} />
                    <label className="feedback-label" htmlFor="feedback-topics">Topics covered <span>(optional)</span></label>
                    <input id="feedback-topics" type="text" maxLength={2019} value={topics} onChange={(e) => setTopics(e.target.value)} aria-describedby="feedback-topics-help" />
                    <p className="feedback-hint" id="feedback-topics-help">Separate topics with commas, up to 20 topics.</p>
                    <label className="feedback-label" htmlFor="feedback-questions">Questions you found difficult <span>(optional)</span></label>
                    <textarea id="feedback-questions" rows={3} maxLength={4000} value={difficultQuestions} onChange={(e) => setDifficultQuestions(e.target.value)} />
                    <label className="feedback-label" htmlFor="feedback-next">Next steps discussed <span>(optional)</span></label>
                    <textarea id="feedback-next" rows={2} maxLength={1000} value={nextStep} onChange={(e) => setNextStep(e.target.value)} />
                    <label className="feedback-label" htmlFor="feedback-notes">Anything you'd like your team to know? <span>(optional)</span></label>
                    <textarea id="feedback-notes" rows={4} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} aria-describedby="feedback-notes-help" />
                    <p id="feedback-notes-help" className="feedback-hint">Please leave out sensitive personal information. {notes.length.toLocaleString()} / 4,000 characters.</p>
                    <button type="submit" className="btn primary" disabled={!rating || sending}>{sending ? "Sending…" : "Send feedback"}</button>
                  </fieldset>
                </form>
                <p className="feedback-hint">This link accepts one response and expires {new Date(invitation.expiresAt).toLocaleString()}. Your response is shared with the staff who manage your interview.</p>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}
