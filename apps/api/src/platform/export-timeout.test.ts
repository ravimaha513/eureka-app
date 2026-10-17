import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MODULES = join(dirname(fileURLToPath(import.meta.url)), "../modules");

const services = (function walk(d: string, acc: string[] = []): string[] {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".service.ts")) acc.push(p);
  }
  return acc;
})(MODULES);

/** Each `async export…(` method of a service: its name and its source up to the next member. */
function exportMethods(src: string): { name: string; body: string }[] {
  const starts = [...src.matchAll(/^ {2}(?:async |private |static |get |[a-zA-Z_]+\()/gm)].map((m) => m.index!);
  return [...src.matchAll(/^ {2}async (export\w*)\(/gm)].map((m) => {
    const end = starts.find((s) => s > m.index!) ?? src.length;
    return { name: m[1]!, body: src.slice(m.index!, end) };
  });
}

describe("exports run with the export statement timeout (design N9)", () => {
  const methods = services.flatMap((f) => exportMethods(readFileSync(f, "utf8")).map((m) => ({ ...m, file: f.slice(MODULES.length + 1) })));

  it("finds the export methods", () => {
    expect(methods.length).toBeGreaterThanOrEqual(10);
  });

  it("no export method opens a plain withUser transaction (DbService.withUserExport raises the timeout)", () => {
    expect(methods.filter((m) => /this\.db\.withUser\(/.test(m.body)).map((m) => `${m.file}: ${m.name}`)).toEqual([]);
  });
});
