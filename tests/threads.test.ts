import assert from "node:assert/strict";
import { test } from "node:test";
import type { LinearComment } from "../src/types.ts";
import { addReply, addThread, groupComments } from "../src/threads.ts";

function comment(
  id: string,
  options: { parentId?: string | null; quotedText?: string | null; createdAt?: string } = {}
): LinearComment {
  return {
    id,
    body: `body ${id}`,
    figmaScreenshots: new Map(),
    url: `https://linear.app/comment/${id}`,
    createdAt: options.createdAt ?? `2026-01-01T00:00:0${id.length}Z`,
    resolvedAt: null,
    quotedText: options.quotedText ?? null,
    parentId: options.parentId ?? null,
    author: null,
    botActorName: null,
  };
}

test("groups inline and discussion threads and orders roots and replies", () => {
  const grouped = groupComments([
    comment("old", { createdAt: "2026-01-01T00:00:00Z" }),
    comment("root", { quotedText: "quote", createdAt: "2026-01-03T00:00:00Z" }),
    comment("reply-late", {
      parentId: "root",
      createdAt: "2026-01-03T00:00:02Z",
    }),
    comment("reply-early", {
      parentId: "root",
      createdAt: "2026-01-03T00:00:01Z",
    }),
  ]);

  assert.deepEqual(grouped.inline.map((thread) => thread.root.id), ["root"]);
  assert.equal(grouped.inline[0].kind, "inline");
  assert.deepEqual(
    grouped.inline[0].replies.map((reply) => reply.id),
    ["reply-early", "reply-late"]
  );
  assert.deepEqual(grouped.discussion.map((thread) => thread.root.id), ["old"]);
});

test("promotes comments whose parent is missing to standalone threads", () => {
  const grouped = groupComments([
    comment("orphan", { parentId: "missing", quotedText: "quote" }),
  ]);

  assert.deepEqual(grouped.inline.map((thread) => thread.root.id), ["orphan"]);
});

test("adds new threads and replies without mutating the prior grouping", () => {
  const initial = groupComments([comment("root")]);
  const withThread = addThread(
    initial,
    comment("inline", { quotedText: "quote", createdAt: "2026-01-03T00:00:00Z" })
  );
  const withReply = addReply(withThread, "root", comment("reply", { parentId: "root" }));

  assert.deepEqual(initial.inline, []);
  assert.deepEqual(initial.discussion[0].replies, []);
  assert.deepEqual(withThread.inline.map((thread) => thread.root.id), ["inline"]);
  assert.deepEqual(withReply?.discussion[0].replies.map((reply) => reply.id), ["reply"]);
  assert.equal(addReply(withThread, "missing", comment("reply")), null);
});
