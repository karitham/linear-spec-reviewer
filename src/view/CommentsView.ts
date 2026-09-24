import {
  ItemView,
  WorkspaceLeaf,
  MarkdownRenderer,
  MarkdownView,
  Notice,
  Component,
  setIcon,
} from "obsidian";
import {
  LinearComment,
  CommentThread,
  GroupedComments,
  LinearSpecContext,
  LINEAR_COMMENTS_VIEW,
} from "../types";
import {
  findAllInMarkdown,
  normalizeQuoteText,
  offsetToPosition,
  toLinearQuote,
} from "../anchors";
import { addReply, addThread, groupComments } from "../threads";
import {
  getProjectComments,
  createThread,
  replyToThread,
} from "../linear/queries";

/**
 * Contract the concrete plugin must satisfy so the view never imports the
 * plugin class directly (avoids a circular dependency).
 */
export interface CommentsHost {
  app: import("obsidian").App;
  renderCommentImages(el: HTMLElement, screenshots: ReadonlyMap<string, string>): () => void;
  getSecretName(): string;
  /** Returns the active note's linear context, or null if the active file is not a linear-linked note. */
  getActiveContext(): LinearSpecContext | null;
  /** The active markdown note file, or null when no markdown file is active. */
  getActiveFile(): import("obsidian").TFile | null;
  /**
   * Called by the view after it (re)loads its body, reporting the project id it
   * now reflects (or null when no Linear note is active). Lets the host track
   * what is displayed so it can avoid redundant reloads on leaf changes.
   */
  notifyCommentsLoaded(projectId: string | null): void;
}

type CommentContext = LinearSpecContext;

/** Extract a human message from an unknown thrown value. */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Best display name for a comment's author. */
function authorName(comment: LinearComment): string {
  return comment.author?.name ?? comment.botActorName ?? "Unknown";
}

/** Thread status derived from the root comment. */
type ThreadStatus = "open" | "resolved";

function threadStatus(thread: CommentThread): ThreadStatus {
  return thread.root.resolvedAt !== null ? "resolved" : "open";
}

/** A participant that can be filtered on: a user id or a bot actor name. */
interface Participant {
  /** Stable key: `user:<id>` for users, `bot:<name>` for bot actors. */
  key: string;
  /** Display name. */
  name: string;
}

/** Stable participant key for a single comment's author. */
function participantKey(comment: LinearComment): string {
  if (comment.author !== null) {
    return `user:${comment.author.id}`;
  }
  if (comment.botActorName !== null) {
    return `bot:${comment.botActorName}`;
  }
  return "unknown:unknown";
}

/** All comments in a thread (root + replies), for participant enumeration. */
function threadComments(thread: CommentThread): LinearComment[] {
  return [thread.root, ...thread.replies];
}

/**
 * Build the sorted list of distinct participants across all threads, each with
 * the number of threads they take part in (root or reply). Used to populate the
 * people filter checklist. Sorted by descending thread count, then name.
 */
function buildParticipantsList(
  threads: CommentThread[]
): { participant: Participant; threadCount: number }[] {
  const byKey = new Map<
    string,
    { participant: Participant; threadCount: number }
  >();

  for (const thread of threads) {
    const seenInThread = new Set<string>();
    for (const c of threadComments(thread)) {
      const key = participantKey(c);
      if (seenInThread.has(key)) {
        continue;
      }
      seenInThread.add(key);
      const existing = byKey.get(key);
      if (existing !== undefined) {
        existing.threadCount += 1;
      } else {
        byKey.set(key, {
          participant: { key, name: authorName(c) },
          threadCount: 1,
        });
      }
    }
  }

  return Array.from(byKey.values()).sort((a, b) => {
    if (b.threadCount !== a.threadCount) {
      return b.threadCount - a.threadCount;
    }
    return a.participant.name.localeCompare(b.participant.name);
  });
}

/** Human-ish timestamp for a comment. */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  return d.toLocaleString();
}

/**
 * Locate every occurrence of `needle` inside the *rendered* text of `container`
 * (e.g. a note's Reading View DOM) and return each as a `Range`.
 *
 * Unlike {@link findAllInMarkdown}, no markdown-stripping is needed here: the
 * rendered DOM's text nodes already contain plain text (formatting became real
 * elements — `**bold**` is a `<strong>`, `` `code` `` is a `<code>`, etc.), so a
 * verbatim search against the concatenated text usually matches Linear's
 * plain-text `quotedText` directly. Smart quotes/dashes are normalized as a
 * fallback, mirroring the raw-markdown matcher.
 *
 * Only used for Reading View highlighting; Source/Live Preview mode never calls
 * this (it selects directly in the CM6-backed `Editor` instead).
 */
function findAllInRenderedText(container: HTMLElement, needle: string): Range[] {
  if (needle.length === 0) {
    return [];
  }

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const nodeStarts: number[] = [];
  let text = "";
  let node: Node | null;
  while ((node = walker.nextNode()) !== null) {
    const textNode = node as Text;
    nodeStarts.push(text.length);
    text += textNode.data;
    nodes.push(textNode);
  }

  // Resolve a global character index (into the concatenated `text`) to the text
  // node + in-node offset it falls within.
  function resolve(charIndex: number): { node: Text; offset: number } | null {
    for (let i = 0; i < nodes.length; i++) {
      const start = nodeStarts[i];
      const len = nodes[i].data.length;
      if (charIndex <= start + len) {
        return { node: nodes[i], offset: charIndex - start };
      }
    }
    return null;
  }

  function rangeFor(from: number, to: number): Range | null {
    const start = resolve(from);
    const end = resolve(to);
    if (start === null || end === null) {
      return null;
    }
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  }

  function collect(haystack: string, term: string): Range[] {
    const ranges: Range[] = [];
    let searchFrom = 0;
    for (;;) {
      const at = haystack.indexOf(term, searchFrom);
      if (at === -1) {
        break;
      }
      const range = rangeFor(at, at + term.length);
      if (range !== null) {
        ranges.push(range);
      }
      searchFrom = at + 1;
    }
    return ranges;
  }

  // Normalization is one-to-one, so the resulting offsets still line up with
  // the original text nodes. Search normalized text to count equivalent forms
  // together rather than hiding punctuation-equivalent duplicate occurrences.
  const normalizedText = normalizeQuoteText(text);
  const normalizedNeedle = normalizeQuoteText(needle);
  if (normalizedNeedle.length === 0) {
    return [];
  }
  return collect(normalizedText, normalizedNeedle);
}

/**
 * Poll for `needle` to appear in `container`'s rendered text, retrying
 * {@link findAllInRenderedText}. Needed because Reading View incrementally
 * (re)renders only a window of the document around the current scroll
 * position for larger notes: right after triggering a scroll, the target
 * section may not be in the DOM yet. Gives up after `timeoutMs` and returns
 * whatever the last attempt found (possibly empty).
 */
async function waitForRenderedMatches(
  container: HTMLElement,
  needle: string,
  timeoutMs = 800,
  intervalMs = 40
): Promise<Range[]> {
  const deadline = Date.now() + timeoutMs;
  let ranges = findAllInRenderedText(container, needle);
  while (ranges.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    ranges = findAllInRenderedText(container, needle);
  }
  return ranges;
}

/**
 * Wrap a Range's contents in `<mark class="lsr-preview-highlight">`. Uses
 * `extractContents()` + `insertNode()` (rather than `Range.surroundContents()`)
 * so matches spanning multiple sibling inline elements (e.g. plain text next to
 * a `<code>` or `<strong>` run) are handled correctly.
 */
function applyPreviewHighlight(range: Range): HTMLElement {
  const mark = document.createElement("mark");
  mark.className = "lsr-preview-highlight";
  mark.appendChild(range.extractContents());
  range.insertNode(mark);
  return mark;
}

/** Unwrap a previously-applied preview highlight, restoring the original DOM. */
function clearPreviewHighlight(mark: HTMLElement | null): void {
  if (mark === null) {
    return;
  }
  const parent = mark.parentNode;
  if (parent === null) {
    return;
  }
  while (mark.firstChild !== null) {
    parent.insertBefore(mark.firstChild, mark);
  }
  parent.removeChild(mark);
  parent.normalize();
}

export class CommentsView extends ItemView {
  private readonly host: CommentsHost;
  private bodyEl: HTMLElement | null = null;
  private readonly imageDisposers: Array<() => void> = [];

  private clearImagePreviews(): void {
    for (const dispose of this.imageDisposers.splice(0)) dispose();
  }
  private headerTitleEl: HTMLElement | null = null;
  /** Last markdown leaf focused before the comments panel took focus. */
  private lastMarkdownLeaf: WorkspaceLeaf | null = null;
  /**
   * Raw markdown of the active note captured at the last refresh. Occurrence
   * counts and click navigation both resolve against this snapshot so they stay
   * consistent between the rendered badges and clicks. Refreshed by `refresh()`.
   */
  private noteContentSnapshot: string | null = null;
  /** Plain-text quote captured from the active editor for a pending inline comment. */
  private pendingInlineQuote: string | null = null;
  private pendingInlineFilePath: string | null = null;
  /**
   * Next occurrence index to reveal for a given inline comment, keyed by comment
   * id. Advances (and wraps) on each click so repeated clicks cycle through all
   * matches. Reset whenever the body is re-rendered.
   */
  private occurrenceIndex = new Map<string, number>();
  /**
   * The `<mark>` element currently highlighting a quoted-text match in the
   * note's Reading View (persistent, unlike Live Preview/Source mode which only
   * gets a transient CM6 selection). Null when nothing is highlighted or the
   * note isn't in Reading View. Cleared before applying a new highlight and on
   * `refresh()`.
   */
  private activePreviewHighlight: HTMLElement | null = null;
  /**
   * Watches the Reading View container for re-renders (Obsidian prunes/rebuilds
   * sections that scroll far out of view for large notes) and reapplies
   * `activePreviewHighlight` if it gets removed, so the highlight stays "live"
   * even after scrolling away and back. Disconnected before starting a new
   * highlight, on `refresh()`, and when the view closes.
   */
  private activePreviewHighlightWatcher: MutationObserver | null = null;

  // --- Filtering state (client-side; never triggers a re-fetch) ------------
  /** Threads last fetched from Linear, cached so filter toggles re-render locally. */
  private lastThreads: GroupedComments | null = null;
  /** Context for the cached threads (used by section renderers). */
  private lastCtx: CommentContext | null = null;
  /** Container for the filter bar, rebuilt whenever filters or data change. */
  private filterBarEl: HTMLElement | null = null;
  /** Statuses currently hidden. Empty = show all. */
  private excludedStatuses = new Set<ThreadStatus>();
  /**
   * Participant keys explicitly selected to filter by (opt-in). Empty = no
   * filter applied, show everyone's threads. Non-empty = only show threads
   * where at least one participant (root or reply author) is in this set.
   */
  private includedPeople = new Set<string>();
  /** Project id the current filter state applies to; filters reset on change. */
  private filterProjectId: string | null = null;
  /** Whether the people checklist is expanded. */
  private peopleFilterExpanded = false;

  constructor(leaf: WorkspaceLeaf, plugin: CommentsHost) {
    super(leaf);
    this.host = plugin;
  }

  getViewType(): string {
    return LINEAR_COMMENTS_VIEW;
  }

  getDisplayText(): string {
    return "Linear comments";
  }

  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    const activeLeaf = this.host.app.workspace.activeLeaf;
    if (activeLeaf?.view instanceof MarkdownView) {
      this.lastMarkdownLeaf = activeLeaf;
    }
    this.registerEvent(
      this.host.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view instanceof MarkdownView) {
          this.lastMarkdownLeaf = leaf;
        }
      })
    );
    this.renderShell();
    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.clearImagePreviews();
    this.activePreviewHighlightWatcher?.disconnect();
    this.activePreviewHighlightWatcher = null;
    this.contentEl.empty();
  }

  /** Public entry point used by the plugin when the active leaf changes or via command. */
  async reload(): Promise<void> {
    await this.refresh();
  }

  /** Rebuild displayed comment cards after the image-preview setting changes. */
  rerenderPreviews(): void {
    if (this.lastThreads && this.lastCtx) this.renderFilteredBody();
  }

  /** Build the persistent shell (header + filter bar + body container) once per open. */
  private renderShell(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("lsr-comments-view");

    // Header + filter bar share one sticky container so both stay pinned.
    const sticky = root.createDiv({ cls: "lsr-sticky" });

    const header = sticky.createDiv({ cls: "lsr-header" });
    this.headerTitleEl = header.createDiv({ cls: "lsr-header-title" });

    const actions = header.createDiv({ cls: "lsr-header-actions" });

    const refreshBtn = actions.createEl("button", {
      cls: "lsr-btn lsr-refresh-btn",
      attr: { "aria-label": "Refresh", type: "button" },
    });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.createSpan({ text: "Refresh" });
    refreshBtn.addEventListener("click", () => {
      void this.refresh();
    });

    const newBtn = actions.createEl("button", {
      cls: "lsr-btn lsr-new-comment-btn",
      attr: { "aria-label": "New comment", type: "button" },
    });
    setIcon(newBtn, "plus");
    newBtn.createSpan({ text: "New comment" });
    newBtn.addEventListener("click", () => {
      this.focusNewThreadComposer();
    });

    const selectionBtn = actions.createEl("button", {
      cls: "lsr-btn lsr-selection-comment-btn",
      attr: {
        "aria-label": "Comment on selection",
        title: "Comment on selection",
        type: "button",
      },
    });
    setIcon(selectionBtn, "message-square-plus");
    selectionBtn.addEventListener("click", () => {
      void this.openSelectionComposer();
    });

    // Filter bar is (re)populated by renderFilterBar; empty until data loads.
    this.filterBarEl = sticky.createDiv({ cls: "lsr-filter-bar" });

    this.bodyEl = root.createDiv({ cls: "lsr-body" });
  }

  /** Reload comments live from Linear and re-render the body. */
  async refresh(): Promise<void> {
    if (this.bodyEl === null) {
      this.renderShell();
    }
    const body = this.bodyEl;
    if (body === null) {
      return;
    }
    this.clearImagePreviews();
    body.empty();

    // Re-rendering invalidates prior occurrence navigation state and cache.
    this.noteContentSnapshot = null;
    this.pendingInlineQuote = null;
    this.pendingInlineFilePath = null;
    this.occurrenceIndex.clear();
    this.activePreviewHighlightWatcher?.disconnect();
    this.activePreviewHighlightWatcher = null;
    clearPreviewHighlight(this.activePreviewHighlight);
    this.activePreviewHighlight = null;
    this.lastThreads = null;
    this.lastCtx = null;
    this.clearFilterBar();

    const ctx = this.host.getActiveContext();
    this.setHeaderTitle(ctx !== null ? ctx.projectName : "No Linear note active");

    if (ctx === null) {
      body.createDiv({
        cls: "lsr-empty",
        text: "Open an imported Linear spec note to see its comments.",
      });
      this.host.notifyCommentsLoaded(null);
      return;
    }

    // Filters are scoped to a project: reset them when the project changes so a
    // different note starts unfiltered, but preserve them across a manual
    // Refresh of the same note.
    if (this.filterProjectId !== ctx.projectId) {
      this.excludedStatuses.clear();
      this.includedPeople.clear();
      this.peopleFilterExpanded = false;
      this.filterProjectId = ctx.projectId;
    }

    const secretName = this.host.getSecretName();
    body.createDiv({ cls: "lsr-loading", text: "Loading comments…" });

    let comments: LinearComment[];
    try {
      comments = await getProjectComments(
        this.host.app,
        secretName,
        ctx.projectId
      );
    } catch (e) {
      const msg = errorMessage(e);
      new Notice(msg);
      body.empty();
      body.createDiv({ cls: "lsr-error", text: msg });
      // Do not record a successful load: refocusing the note may retry.
      return;
    }

    this.clearImagePreviews();
    body.empty();

    // Capture the note's raw markdown once so occurrence counts (badges) and
    // click navigation resolve against the same snapshot. Best-effort: if the
    // read fails, badges are simply omitted and clicks fall back gracefully.
    const activeFile = this.host.getActiveFile();
    if (activeFile !== null) {
      try {
        this.noteContentSnapshot = await this.host.app.vault.read(activeFile);
      } catch (e) {
        this.noteContentSnapshot = null;
        console.debug(
          "[linear-spec-review] note read for occurrence counts failed:",
          errorMessage(e)
        );
      }
    }

    this.lastThreads = groupComments(comments);
    this.lastCtx = ctx;
    this.renderFilterBar();
    this.renderFilteredBody();
    this.host.notifyCommentsLoaded(ctx.projectId);
  }

  private setHeaderTitle(text: string): void {
    if (this.headerTitleEl !== null) {
      this.headerTitleEl.setText(text);
    }
  }

  // --- Filtering -----------------------------------------------------------

  /** Empty the filter bar (used while loading / when there is no data). */
  private clearFilterBar(): void {
    if (this.filterBarEl !== null) {
      this.filterBarEl.empty();
    }
  }

  /** All threads (inline + discussion) from the cached fetch. */
  private allThreads(): CommentThread[] {
    if (this.lastThreads === null) {
      return [];
    }
    return [...this.lastThreads.inline, ...this.lastThreads.discussion];
  }

  /** True when the thread survives the current status + people filters. */
  private threadPassesFilters(thread: CommentThread): boolean {
    if (this.excludedStatuses.has(threadStatus(thread))) {
      return false;
    }
    if (this.includedPeople.size > 0) {
      // Opt-in: with nobody selected, the people filter is inactive (handled by
      // the size check above). Once someone is selected, a thread stays visible
      // if ANY participant (root or reply author) is in the selection,
      // preserving conversation context rather than hiding individual replies.
      const anyIncluded = threadComments(thread).some((c) =>
        this.includedPeople.has(participantKey(c))
      );
      if (!anyIncluded) {
        return false;
      }
    }
    return true;
  }

  private isFilterActive(): boolean {
    return this.excludedStatuses.size > 0 || this.includedPeople.size > 0;
  }

  /** (Re)build the filter bar from the cached threads and current filter state. */
  private renderFilterBar(): void {
    const bar = this.filterBarEl;
    if (bar === null) {
      return;
    }
    bar.empty();

    const threads = this.allThreads();
    if (threads.length === 0) {
      return;
    }

    // --- Status row --------------------------------------------------------
    const statusRow = bar.createDiv({ cls: "lsr-filter-row" });
    statusRow.createSpan({ cls: "lsr-filter-label", text: "Status" });

    const openCount = threads.filter((t) => threadStatus(t) === "open").length;
    const resolvedCount = threads.length - openCount;

    this.renderStatusChip(statusRow, "open", "Open", openCount);
    this.renderStatusChip(statusRow, "resolved", "Resolved", resolvedCount);

    // --- People row --------------------------------------------------------
    const participants = buildParticipantsList(threads);
    if (participants.length > 0) {
      const peopleRow = bar.createDiv({ cls: "lsr-filter-row" });
      const toggle = peopleRow.createEl("button", {
        cls: "lsr-filter-people-toggle",
        attr: { type: "button" },
      });
      const selectedPeople = this.includedPeople.size;
      const label =
        selectedPeople > 0
          ? `People (${selectedPeople} selected)`
          : `People (${participants.length})`;
      setIcon(toggle, this.peopleFilterExpanded ? "chevron-down" : "chevron-right");
      toggle.createSpan({ text: label });
      toggle.addEventListener("click", () => {
        this.peopleFilterExpanded = !this.peopleFilterExpanded;
        this.renderFilterBar();
      });

      if (this.peopleFilterExpanded) {
        const list = bar.createDiv({ cls: "lsr-people-list" });
        for (const { participant, threadCount } of participants) {
          this.renderPersonRow(list, participant, threadCount);
        }
      }
    }

    // --- Reset -------------------------------------------------------------
    if (this.isFilterActive()) {
      const resetRow = bar.createDiv({ cls: "lsr-filter-row lsr-filter-reset-row" });
      const resetBtn = resetRow.createEl("button", {
        cls: "lsr-btn lsr-filter-reset",
        attr: { type: "button" },
      });
      setIcon(resetBtn, "x");
      resetBtn.createSpan({ text: "Clear filters" });
      resetBtn.addEventListener("click", () => {
        this.excludedStatuses.clear();
        this.includedPeople.clear();
        this.renderFilterBar();
        this.renderFilteredBody();
      });
    }
  }

  private renderStatusChip(
    container: HTMLElement,
    status: ThreadStatus,
    label: string,
    count: number
  ): void {
    const excluded = this.excludedStatuses.has(status);
    const chip = container.createEl("button", {
      cls: `lsr-filter-chip${excluded ? "" : " is-active"}`,
      attr: {
        type: "button",
        "aria-pressed": excluded ? "false" : "true",
      },
    });
    chip.createSpan({ text: label });
    chip.createSpan({ cls: "lsr-filter-chip-count", text: String(count) });
    chip.addEventListener("click", () => {
      if (excluded) {
        this.excludedStatuses.delete(status);
      } else {
        this.excludedStatuses.add(status);
      }
      this.renderFilterBar();
      this.renderFilteredBody();
    });
  }

  private renderPersonRow(
    container: HTMLElement,
    participant: Participant,
    threadCount: number
  ): void {
    const selected = this.includedPeople.has(participant.key);
    const row = container.createEl("label", { cls: "lsr-person-row" });
    const checkbox = row.createEl("input", {
      attr: { type: "checkbox" },
    });
    checkbox.checked = selected;
    row.createSpan({ cls: "lsr-person-name", text: participant.name });
    row.createSpan({ cls: "lsr-person-count", text: String(threadCount) });
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        this.includedPeople.add(participant.key);
      } else {
        this.includedPeople.delete(participant.key);
      }
      // Update the toggle label + reset button without collapsing the list.
      this.renderFilterBar();
      this.renderFilteredBody();
    });
  }

  /** Render the body sections from cached threads, applying current filters. */
  private renderFilteredBody(): void {
    const body = this.bodyEl;
    const ctx = this.lastCtx;
    if (body === null || ctx === null || this.lastThreads === null) {
      return;
    }
    this.clearImagePreviews();
    body.empty();
    // Filtering invalidates prior occurrence navigation indices.
    this.occurrenceIndex.clear();

    const inline = this.lastThreads.inline.filter((t) =>
      this.threadPassesFilters(t)
    );
    const discussion = this.lastThreads.discussion.filter((t) =>
      this.threadPassesFilters(t)
    );

    const totalThreads = this.allThreads().length;
    const visibleThreads = inline.length + discussion.length;

    // When filters hide everything, lead with an explicit note so the empty
    // sections don't read like "there are no comments at all".
    if (this.isFilterActive() && totalThreads > 0 && visibleThreads === 0) {
      body.createDiv({
        cls: "lsr-empty",
        text: `No comments match the current filters (${totalThreads} hidden).`,
      });
    }

    this.renderInlineSection(body, inline, ctx, this.noteContentSnapshot);
    this.renderDiscussionSection(body, discussion, ctx);
  }

  /** Render inline threads and the pending selection composer. */
  private renderInlineSection(
    container: HTMLElement,
    threads: CommentThread[],
    ctx: CommentContext,
    content: string | null
  ): void {
    const section = container.createDiv({ cls: "lsr-section lsr-inline-section" });
    section.createEl("h3", { cls: "lsr-section-title", text: "Inline comments" });

    if (this.pendingInlineQuote !== null) {
      this.renderSelectionComposer(section, this.pendingInlineQuote, ctx);
    }

    if (threads.length === 0) {
      section.createDiv({ cls: "lsr-empty", text: "No inline comments." });
      return;
    }

    for (const thread of threads) {
      const threadEl = section.createDiv({ cls: "lsr-thread lsr-inline-thread" });
      const quoted = thread.root.quotedText;
      if (quoted !== null && quoted.length > 0) {
        const quotedEl = threadEl.createDiv({
          cls: "lsr-quoted lsr-quoted-clickable",
        });
        quotedEl.createSpan({ cls: "lsr-quoted-text", text: quoted });

        // Occurrence badge: only shown when the snippet appears more than once.
        // Clicking then cycles through each match (see scrollEditorToQuotedText).
        const occurrences =
          content !== null ? findAllInMarkdown(content, quoted).length : 0;
        let badgeEl: HTMLElement | null = null;
        if (occurrences > 1) {
          badgeEl = quotedEl.createSpan({
            cls: "lsr-occurrence-badge",
            text: `1 / ${occurrences}`,
          });
          quotedEl.setAttr(
            "title",
            "Click to jump to this text; click again for the next occurrence"
          );
        } else {
          quotedEl.setAttr("title", "Click to jump to this text in the note");
        }

        const commentId = thread.root.id;
        quotedEl.addEventListener("click", () => {
          void this.scrollEditorToQuotedText(quoted, commentId, badgeEl);
        });
      }
      this.renderThreadBodies(threadEl, thread, ctx);
    }
  }

  private renderDiscussionSection(
    container: HTMLElement,
    threads: CommentThread[],
    ctx: CommentContext
  ): void {
    const section = container.createDiv({
      cls: "lsr-section lsr-discussion-section",
    });
    section.createEl("h3", { cls: "lsr-section-title", text: "Discussion" });

    this.renderNewThreadComposer(section, ctx);

    if (threads.length === 0) {
      section.createDiv({ cls: "lsr-empty", text: "No discussion comments." });
      return;
    }

    for (const thread of threads) {
      const threadEl = section.createDiv({
        cls: "lsr-thread lsr-discussion-thread",
      });
      this.renderThreadBodies(threadEl, thread, ctx);
    }
  }

  /** Render the root comment, its replies, resolved badge, and reply box. */
  private renderThreadBodies(
    threadEl: HTMLElement,
    thread: CommentThread,
    ctx: CommentContext
  ): void {
    const resolved = thread.root.resolvedAt !== null;
    if (resolved) {
      threadEl.addClass("lsr-thread-resolved");
    }

    this.renderComment(threadEl, thread.root, resolved);
    for (const reply of thread.replies) {
      this.renderComment(threadEl, reply, false);
    }

    this.renderReplyBox(threadEl, thread.root.id, ctx);
  }

  /** Render a single comment card. `showResolved` adds the read-only badge. */
  private renderComment(
    container: HTMLElement,
    comment: LinearComment,
    showResolved: boolean
  ): void {
    const commentEl = container.createDiv({ cls: "lsr-comment" });

    const meta = commentEl.createDiv({ cls: "lsr-comment-meta" });
    meta.createSpan({ cls: "lsr-comment-author", text: authorName(comment) });
    meta.createSpan({
      cls: "lsr-comment-time",
      text: formatTimestamp(comment.createdAt),
    });
    if (showResolved) {
      meta.createSpan({ cls: "lsr-resolved-badge", text: "Resolved" });
    }

    const bodyEl = commentEl.createDiv({ cls: "lsr-comment-body" });
    // MarkdownRenderer.render(app, markdown, el, sourcePath, component).
    // Pass `this` (an ItemView, which is a Component) so child components are
    // unloaded when the view is unloaded.
    void MarkdownRenderer.render(
      this.host.app,
      comment.body,
      bodyEl,
      "",
      this as Component
    ).then(() => {
      if (bodyEl.isConnected) {
        this.imageDisposers.push(this.host.renderCommentImages(bodyEl, comment.figmaScreenshots));
      }
    }).catch((e: unknown) => {
      bodyEl.setText(comment.body);
      new Notice(`Failed to render comment: ${errorMessage(e)}`);
    });
  }

  /** Render the reply composer for a thread. */
  private renderReplyBox(
    threadEl: HTMLElement,
    parentId: string,
    ctx: CommentContext
  ): void {
    const box = threadEl.createDiv({ cls: "lsr-reply-box" });
    const textarea = box.createEl("textarea", {
      cls: "lsr-reply-input",
      attr: { placeholder: "Reply…", rows: "2" },
    });
    const button = box.createEl("button", {
      cls: "lsr-btn lsr-reply-btn",
      text: "Reply",
      attr: { type: "button" },
    });

    button.addEventListener("click", () => {
      void this.submitReply(textarea, button, parentId, ctx);
    });
  }

  private async submitReply(
    textarea: HTMLTextAreaElement,
    button: HTMLButtonElement,
    parentId: string,
    ctx: CommentContext
  ): Promise<void> {
    const body = textarea.value.trim();
    if (body.length === 0) {
      new Notice("Reply cannot be empty.");
      return;
    }

    button.disabled = true;
    textarea.disabled = true;
    try {
      const reply = await replyToThread(
        this.host.app,
        this.host.getSecretName(),
        ctx.documentContentId,
        parentId,
        body
      );
      new Notice("Reply posted.");
      this.patchReplyIntoCache(parentId, reply);
    } catch (e) {
      new Notice(errorMessage(e));
      button.disabled = false;
      textarea.disabled = false;
    }
  }

  /** Capture a non-empty, uniquely locatable editor selection for an inline comment. */
  private openSelectionComposer(): void {
    const file = this.host.getActiveFile();
    if (file === null) {
      new Notice("Open the Linear spec note and select text first.");
      return;
    }

    const activeContext = this.host.getActiveContext();
    if (
      activeContext === null ||
      this.lastCtx === null ||
      activeContext.projectId !== this.lastCtx.projectId ||
      activeContext.documentContentId !== this.lastCtx.documentContentId
    ) {
      new Notice("Open the matching Linear spec note before commenting on a selection.");
      return;
    }

    const lastLeaf = this.lastMarkdownLeaf;
    const leaf =
      lastLeaf?.view instanceof MarkdownView && lastLeaf.view.file?.path === file.path
        ? lastLeaf
        : this.host.app.workspace.getLeavesOfType("markdown").find((candidate) =>
        candidate.view instanceof MarkdownView &&
        candidate.view.file?.path === file.path
      );
    if (leaf === undefined || !(leaf.view instanceof MarkdownView)) {
      new Notice("Open the Linear spec note in an editor and select text first.");
      return;
    }
    if (leaf.view.getMode() !== "source") {
      new Notice("Switch the Linear spec note to editing mode to comment on a selection.");
      return;
    }

    const selection = leaf.view.editor.getSelection();
    const quote = toLinearQuote(selection);
    if (quote.length === 0) {
      new Notice("Select some text in the spec before commenting.");
      return;
    }

    const matches = findAllInMarkdown(leaf.view.editor.getValue(), quote);
    if (matches.length === 0) {
      new Notice("Could not map the selection to plain text for a Linear anchor.");
      return;
    }
    if (matches.length > 1) {
      new Notice("This text appears more than once. Select a longer, unique passage.");
      return;
    }

    this.pendingInlineQuote = quote;
    this.pendingInlineFilePath = file.path;
    this.renderFilteredBody();
    this.bodyEl
      ?.querySelector<HTMLTextAreaElement>(".lsr-selection-comment-input")
      ?.focus();
  }

  private renderSelectionComposer(
    container: HTMLElement,
    quote: string,
    ctx: CommentContext
  ): void {
    const composer = container.createDiv({ cls: "lsr-selection-composer" });
    composer.createDiv({ cls: "lsr-selection-quote", text: quote });
    const textarea = composer.createEl("textarea", {
      cls: "lsr-reply-input lsr-selection-comment-input",
      attr: { placeholder: "Comment on this text…", rows: "3" },
    });
    const actions = composer.createDiv({ cls: "lsr-selection-actions" });
    const cancel = actions.createEl("button", {
      cls: "lsr-btn",
      text: "Cancel",
      attr: { type: "button" },
    });
    cancel.addEventListener("click", () => {
      this.pendingInlineQuote = null;
      this.pendingInlineFilePath = null;
      this.renderFilteredBody();
    });

    const submit = actions.createEl("button", {
      cls: "lsr-btn lsr-selection-submit",
      text: "Comment",
      attr: { type: "button" },
    });
    submit.addEventListener("click", () => {
      const filePath = this.pendingInlineFilePath;
      if (filePath === null) {
        new Notice("The selected note is no longer available. Re-select the text.");
        return;
      }
      void this.submitSelectionComment(textarea, submit, quote, filePath, ctx);
    });
  }

  private async submitSelectionComment(
    textarea: HTMLTextAreaElement,
    button: HTMLButtonElement,
    quote: string,
    filePath: string,
    ctx: CommentContext
  ): Promise<void> {
    const body = textarea.value.trim();
    if (body.length === 0) {
      new Notice("Comment cannot be empty.");
      return;
    }

    const activeFile = this.host.getActiveFile();
    const activeContext = this.host.getActiveContext();
    if (
      (activeFile !== null && activeFile.path !== filePath) ||
      (activeContext !== null &&
        activeContext.documentContentId !== ctx.documentContentId)
    ) {
      new Notice("The active note changed. Re-select text in the matching Linear spec.");
      return;
    }

    const currentLeaf = this.host.app.workspace
      .getLeavesOfType("markdown")
      .find((candidate) =>
        candidate.view instanceof MarkdownView &&
        candidate.view.file?.path === filePath
      );
    if (
      currentLeaf === undefined ||
      !(currentLeaf.view instanceof MarkdownView) ||
      findAllInMarkdown(currentLeaf.view.editor.getValue(), quote).length !== 1
    ) {
      new Notice("The selected text changed or is no longer unique in the spec.");
      return;
    }

    button.disabled = true;
    textarea.disabled = true;
    try {
      const created = await createThread(
        this.host.app,
        this.host.getSecretName(),
        ctx.documentContentId,
        body,
        quote
      );
      this.pendingInlineQuote = null;
      this.pendingInlineFilePath = null;
      new Notice("Inline comment posted.");
      this.patchNewThreadIntoCache(created);
    } catch (e) {
      new Notice(errorMessage(e));
      button.disabled = false;
      textarea.disabled = false;
    }
  }

  /** Render the top-of-discussion composer for creating a brand-new thread. */
  private renderNewThreadComposer(
    container: HTMLElement,
    ctx: CommentContext
  ): void {
    const box = container.createDiv({ cls: "lsr-reply-box lsr-new-thread-box" });
    const textarea = box.createEl("textarea", {
      cls: "lsr-reply-input lsr-new-thread-input",
      attr: { placeholder: "Start a new discussion…", rows: "3" },
    });
    const button = box.createEl("button", {
      cls: "lsr-btn lsr-new-thread-btn",
      text: "New thread",
      attr: { type: "button" },
    });

    button.addEventListener("click", () => {
      void this.submitNewThread(textarea, button, ctx);
    });
  }

  private async submitNewThread(
    textarea: HTMLTextAreaElement,
    button: HTMLButtonElement,
    ctx: CommentContext
  ): Promise<void> {
    const body = textarea.value.trim();
    if (body.length === 0) {
      new Notice("Comment cannot be empty.");
      return;
    }

    button.disabled = true;
    textarea.disabled = true;
    try {
      const created = await createThread(
        this.host.app,
        this.host.getSecretName(),
        ctx.documentContentId,
        body
      );
      new Notice("Comment posted.");
      this.patchNewThreadIntoCache(created);
    } catch (e) {
      new Notice(errorMessage(e));
      button.disabled = false;
      textarea.disabled = false;
    }
  }

  /**
   * Insert a freshly-posted reply into the cached thread list and re-render
   * locally, instead of re-fetching every comment from Linear. The mutation
   * already returns the fully-mapped comment, so there is nothing left to
   * fetch. Falls back to a full `refresh()` if the parent thread cannot be
   * found in the cache (should not normally happen).
   */
  private patchReplyIntoCache(parentId: string, reply: LinearComment): void {
    if (this.lastThreads === null) {
      void this.refresh();
      return;
    }
    const updated = addReply(this.lastThreads, parentId, reply);
    if (updated === null) {
      void this.refresh();
      return;
    }
    this.lastThreads = updated;

    this.renderFilterBar();
    this.renderFilteredBody();
  }

  /**
   * Insert a freshly-posted top-level thread into the cached discussion list
   * and re-render locally (see {@link patchReplyIntoCache}). The API response
   * determines whether it belongs in the inline or discussion section.
   */
  private patchNewThreadIntoCache(created: LinearComment): void {
    if (this.lastThreads === null) {
      void this.refresh();
      return;
    }
    this.lastThreads = addThread(this.lastThreads, created);

    this.renderFilterBar();
    this.renderFilteredBody();
  }

  /** Scroll to and focus the new-thread composer (used by the header button). */
  private focusNewThreadComposer(): void {
    if (this.bodyEl === null) {
      return;
    }
    const input = this.bodyEl.querySelector<HTMLTextAreaElement>(
      ".lsr-new-thread-input"
    );
    if (input !== null) {
      input.scrollIntoView({ block: "center" });
      input.focus();
    } else {
      new Notice("Open a Linear spec note to add a comment.");
    }
  }

  /**
   * Locate an inline comment's `quotedText` in the active note and reveal it in
   * the editor: select the matched range and scroll it into view.
   *
   * When the snippet occurs multiple times, repeated clicks cycle through each
   * occurrence (wrapping around), advancing `occurrenceIndex` per comment and
   * updating the `x / N` badge. Matches resolve against `noteContentSnapshot`
   * (captured at the last refresh) so the count shown on the badge and the
   * navigation stay consistent; if no snapshot exists it reads once as a
   * fallback.
   *
   * All editor interaction goes through Obsidian's stable `Editor` API — no CM6
   * internals.
   */
  private async scrollEditorToQuotedText(
    quoted: string,
    commentId: string,
    badgeEl: HTMLElement | null
  ): Promise<void> {
    const file = this.host.getActiveFile();
    if (file === null) {
      new Notice("Open the Linear spec note to jump to quoted text.");
      return;
    }

    // Find the markdown leaf that holds this note. We cannot use
    // `getActiveViewOfType(MarkdownView)` because clicking the panel makes the
    // panel the active leaf, so the note is never the active view at this point.
    const workspace = this.host.app.workspace;
    const mdLeaf = workspace
      .getLeavesOfType("markdown")
      .find((leaf) => {
        const view = leaf.view;
        return view instanceof MarkdownView && view.file?.path === file.path;
      });

    if (mdLeaf === undefined || !(mdLeaf.view instanceof MarkdownView)) {
      new Notice("Open the Linear spec note in a pane to jump to quoted text.");
      return;
    }
    const view = mdLeaf.view;

    // Reuse the refresh snapshot so navigation matches the rendered count.
    let content = this.noteContentSnapshot;
    if (content === null) {
      try {
        content = await this.host.app.vault.read(file);
      } catch (e) {
        new Notice(`Could not read the note: ${errorMessage(e)}`);
        return;
      }
    }

    const matches = findAllInMarkdown(content, quoted);
    if (matches.length === 0) {
      new Notice("Could not locate the quoted text in this note.");
      return;
    }

    // Pick the occurrence to reveal, then advance (wrapping) for the next click.
    const total = matches.length;
    const current = this.occurrenceIndex.get(commentId) ?? 0;
    const index = current % total;
    this.occurrenceIndex.set(commentId, (index + 1) % total);

    if (badgeEl !== null) {
      badgeEl.setText(`${index + 1} / ${total}`);
    }

    const match = matches[index];
    const fromPos = offsetToPosition(content, match.from);
    const toPos = offsetToPosition(content, match.to);

    // Focus the note's leaf so the selection is visible (this also brings a
    // background tab to the front). In reading mode there is no live editor to
    // select in, so fall back to scrolling the rendered preview to the line.
    this.host.app.workspace.setActiveLeaf(mdLeaf, { focus: true });

    if (view.getMode() !== "source") {
      // Reading/preview mode: no CM6 editor. Scroll the preview to the line
      // instead of selecting; `applyScroll` accepts a (fractional) line number.
      const previewScrolled = this.scrollPreviewToLine(view, fromPos.line);
      // Also apply a persistent highlight of the exact matched text. This is
      // Reading-View-only: unlike Live Preview/Source mode, reading view is
      // static rendered HTML with no CM6 involved, so an injected `<mark>`
      // isn't wiped by re-renders (see the CM6 findings in AGENT.md — that
      // blocker does not apply here).
      await this.applyReadingViewHighlight(view, quoted, index);
      if (!previewScrolled) {
        new Notice(
          "Switch the note to editing view to jump to the quoted text."
        );
      }
      return;
    }

    const editor = view.editor;
    // The editor mutations are wrapped because a mis-behaving CM6 decoration
    // provider registered elsewhere in the workspace can throw synchronously
    // from inside `setSelection`'s transaction dispatch (an "isEmpty" TypeError
    // originating in Obsidian/other plugins, not here). The selection is still
    // applied before that re-render step, so we swallow the error to avoid a
    // spurious uncaught exception surfacing from this click handler.
    try {
      editor.setSelection(fromPos, toPos);
      editor.scrollIntoView({ from: fromPos, to: toPos }, true);
    } catch (e) {
      console.debug(
        "[linear-spec-review] editor reveal raised (non-fatal):",
        errorMessage(e)
      );
    }
  }

  /**
   * Scroll a markdown view's rendered preview (reading mode) to a line.
   *
   * Obsidian's reading view has no `Editor`, but `MarkdownView.setEphemeralState`
   * accepts a `{ line }` and scrolls the preview to it — the same mechanism used
   * when following a link into a note. Returns false if the API is unavailable.
   */
  private scrollPreviewToLine(view: MarkdownView, line: number): boolean {
    try {
      view.setEphemeralState({ line });
      return true;
    } catch (e) {
      console.debug(
        "[linear-spec-review] preview scroll raised (non-fatal):",
        errorMessage(e)
      );
      return false;
    }
  }

  /**
   * Persistently highlight the exact occurrence of `quoted` in the note's
   * Reading View. Clears any previous highlight first so only one is ever
   * active. Best-effort: if the rendered text doesn't yield the expected
   * occurrence (e.g. a rare mismatch between raw-markdown and rendered-text
   * matching), this silently no-ops — the scroll-to-line still succeeded.
   *
   * Reading View incrementally (re)renders only a window of the document
   * around the current scroll position for larger notes — it is not fully
   * static — so the target text may not exist in the DOM yet immediately
   * after triggering the scroll. This polls briefly for it to appear.
   */
  private async applyReadingViewHighlight(
    view: MarkdownView,
    quoted: string,
    occurrenceIndex: number
  ): Promise<void> {
    this.activePreviewHighlightWatcher?.disconnect();
    this.activePreviewHighlightWatcher = null;
    clearPreviewHighlight(this.activePreviewHighlight);
    this.activePreviewHighlight = null;

    const container = view.previewMode?.containerEl;
    if (container === undefined) {
      return;
    }

    try {
      const ranges = await waitForRenderedMatches(container, quoted);
      const range = ranges[occurrenceIndex];
      if (range === undefined) {
        return;
      }
      this.activePreviewHighlight = applyPreviewHighlight(range);
      this.watchPreviewHighlight(container, quoted, occurrenceIndex);
    } catch (e) {
      console.debug(
        "[linear-spec-review] preview highlight raised (non-fatal):",
        errorMessage(e)
      );
    }
  }

  /**
   * Reapply the highlight if Obsidian's Reading View prunes/rebuilds the
   * section it lives in (this happens when the user scrolls far enough away
   * and back, for large notes — see {@link waitForRenderedMatches}). Without
   * this, the highlight would only survive until the next such re-render.
   */
  private watchPreviewHighlight(
    container: HTMLElement,
    quoted: string,
    occurrenceIndex: number
  ): void {
    const observer = new MutationObserver(() => {
      if (this.activePreviewHighlight?.isConnected === true) {
        return;
      }
      const ranges = findAllInRenderedText(container, quoted);
      const range = ranges[occurrenceIndex];
      if (range === undefined) {
        return;
      }
      // Re-inserting the mark triggers this same observer again; the
      // `isConnected` check above makes that a harmless no-op next time.
      this.activePreviewHighlight = applyPreviewHighlight(range);
    });
    observer.observe(container, { childList: true, subtree: true });
    this.activePreviewHighlightWatcher = observer;
  }
}
