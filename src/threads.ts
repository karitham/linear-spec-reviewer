import type {
  CommentThread,
  DiscussionCommentThread,
  GroupedComments,
  InlineCommentThread,
  LinearComment,
} from "./types";

/** Group Linear's flat comment list into sorted root threads. */
export function groupComments(comments: LinearComment[]): GroupedComments {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const threads = new Map<string, CommentThread>();

  for (const comment of comments) {
    if (comment.parentId === null || !byId.has(comment.parentId)) {
      threads.set(comment.id, makeThread(comment));
    }
  }

  for (const comment of comments) {
    if (comment.parentId === null) continue;

    const parentThread = threads.get(comment.parentId);
    if (parentThread === undefined) {
      if (!threads.has(comment.id)) threads.set(comment.id, makeThread(comment));
      continue;
    }

    parentThread.replies.push(comment);
  }

  const all = [...threads.values()];
  for (const thread of all) {
    thread.replies.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  all.sort((left, right) => right.root.createdAt.localeCompare(left.root.createdAt));

  return {
    inline: all.filter((thread) => thread.kind === "inline"),
    discussion: all.filter((thread) => thread.kind === "discussion"),
  };
}

/** Add a newly created root, preserving the newest-first thread ordering. */
export function addThread(
  grouped: GroupedComments,
  comment: LinearComment
): GroupedComments {
  const thread = makeThread(comment);
  if (thread.kind === "inline") {
    return { ...grouped, inline: sortInlineThreads([thread, ...grouped.inline]) };
  }
  return {
    ...grouped,
    discussion: sortDiscussionThreads([thread, ...grouped.discussion]),
  };
}

/** Return an updated grouping with a reply, or null when its root is not cached. */
export function addReply(
  grouped: GroupedComments,
  parentId: string,
  reply: LinearComment
): GroupedComments | null {
  const inlineIndex = grouped.inline.findIndex(
    (thread) => thread.root.id === parentId
  );
  if (inlineIndex !== -1) {
    const inline = [...grouped.inline];
    inline[inlineIndex] = {
      ...inline[inlineIndex],
      replies: sortReplies([...inline[inlineIndex].replies, reply]),
    };
    return { ...grouped, inline };
  }

  const discussionIndex = grouped.discussion.findIndex(
    (thread) => thread.root.id === parentId
  );
  if (discussionIndex === -1) return null;

  const discussion = [...grouped.discussion];
  discussion[discussionIndex] = {
    ...discussion[discussionIndex],
    replies: sortReplies([...discussion[discussionIndex].replies, reply]),
  };
  return { ...grouped, discussion };
}

function makeThread(comment: LinearComment): CommentThread {
  const quotedText = comment.quotedText;
  if (quotedText !== null) {
    return {
      kind: "inline",
      root: { ...comment, quotedText },
      replies: [],
    };
  }
  return {
    kind: "discussion",
    root: { ...comment, quotedText: null },
    replies: [],
  };
}

function sortInlineThreads(
  threads: InlineCommentThread[]
): InlineCommentThread[] {
  return threads.sort((left, right) =>
    right.root.createdAt.localeCompare(left.root.createdAt)
  );
}

function sortDiscussionThreads(
  threads: DiscussionCommentThread[]
): DiscussionCommentThread[] {
  return threads.sort((left, right) =>
    right.root.createdAt.localeCompare(left.root.createdAt)
  );
}

function sortReplies(replies: LinearComment[]): LinearComment[] {
  return replies.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt)
  );
}
