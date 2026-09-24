import {
  Plugin,
  WorkspaceLeaf,
  TFile,
  Notice,
  MarkdownRenderChild,
  MarkdownView,
} from "obsidian";
import {
  PluginSettings,
  DEFAULT_SETTINGS,
  LINEAR_COMMENTS_VIEW,
  FM_PROJECT_ID,
  FM_DOCUMENT_CONTENT_ID,
  LinearSpecContext,
} from "./types";
import { assertSecretStorage } from "./linear/gql";
import { AssetStore } from "./linear/assets";
import { AssetPreview } from "./render/assetPreview";
import { FigmaPreview } from "./render/figmaPreview";
import { ImageDownloads } from "./render/imageDownloads";
import { getProjectFigmaScreenshots } from "./linear/queries";
import { StoredImage } from "./linear/assets";
import { CommentsView, CommentsHost } from "./view/CommentsView";
import { LinearSettingTab, SettingsHost } from "./settings";
import {
  CommandHost,
  ImportUrlModal,
  importByUrl,
  openBrowseModal,
} from "./commands";

export default class LinearSpecReviewPlugin
  extends Plugin
  implements CommentsHost, SettingsHost, CommandHost
{
  settings: PluginSettings = DEFAULT_SETTINGS;

  /**
   * Project id the comments panel last loaded for. Used to avoid re-fetching
   * comments on every `active-leaf-change` (e.g. focusing out and clicking back
   * into the panel). We only reload when the active note's project actually
   * changes; manual Refresh remains the explicit way to re-fetch the same note.
   */
  private lastLoadedProjectId: string | null = null;
  private assetPreview: AssetPreview | null = null;
  private figmaPreview: FigmaPreview | null = null;
  private assetStore: AssetStore | null = null;
  private readonly imageDownloads = new ImageDownloads(4);

  async onload(): Promise<void> {
    await this.loadSettings();

    // Hard requirement: Secret Storage must be available. No plaintext fallback.
    // We warn (not crash) so the user can still open settings to read guidance,
    // but every API action will surface the same error via the gql layer.
    try {
      assertSecretStorage(this.app);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`Linear Spec Review: ${msg}`);
      console.error("[linear-spec-review]", msg);
    }

    this.registerView(
      LINEAR_COMMENTS_VIEW,
      (leaf: WorkspaceLeaf) => new CommentsView(leaf, this)
    );

    this.addSettingTab(new LinearSettingTab(this.app, this));
    this.assetStore = new AssetStore(this.app, () => this.getSecretName(), () => this.getSpecsFolder());
    this.registerMarkdownPostProcessor((el, ctx) => {
      const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (!(file instanceof TFile)) return;
      const projectId = this.app.metadataCache.getFileCache(file)?.frontmatter?.[FM_PROJECT_ID];
      if (typeof projectId !== "string") return;
      if (!el.querySelector('img, a[href*="figma.com"]')) return;
      const disposeImages = this.assetPreview?.render(el);
      const disposeFigma = el.querySelector('a[href*="figma.com"]') && this.figmaPreview
        ? this.figmaPreview.render(el, this.figmaPreview.projectScreenshots(projectId))
        : undefined;
      const child = new MarkdownRenderChild(el);
      if (disposeImages) child.register(disposeImages);
      if (disposeFigma) child.register(disposeFigma);
      ctx.addChild(child);
    });
    this.updatePreviews();

    this.addCommand({
      id: "import-project-url",
      name: "Import project overview (URL)",
      callback: () => {
        new ImportUrlModal(this.app, (url: string) => {
          void importByUrl(this, url);
        }).open();
      },
    });

    this.addCommand({
      id: "browse-import-project",
      name: "Browse & import project",
      callback: () => {
        openBrowseModal(this);
      },
    });

    this.addCommand({
      id: "open-comments-panel",
      name: "Open comments panel",
      callback: () => {
        void this.activateCommentsView();
      },
    });

    // Reload the panel only when the active note's Linear project changes.
    // Switching focus within the same note (or clicking inside the panel) must
    // not trigger a live re-fetch; use manual Refresh for that.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        void this.syncCommentsViewOnLeafChange();
      })
    );
  }

  onunload(): void {
    this.assetPreview?.stop();
    this.assetPreview = null;
    this.figmaPreview?.stop();
    this.figmaPreview = null;
  }

  updatePreviews(): void {
    this.figmaPreview?.stop();
    this.figmaPreview = this.settings.previewImages ? new FigmaPreview(this, this.imageDownloads) : null;
    this.assetPreview?.stop();
    this.assetPreview = this.assetStore
      ? new AssetPreview(this.assetStore, this.settings.storeAssetsInVault, this.settings.previewImages, this.imageDownloads)
      : null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView && leaf.view.file) {
        const projectId = this.app.metadataCache.getFileCache(leaf.view.file)?.frontmatter?.[FM_PROJECT_ID];
        if (typeof projectId === "string") leaf.view.previewMode.rerender();
      }
      if (leaf.view instanceof CommentsView) leaf.view.rerenderPreviews();
    });
  }

  storeAssetsInVault(): boolean {
    return this.settings.storeAssetsInVault;
  }

  async saveEmbeddedImage(url: string): Promise<string> {
    if (!this.assetStore) throw new Error("Linear image store is unavailable.");
    const image = await this.assetStore.load(url, true);
    if (!image.vaultPath) throw new Error("Linear image was not saved in the vault.");
    return image.vaultPath;
  }

  getFigmaScreenshots(projectId: string): Promise<Map<string, string>> {
    return getProjectFigmaScreenshots(this.app, this.getSecretName(), projectId);
  }

  async loadFigmaScreenshot(url: string): Promise<StoredImage> {
    if (!this.assetStore) throw new Error("Linear image store is unavailable.");
    return this.assetStore.load(url, this.settings.storeAssetsInVault);
  }

  renderCommentImages(el: HTMLElement, screenshots: ReadonlyMap<string, string>): () => void {
    const disposeImages = this.assetPreview?.render(el);
    const disposeFigma = screenshots.size > 0 ? this.figmaPreview?.render(el, screenshots) : undefined;
    return () => {
      disposeFigma?.();
      disposeImages?.();
    };
  }

  // --- Settings persistence -------------------------------------------------

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<PluginSettings> | null;
    this.settings = {
      secretName:
        typeof data?.secretName === "string"
          ? data.secretName
          : DEFAULT_SETTINGS.secretName,
      specsFolder:
        typeof data?.specsFolder === "string"
          ? data.specsFolder
          : DEFAULT_SETTINGS.specsFolder,
      storeAssetsInVault: data?.storeAssetsInVault === true,
      previewImages: data?.previewImages !== false,
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // --- CommentsHost / CommandHost ------------------------------------------

  getSecretName(): string {
    return this.settings.secretName;
  }

  getSpecsFolder(): string {
    return this.settings.specsFolder;
  }

  /** Reads the active markdown note's Linear context from its frontmatter. */
  getActiveContext(): LinearSpecContext | null {
    const file = this.app.workspace.getActiveFile();
    if (file === null || file.extension !== "md") {
      return null;
    }
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    if (fm === undefined) {
      return null;
    }
    const projectId = fm[FM_PROJECT_ID];
    if (typeof projectId !== "string" || projectId.length === 0) {
      return null;
    }
    const documentContentId =
      typeof fm[FM_DOCUMENT_CONTENT_ID] === "string"
        ? (fm[FM_DOCUMENT_CONTENT_ID] as string)
        : "";
    const projectName =
      typeof fm["name"] === "string" ? (fm["name"] as string) : file.basename;
    return { projectId, documentContentId, projectName };
  }

  /** The active markdown note file, or null when no markdown file is active. */
  getActiveFile(): TFile | null {
    const file = this.app.workspace.getActiveFile();
    if (file === null || file.extension !== "md") {
      return null;
    }
    return file;
  }

  async onImported(file: TFile, projectId: string): Promise<void> {
    this.figmaPreview?.invalidateProject(projectId);
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) {
        leaf.view.previewMode.rerender();
      }
    });
    await this.activateCommentsView();
    await this.refreshCommentsView();
  }

  // --- View management ------------------------------------------------------

  private async activateCommentsView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(LINEAR_COMMENTS_VIEW);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf === null) {
      new Notice("Could not open the comments panel (no right sidebar).");
      return;
    }
    await leaf.setViewState({ type: LINEAR_COMMENTS_VIEW, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  /**
   * Reload the panel on `active-leaf-change`, but only when the active note's
   * Linear project differs from what the panel last loaded. This prevents a
   * live re-fetch every time focus moves (e.g. clicking back into the panel).
   *
   * The active-leaf context is only considered when the active leaf is an
   * actual note, so focusing the panel itself (which reports no active file)
   * never clears or reloads the currently displayed comments.
   */
  private async syncCommentsViewOnLeafChange(): Promise<void> {
    if (this.app.workspace.getLeavesOfType(LINEAR_COMMENTS_VIEW).length === 0) {
      return;
    }

    const ctx = this.getActiveContext();
    // Ignore leaf changes that don't correspond to a note (e.g. focusing the
    // panel or a non-markdown view). Keep showing whatever is loaded.
    if (ctx === null) {
      return;
    }

    if (ctx.projectId === this.lastLoadedProjectId) {
      return;
    }
    await this.refreshCommentsView();
  }

  private async refreshCommentsView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(LINEAR_COMMENTS_VIEW);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof CommentsView) {
        await view.reload();
      }
    }
  }

  /**
   * Called by the comments view whenever it finishes (re)loading, reporting the
   * project id it now reflects. Recorded so leaf-change syncs can skip reloads
   * when the active note's project is already displayed.
   */
  notifyCommentsLoaded(projectId: string | null): void {
    this.lastLoadedProjectId = projectId;
  }
}
