import { describe, expect, it } from "vitest";
import { CHAT_BODY_MAX, CHAT_FILE_NAME_MAX, chatBodyHasText, chatFileName, normalizeChatBody } from "./chat.js";

describe("chat body", () => {
  it("folds CR/CRLF to LF and drops trailing whitespace", () => {
    expect(normalizeChatBody("a\r\nb\rc  \n\n")).toBe("a\nb\nc");
    expect(normalizeChatBody("  indented\tkept")).toBe("  indented\tkept");
  });
  it("refuses other control characters and over-long bodies", () => {
    expect(normalizeChatBody("bell\u0007")).toBeNull();
    expect(normalizeChatBody("esc\u001b[31m")).toBeNull();
    expect(normalizeChatBody("x".repeat(CHAT_BODY_MAX))).toHaveLength(CHAT_BODY_MAX);
    expect(normalizeChatBody("x".repeat(CHAT_BODY_MAX + 1))).toBeNull();
  });
  it("knows an empty body", () => {
    expect(chatBodyHasText(" \n\t")).toBe(false);
    expect(chatBodyHasText(" a ")).toBe(true);
  });
});

describe("chat file names", () => {
  it("keeps the base name only, without control characters", () => {
    expect(chatFileName("C:\\Users\\x\\offer.pdf")).toBe("offer.pdf");
    expect(chatFileName("../../etc/passwd")).toBe("passwd");
    expect(chatFileName("a\u0000b\nc.png")).toBe("abc.png");
    expect(chatFileName("  ..  ")).toBeNull();
    expect(chatFileName("dir/")).toBeNull();
  });
  it("shortens long names and keeps the extension", () => {
    const n = chatFileName(`${"n".repeat(300)}.docx`)!;
    expect(n).toHaveLength(CHAT_FILE_NAME_MAX);
    expect(n.endsWith(".docx")).toBe(true);
  });
});
