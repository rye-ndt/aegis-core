import { ICleaner } from "../../../../use-cases/interface/shared/IVectorize";

export class CleanerV1Service implements ICleaner {
  process(input: string): string {
    let text = input;
    // 1. Fix common encoding artifacts
    text = text
      .replace(/â€™/g, "'")
      .replace(/â€œ/g, '"')
      .replace(/â€/g, '"')
      .replace(/â€¦/g, "...")
      .replace(/Â /g, " ")
      .normalize("NFKC"); // Unicode normalization

    // 3. Remove control characters (null bytes, BOM, etc.)
    // eslint-disable-next-line no-control-regex
    text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\uFEFF]/g, "");

    // 5. Normalize whitespace (collapse tabs, newlines, extra spaces)
    text = text
      .replace(/\r\n/g, "\n") // normalize line endings
      .replace(/\r/g, "\n")
      .replace(/[ \t]+/g, " ") // collapse horizontal whitespace
      .replace(/\n{3,}/g, "\n\n") // max 2 consecutive newlines
      .trim();

    return text.toLowerCase();
  }
}

