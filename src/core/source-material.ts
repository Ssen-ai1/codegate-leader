import { readFile } from "node:fs/promises";
import path from "node:path";

export type ExtractedMaterial = {
  sourceType: "document" | "image" | "workspace-file";
  text: string;
  warnings: string[];
};

export async function extractMaterial(file: string): Promise<ExtractedMaterial> {
  const extension = path.extname(file).toLowerCase();
  if ([".md", ".txt", ".csv", ".json"].includes(extension)) {
    return { sourceType: "workspace-file", text: await readFile(file, "utf8"), warnings: [] };
  }
  if (extension === ".docx") {
    const { default: mammoth } = await import("mammoth");
    const result = await mammoth.extractRawText({ path: file });
    return { sourceType: "document", text: result.value, warnings: result.messages.map((message) => message.message) };
  }
  if (extension === ".pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: await readFile(file) });
    try {
      const result = await parser.getText();
      return { sourceType: "document", text: result.text, warnings: [] };
    } finally { await parser.destroy(); }
  }
  if ([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff"].includes(extension)) {
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker(["eng", "chi_sim"]);
    try {
      const result = await worker.recognize(file);
      return { sourceType: "image", text: result.data.text, warnings: ["图片 OCR 结果需要用户核对，尤其是表格和公式。"] };
    } finally { await worker.terminate(); }
  }
  throw new Error("暂不支持该资料类型：" + extension);
}

export function extractRubricLines(text: string) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => /(?:\d+\s*(?:分|points?)|评分|rubric|评审标准|评分标准)/i.test(line)).slice(0, 30);
}
