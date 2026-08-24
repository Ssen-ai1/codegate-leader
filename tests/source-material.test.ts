import { describe, expect, it } from "vitest";
import { extractRubricLines } from "../src/core/source-material.js";
import { extractMaterial } from "../src/core/source-material.js";
import path from "node:path";

describe("source material analysis", () => {
  it("keeps score-bearing source lines as rubric candidates instead of hard requirements", () => {
    expect(extractRubricLines("交付应用\n性能优化（20分）\n评分标准：文档完整\n建议使用缓存")).toEqual(["性能优化（20分）", "评分标准：文档完整"]);
  });
  it("extracts text from an actual DOCX input", async () => {
    const result = await extractMaterial(path.join(process.cwd(), "node_modules", "mammoth", "test", "test-data", "single-paragraph.docx"));
    expect(result.sourceType).toBe("document");
    expect(result.text.trim().length).toBeGreaterThan(0);
  });
});
