import type { ReactNode } from "react";

export type TextPart = { kind: "text"; text: string } | { kind: "link"; text: string; href: string };

const CANDIDATE = /https:\/\/[^\s<>"'`]+/gi;
// Punctuation that usually ends a sentence rather than a URL.
const TRAILING = /[.,;:!?)\]}'"]+$/;

/**
 * Splits plain text into text and https links. Only `https://` URLs that
 * parse as URLs with a host become links (no http, javascript:, data: or
 * bare domains); trailing sentence punctuation stays text, and a closing
 * parenthesis is kept only when the URL opened one. The text is never
 * interpreted as HTML: callers render the parts as React text nodes.
 */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(CANDIDATE)) {
    let url = m[0];
    const start = m.index ?? 0;
    let trail = TRAILING.exec(url)?.[0] ?? "";
    if (trail.startsWith(")") && (url.match(/\(/g)?.length ?? 0) > (url.slice(0, url.length - trail.length).match(/\)/g)?.length ?? 0)) {
      trail = trail.slice(1);
    }
    url = url.slice(0, url.length - trail.length);
    let href: string | null = null;
    try {
      const u = new URL(url);
      if (u.protocol === "https:" && u.hostname !== "" && u.username === "" && u.password === "") href = u.href;
    } catch {
      href = null;
    }
    if (!href) continue;
    if (start > last) parts.push({ kind: "text", text: text.slice(last, start) });
    parts.push({ kind: "link", text: url, href });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

/** Message text with https links (new tab, no referrer, no opener). */
export function Linkified({ text }: { text: string }) {
  const nodes: ReactNode[] = splitLinks(text).map((p, i) =>
    p.kind === "link"
      ? <a key={i} href={p.href} target="_blank" rel="noopener noreferrer nofollow">{p.text}</a>
      : p.text);
  return <>{nodes}</>;
}
