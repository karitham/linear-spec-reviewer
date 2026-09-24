import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findAllInMarkdown,
  offsetToPosition,
  toLinearQuote,
} from "../src/anchors.ts";

test("converts selected inline markdown to Linear's quote text", () => {
  assert.equal(toLinearQuote("**bold** and `code`"), "bold and code");
  assert.equal(toLinearQuote("snake_case"), "snake_case");
  assert.equal(toLinearQuote("\\[escaped\\]"), "[escaped]");
  assert.equal(toLinearQuote("*literal \\* not emphasis"), "*literal * not emphasis");
  assert.equal(toLinearQuote("data/*.csv"), "data/*.csv");
  assert.equal(toLinearQuote("src/**/*.ts"), "src/**/*.ts");
});

test("counts raw glob quotes even when the note contains multiple copies", () => {
  assert.equal(
    findAllInMarkdown("data/*.csv and data/*.csv", "data/*.csv").length,
    2
  );
});

test("maps a formatted quote back to its raw markdown range", () => {
  const markdown = "before **the selected text** after";
  const [match] = findAllInMarkdown(markdown, "the selected text");

  assert.deepEqual(match, {
    from: markdown.indexOf("the selected text"),
    to: markdown.indexOf("the selected text") + "the selected text".length,
  });
});

test("does not include a closing code delimiter in the mapped range", () => {
  const markdown = "use `pnpm build` now";
  const [match] = findAllInMarkdown(markdown, "pnpm build");

  assert.deepEqual(match, {
    from: markdown.indexOf("pnpm build"),
    to: markdown.indexOf("pnpm build") + "pnpm build".length,
  });
});

test("maps escaped punctuation across both source characters", () => {
  const markdown = String.raw`\[id\]`;

  assert.deepEqual(findAllInMarkdown(markdown, "[id]"), [
    { from: 0, to: markdown.length },
  ]);
  assert.deepEqual(findAllInMarkdown(String.raw`x \*y`, "*y"), [
    { from: 2, to: 5 },
  ]);
});

test("finds every plain-text occurrence, including overlapping ones", () => {
  assert.deepEqual(findAllInMarkdown("**same** and same", "same").length, 2);
  assert.equal(findAllInMarkdown("**same** and same", "same")[0].to, 6);
  assert.deepEqual(findAllInMarkdown("banana", "ana"), [
    { from: 1, to: 4 },
    { from: 3, to: 6 },
  ]);
});

test("normalizes smart punctuation while preserving raw offsets", () => {
  const markdown = "She said “yes”—then left…";
  const [match] = findAllInMarkdown(markdown, '"yes"-then left.');

  assert.deepEqual(match, {
    from: markdown.indexOf("“yes”"),
    to: markdown.length,
  });
});

test("converts raw offsets to Obsidian editor positions", () => {
  assert.deepEqual(offsetToPosition("first\nsecond", 8), { line: 1, ch: 2 });
});
