import { describe, expect, it } from "vitest";
import { datahubDownloadName, datahubFileNameProblem, datahubFolderNameProblem } from "./datahub.js";

const PDF = "application/pdf";

describe("DataHub names", () => {
  it("folder names", () => {
    expect(datahubFolderNameProblem("Java Resumes")).toBeNull();
    expect(datahubFolderNameProblem("")).toMatch(/Enter/);
    expect(datahubFolderNameProblem(" x")).toMatch(/spaces/);
    expect(datahubFolderNameProblem("a/b")).toMatch(/slashes/);
    expect(datahubFolderNameProblem("a".repeat(81))).toMatch(/80/);
  });

  it("file names need the type's extension", () => {
    expect(datahubFileNameProblem("Leave policy.pdf", PDF)).toBeNull();
    expect(datahubFileNameProblem("photo.JPEG", "image/jpeg")).toBeNull();
    expect(datahubFileNameProblem("photo.jpg", "image/jpeg")).toBeNull();
    expect(datahubFileNameProblem("report.exe", PDF)).toMatch(/\.pdf/);
    expect(datahubFileNameProblem("report", PDF)).toMatch(/\.pdf/);
    expect(datahubFileNameProblem("..", PDF)).toMatch(/name/);
    expect(datahubFileNameProblem("a\\b.pdf", PDF)).toMatch(/slashes/);
    expect(datahubFileNameProblem("a\u0007.pdf", PDF)).toMatch(/slashes/);
  });

  it("download names are header-safe ASCII with the version", () => {
    expect(datahubDownloadName("Leave policy.pdf", 2, PDF)).toBe("Leave-policy-v2.pdf");
    expect(datahubDownloadName("Résumé \"x\"; filename=evil.pdf", 1, PDF)).toBe("Resume-x-filename-evil-v1.pdf");
    expect(datahubDownloadName("../../.pdf", 3, PDF)).toBe("file-v3.pdf");
    expect(datahubDownloadName("日本語.png", 1, "image/png")).toBe("file-v1.png");
    for (const n of ["a".repeat(200) + ".pdf", "x y z.docx", "%%.pdf"]) {
      expect(datahubDownloadName(n, 10000, PDF)).toMatch(/^[A-Za-z0-9._-]{1,100}$/);
    }
  });
});
