import { Parser } from "htmlparser2";

export const MAX_EXCERPT_LENGTH = 1500;

const SKIPPED_ELEMENTS = new Set(["script", "style", "noscript", "template"]);
const BLOCK_ELEMENTS = new Set([
  "article",
  "blockquote",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "p",
  "pre",
  "section",
  "tr",
]);

const BOILERPLATE_LINES: readonly RegExp[] = [/^([\w# ]+:\s*)?https?:\/\/\S+$/i, /^The post .+ appeared first on .+$/i];

export function htmlToText(html: string): string {
  const chunks: string[] = [];
  let skippedDepth = 0;

  const parser = new Parser({
    onopentag(name) {
      if (SKIPPED_ELEMENTS.has(name)) skippedDepth++;
      if (name === "br") chunks.push("\n");
      if (BLOCK_ELEMENTS.has(name)) chunks.push("\n\n");
    },
    ontext(text) {
      if (skippedDepth === 0) chunks.push(text);
    },
    onclosetag(name) {
      if (SKIPPED_ELEMENTS.has(name)) skippedDepth--;
      if (BLOCK_ELEMENTS.has(name)) chunks.push("\n\n");
    },
  });
  parser.end(html);

  return normalizeWhitespace(chunks.join(""));
}

export function cleanExcerpt(text: string | null | undefined, maxLength = MAX_EXCERPT_LENGTH): string | null {
  const meaningfulLines = (text ?? "")
    .split("\n")
    .filter((line) => !BOILERPLATE_LINES.some((pattern) => pattern.test(line.trim())));
  return normalizeWhitespace(meaningfulLines.join("\n")).slice(0, maxLength).trim() || null;
}

function normalizeWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line, index, lines) => line !== "" || (index > 0 && lines[index - 1] !== ""))
    .join("\n")
    .trim();
}
