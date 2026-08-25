import { describe, expect, it } from "vitest";
import { extractRubricLines } from "../src/core/source-material.js";
import { extractMaterial } from "../src/core/source-material.js";
import path from "node:path";
import { buildTaskSpec } from "../src/core/task-intake.js";

describe("source material analysis", () => {
  it("keeps score-bearing source lines as rubric candidates instead of hard requirements", () => {
    expect(extractRubricLines("交付应用\n性能优化（20分）\n评分标准：文档完整\n建议使用缓存")).toEqual(["性能优化（20分）", "评分标准：文档完整"]);
  });
  it("extracts text from an actual DOCX input", async () => {
    const result = await extractMaterial(path.join(process.cwd(), "node_modules", "mammoth", "test", "test-data", "single-paragraph.docx"));
    expect(result.sourceType).toBe("document");
    expect(result.text.trim().length).toBeGreaterThan(0);
  }, 15_000);
  it("extracts text from an actual PDF input", async () => {
    const result = await extractMaterial(path.join(process.cwd(), "tests", "fixtures", "source-material.pdf"));
    expect(result.sourceType).toBe("document");
    expect(result.text).toContain("performance 20 points");
    expect(result.lineLocators?.some((locator) => locator.startsWith("page="))).toBe(true);
    const task = buildTaskSpec("source-material.pdf", result.text, result.sourceType, "2026-08-24T00:00:00.000Z", result.lineLocators);
    expect(task.rubricItems[0]?.sourcePointers[0]?.locator).toContain("#page=");
  });
  it("runs OCR for an actual image input", async () => {
    const result = await extractMaterial(path.join(process.cwd(), "node_modules", "tesseract.js", "docs", "images", "tesseract.png"));
    expect(result.sourceType).toBe("image");
    expect(result.text.trim().length).toBeGreaterThan(0);
  }, 30_000);
});
