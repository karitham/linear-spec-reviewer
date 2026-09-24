// Shared types for the Linear Spec Review plugin.
// These mirror exactly the GraphQL fields validated against the Linear API.

export interface LinearUserRef {
  id: string;
  name: string;
  displayName?: string | null;
}

/** Linear identity and display metadata carried by an imported spec note. */
export interface LinearSpecContext {
  projectId: string;
  documentContentId: string;
  projectName: string;
}

/** A Linear project as returned by `searchProjects` (browse/URL resolution). */
export interface ProjectSearchResult {
  id: string;
  name: string;
  slugId: string;
  url: string;
}

/** Full project overview + metadata used to build the note. */
export interface ProjectOverview {
  id: string;
  name: string;
  url: string;
  slugId: string;
  icon: string | null;
  color: string | null;
  /** Markdown overview body. Already clean markdown from the API (no <linear-*> tags). */
  content: string;
  /** Short one-line description (usually empty); NOT the overview body. */
  description: string;
  priority: number;
  priorityLabel: string;
  startDate: string | null;
  targetDate: string | null;
  lead: LinearUserRef | null;
  status: { id: string; name: string; type: string } | null;
  teams: { key: string; name: string }[];
  labels: string[];
  /**
   * The id of the project's description document content.
   * IMPORTANT: project overview comments anchor to THIS id (documentContentId),
   * not to projectId. Required for all comment create/reply operations.
   */
  documentContentId: string | null;
}

/** A single comment (thread root or reply) on a project overview. */
export interface LinearComment {
  id: string;
  /** Markdown body of the comment. */
  body: string;
  /** Figma frame screenshot URLs extracted from Linear's rich comment body. */
  figmaScreenshots: ReadonlyMap<string, string>;
  url: string;
  createdAt: string;
  /** Non-null when the thread is resolved (read-only badge). */
  resolvedAt: string | null;
  /** The anchored snippet for inline comments; null for top-level discussion. */
  quotedText: string | null;
  /** Parent comment id when this is a reply; null for thread roots. */
  parentId: string | null;
  author: LinearUserRef | null;
  /** Present when authored by a bot/integration instead of a user. */
  botActorName: string | null;
}

/** An inline thread has a non-null Linear quote on its root. */
export interface InlineCommentThread {
  kind: "inline";
  root: LinearComment & { quotedText: string };
  replies: LinearComment[];
}

/** A discussion thread has no quote on its root. */
export interface DiscussionCommentThread {
  kind: "discussion";
  root: LinearComment & { quotedText: null };
  replies: LinearComment[];
}

export type CommentThread = InlineCommentThread | DiscussionCommentThread;

export interface GroupedComments {
  inline: InlineCommentThread[];
  discussion: DiscussionCommentThread[];
}

export interface PluginSettings {
  /** Name of the secret in Obsidian SecretStorage that holds the Linear API key. */
  secretName: string;
  /** Vault-relative folder where imported specs are written. */
  specsFolder: string;
  /** Store authenticated images in the vault; false keeps them in a local OS cache. */
  storeAssetsInVault: boolean;
  /** Render images and Linear-hosted Figma screenshots inline. */
  previewImages: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  secretName: "",
  specsFolder: "Specs",
  storeAssetsInVault: false,
  previewImages: true,
};

export const LINEAR_COMMENTS_VIEW = "linear-spec-review-comments";

/** Frontmatter key that stores the Linear project id on each imported note. */
export const FM_PROJECT_ID = "linear_project_id";
export const FM_DOCUMENT_CONTENT_ID = "linear_document_content_id";
export const FM_PROJECT_URL = "linear_project_url";
