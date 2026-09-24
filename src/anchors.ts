/** A half-open range in raw Markdown, measured in UTF-16 code units. */
export interface TextRange {
  from: number;
  to: number;
}

interface MarkdownProjection {
  text: string;
  rawStarts: number[];
  rawEnds: number[];
}

/** Convert selected Markdown into the plain-text quote sent to Linear. */
export function toLinearQuote(selection: string): string {
  return projectMarkdown(selection).text.trim();
}

/** Normalize punctuation the same way in Linear quotes and rendered note text. */
export function normalizeQuoteText(text: string): string {
  let normalized = "";
  for (let i = 0; i < text.length; i++) {
    normalized += normalizeCharacter(text[i]);
  }
  return normalized;
}

/** Locate every quote occurrence in Markdown and map each range to raw offsets. */
export function findAllInMarkdown(raw: string, quote: string): TextRange[] {
  const needle = normalizeQuoteText(quote);
  if (needle.length === 0) return [];

  const projection = projectMarkdown(raw);
  const matches = new Map<number, TextRange>();
  let verbatimFrom = 0;
  for (;;) {
    const index = raw.indexOf(quote, verbatimFrom);
    if (index === -1) break;
    const match = { from: index, to: index + quote.length };
    matches.set(match.to, match);
    verbatimFrom = index + 1;
  }

  let searchFrom = 0;
  for (;;) {
    const index = projection.text.indexOf(needle, searchFrom);
    if (index === -1) {
      return [...matches.values()].sort((left, right) => left.from - right.from);
    }

    const from = projection.rawStarts[index];
    const to = projection.rawEnds[index + needle.length - 1];
    if (from !== undefined && to !== undefined) {
      // An escaped character starts at its backslash in the projection but at
      // the character in a verbatim search; a shared end identifies that one hit.
      const existing = matches.get(to);
      matches.set(to, {
        from: existing === undefined ? from : Math.min(existing.from, from),
        to,
      });
    }
    // Include overlapping matches so ambiguity checks do not silently miss one.
    searchFrom = index + 1;
  }
}

/** Convert a raw Markdown offset to Obsidian's zero-based line/ch position. */
export function offsetToPosition(
  content: string,
  offset: number
): { line: number; ch: number } {
  const clamped = Math.max(0, Math.min(offset, content.length));
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < clamped; i++) {
    if (content[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, ch: clamped - lineStart };
}

function projectMarkdown(raw: string): MarkdownProjection {
  let text = "";
  const rawStarts: number[] = [];
  const rawEnds: number[] = [];
  const closingDelimiters = new Map<number, number>();
  let index = 0;

  while (index < raw.length) {
    const character = raw[index];

    if (character === "\\" && index + 1 < raw.length) {
      text += normalizeCharacter(raw[index + 1]);
      rawStarts.push(index);
      rawEnds.push(index + 2);
      index += 2;
      continue;
    }

    const matchedClose = closingDelimiters.get(index);
    if (matchedClose !== undefined) {
      index += matchedClose;
      continue;
    }

    if (character === "`" || character === "*" || character === "_") {
      const runLength = delimiterRunLength(raw, index, character);
      const close = findClosingDelimiter(raw, index, character, runLength);
      if (close !== -1) {
        closingDelimiters.set(close, runLength);
        index += runLength;
        continue;
      }

      for (let runIndex = 0; runIndex < runLength; runIndex++) {
        text += character;
        rawStarts.push(index + runIndex);
        rawEnds.push(index + runIndex + 1);
      }
      index += runLength;
      continue;
    }

    text += normalizeCharacter(character);
    rawStarts.push(index);
    rawEnds.push(index + 1);
    index++;
  }

  return { text, rawStarts, rawEnds };
}

function delimiterRunLength(text: string, start: number, delimiter: string): number {
  let end = start;
  while (end < text.length && text[end] === delimiter) end++;
  return end - start;
}

function findClosingDelimiter(
  text: string,
  open: number,
  delimiter: string,
  runLength: number
): number {
  if (delimiter !== "`" && runLength > 3) return -1;
  if (delimiter !== "`" && isWhitespace(text[open + runLength])) return -1;
  if (delimiter === "_" && isWordCharacter(text[open - 1])) return -1;

  for (let index = open + runLength; index < text.length; index++) {
    if (text[index] === "\\") {
      index++;
      continue;
    }
    if (text[index] !== delimiter) continue;
    const candidateLength = delimiterRunLength(text, index, delimiter);
    if (candidateLength !== runLength) {
      index += candidateLength - 1;
      continue;
    }
    if (delimiter !== "`" && isWhitespace(text[index - 1])) continue;
    if (delimiter === "_" && isWordCharacter(text[index + candidateLength])) continue;
    return index;
  }
  return -1;
}

function isWhitespace(character: string | undefined): boolean {
  return character === undefined || /\s/.test(character);
}

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}]/u.test(character);
}

function normalizeCharacter(character: string): string {
  switch (character) {
    case "\u2018": // ‘
    case "\u2019": // ’
    case "\u201B": // ‛
      return "'";
    case "\u201C": // “
    case "\u201D": // ”
    case "\u201F": // ‟
      return '"';
    case "\u2013": // – en dash
    case "\u2014": // — em dash
      return "-";
    case "\u2026": // …
      return ".";
    default:
      return character;
  }
}
