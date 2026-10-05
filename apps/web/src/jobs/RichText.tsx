import { Fragment, useEffect, useId, useRef, type ReactNode } from "react";
import { Bold, Italic, Link2, List, ListOrdered, RemoveFormatting, Strikethrough, Underline } from "lucide-react";
import { isSafeHttpsUrl, type RichBlock, type RichDoc, type RichMark, type RichRun } from "@eureka/shared";
import "./jobs.css";

/**
 * Rich text for job requirements and descriptions. The stored form is the
 * shared RichDoc tree (never HTML): the view renders it with React elements
 * (no innerHTML), and the editor converts its contentEditable DOM to a tree
 * through an allow-list walker (paragraphs, lists, b/i/u/s, https links);
 * everything else is dropped. The server validates the tree again.
 */

const MARK_TAG: Record<RichMark, "strong" | "em" | "u" | "s"> = { b: "strong", i: "em", u: "u", s: "s" };

function Runs({ runs }: { runs: RichRun[] }) {
  return (
    <>
      {runs.map((r, i) => {
        let node: ReactNode = r.text;
        for (const m of r.marks ?? []) { const Tag = MARK_TAG[m]; node = <Tag>{node}</Tag>; }
        if (r.href && isSafeHttpsUrl(r.href)) node = <a href={r.href} target="_blank" rel="noopener noreferrer nofollow">{node}</a>;
        return <Fragment key={i}>{node}</Fragment>;
      })}
    </>
  );
}

export function RichTextView({ doc, empty = "—" }: { doc: RichDoc | null | undefined; empty?: string }) {
  if (!doc || doc.blocks.length === 0) return <p className="muted">{empty}</p>;
  return (
    <div className="richview">
      {doc.blocks.map((b, i) => b.type === "p"
        ? <p key={i}><Runs runs={b.runs} /></p>
        : b.type === "ul"
          ? <ul key={i}>{b.items.map((it, j) => <li key={j}><Runs runs={it} /></li>)}</ul>
          : <ol key={i}>{b.items.map((it, j) => <li key={j}><Runs runs={it} /></li>)}</ol>)}
    </div>
  );
}

// ---------- DOM <-> tree ----------

const INLINE_MARK: Record<string, RichMark> = { B: "b", STRONG: "b", I: "i", EM: "i", U: "u", INS: "u", S: "s", STRIKE: "s", DEL: "s" };
const BLOCKS = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "SECTION", "ARTICLE"]);

function sameStyle(a: RichRun, b: RichRun) {
  return (a.href ?? "") === (b.href ?? "") && [...(a.marks ?? [])].sort().join() === [...(b.marks ?? [])].sort().join();
}

function pushRun(line: RichRun[], text: string, marks: RichMark[], href: string | undefined) {
  if (!text) return;
  const run: RichRun = { text, ...(marks.length ? { marks: [...new Set(marks)].sort() as RichMark[] } : {}), ...(href ? { href } : {}) };
  const last = line[line.length - 1];
  if (last && sameStyle(last, run)) last.text += text;
  else line.push(run);
}

/** Inline content of `node` into lines (a <br> starts a new line). */
function inline(node: Node, lines: RichRun[][], marks: RichMark[], href: string | undefined) {
  node.childNodes.forEach((ch) => {
    if (ch.nodeType === Node.TEXT_NODE) {
      pushRun(lines[lines.length - 1]!, (ch.textContent ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\s+/g, " "), marks, href);
      return;
    }
    if (ch.nodeType !== Node.ELEMENT_NODE) return;
    const el = ch as HTMLElement;
    if (el.tagName === "BR") { lines.push([]); return; }
    if (el.tagName === "SCRIPT" || el.tagName === "STYLE") return;
    const m = INLINE_MARK[el.tagName];
    let h = href;
    if (el.tagName === "A") { const raw = el.getAttribute("href") ?? ""; h = isSafeHttpsUrl(raw) ? raw : undefined; }
    inline(el, lines, m ? [...marks, m] : marks, h);
  });
}

function trimLine(l: RichRun[]): RichRun[] {
  if (l.length) { l[0]!.text = l[0]!.text.replace(/^\s+/, ""); const z = l[l.length - 1]!; z.text = z.text.replace(/\s+$/, ""); }
  return l.filter((r) => r.text.length > 0);
}

/** Allow-list conversion of an editor's DOM to the stored tree. */
export function domToRich(root: HTMLElement): RichDoc {
  const blocks: RichBlock[] = [];
  let loose: RichRun[][] | null = null;
  const flushLoose = () => {
    if (loose) for (const l of loose) { const t = trimLine(l); if (t.length) blocks.push({ type: "p", runs: t }); }
    loose = null;
  };
  root.childNodes.forEach((ch) => {
    const el = ch.nodeType === Node.ELEMENT_NODE ? (ch as HTMLElement) : null;
    if (el && (el.tagName === "UL" || el.tagName === "OL")) {
      flushLoose();
      const items = [...el.children].filter((li) => li.tagName === "LI").map((li) => {
        const ls: RichRun[][] = [[]];
        inline(li, ls, [], undefined);
        return trimLine(ls.flat());
      }).filter((it) => it.length > 0);
      if (items.length) blocks.push({ type: el.tagName === "UL" ? "ul" : "ol", items });
      return;
    }
    if (el && BLOCKS.has(el.tagName)) {
      flushLoose();
      // A block may itself hold a list (some browsers nest them); handle it like the root.
      if (el.querySelector("ul,ol")) { blocks.push(...domToRich(el).blocks); return; }
      const ls: RichRun[][] = [[]];
      inline(el, ls, [], undefined);
      for (const l of ls) { const t = trimLine(l); if (t.length) blocks.push({ type: "p", runs: t }); }
      return;
    }
    if (!loose) loose = [[]];
    const wrap = document.createElement("span");
    wrap.appendChild(ch.cloneNode(true));
    inline(wrap, loose, [], undefined);
  });
  flushLoose();
  return { blocks };
}

/** Builds the editor's DOM from a tree (text nodes and allow-listed elements only; no HTML parsing). */
export function richToDom(doc: RichDoc | null, root: HTMLElement) {
  root.replaceChildren();
  const runs = (parent: HTMLElement, rs: RichRun[]) => {
    for (const r of rs) {
      let node: Node = document.createTextNode(r.text);
      for (const m of r.marks ?? []) { const el = document.createElement(MARK_TAG[m]); el.appendChild(node); node = el; }
      if (r.href && isSafeHttpsUrl(r.href)) { const a = document.createElement("a"); a.setAttribute("href", r.href); a.appendChild(node); node = a; }
      parent.appendChild(node);
    }
  };
  for (const b of doc?.blocks ?? []) {
    if (b.type === "p") { const p = document.createElement("p"); runs(p, b.runs); if (!b.runs.length) p.appendChild(document.createElement("br")); root.appendChild(p); continue; }
    const list = document.createElement(b.type);
    for (const it of b.items) { const li = document.createElement("li"); runs(li, it); list.appendChild(li); }
    root.appendChild(list);
  }
}

// ---------- editor ----------

const exec = (cmd: string, value?: string) => {
  if (typeof document.execCommand === "function") document.execCommand(cmd, false, value);
};

/**
 * A small rich text editor: toolbar (bold, italic, underline, strike, lists,
 * https link, clear formatting) over a contentEditable region. `onChange`
 * gets the allow-listed tree (null when empty).
 */
export function RichTextEditor({ label, value, onChange, error, placeholder }: {
  label: string; value: RichDoc | null; onChange: (d: RichDoc | null) => void; error?: string; placeholder?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const initial = useRef(value);
  useEffect(() => { if (ref.current) richToDom(initial.current, ref.current); }, []);
  const emit = () => {
    if (!ref.current) return;
    const d = domToRich(ref.current);
    onChange(d.blocks.length ? d : null);
  };
  const tool = (title: string, icon: ReactNode, run: () => void) => (
    <button type="button" className="rtbtn" title={title} aria-label={title}
      onMouseDown={(e) => e.preventDefault()} onClick={() => { ref.current?.focus(); run(); emit(); }}>{icon}</button>
  );
  return (
    <div className="field">
      <span id={`${id}-l`} className="rtlabel">{label}</span>
      <div className={`rteditor${error ? " invalid" : ""}`}>
        <div className="rttoolbar" role="toolbar" aria-label={`${label} formatting`}>
          {tool("Bold", <Bold size={15} aria-hidden="true" />, () => exec("bold"))}
          {tool("Italic", <Italic size={15} aria-hidden="true" />, () => exec("italic"))}
          {tool("Underline", <Underline size={15} aria-hidden="true" />, () => exec("underline"))}
          {tool("Strikethrough", <Strikethrough size={15} aria-hidden="true" />, () => exec("strikeThrough"))}
          <span className="rtsep" aria-hidden="true" />
          {tool("Bulleted list", <List size={15} aria-hidden="true" />, () => exec("insertUnorderedList"))}
          {tool("Numbered list", <ListOrdered size={15} aria-hidden="true" />, () => exec("insertOrderedList"))}
          {tool("Link (https)", <Link2 size={15} aria-hidden="true" />, () => {
            const url = window.prompt("Link address (https://…)")?.trim();
            if (url && isSafeHttpsUrl(url)) exec("createLink", url);
            else if (url) window.alert("Links must start with https://");
          })}
          {tool("Clear formatting", <RemoveFormatting size={15} aria-hidden="true" />, () => { exec("removeFormat"); exec("unlink"); })}
        </div>
        <div ref={ref} className="rtarea" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true"
          aria-labelledby={`${id}-l`} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-e` : undefined}
          data-placeholder={placeholder} tabIndex={0} onInput={emit} onBlur={emit}
          onPaste={(e) => {
            // Paste as plain text: formatting from elsewhere never enters the editor.
            e.preventDefault();
            const text = e.clipboardData.getData("text/plain");
            if (typeof document.execCommand === "function") document.execCommand("insertText", false, text);
            emit();
          }} />
      </div>
      {error && <small id={`${id}-e`} className="error fielderr">{error}</small>}
    </div>
  );
}
