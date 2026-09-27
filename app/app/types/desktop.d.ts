/**
 * The Electron preload script exposes this bridge on `window`. It only exists
 * in the desktop build, so every consumer must feature-detect it.
 */
export type DesktopCommand = "play-pause" | "next" | "previous";

export type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "not-available"
  | "error";

export interface UpdateAvailableInfo {
  version: string;
  releaseDate?: string | null;
  releaseNotes?: string | null;
}

export interface UpdateProgressInfo {
  percent: number;
  transferred: number;
  total: number;
}

export interface StreamifyDesktopBridge {
  platform: string;
  isDesktop: true;
  /** Packaged app version, e.g. "0.1.0". */
  version: string;
  setTheme?: (theme: "light" | "dark") => void;
  /** Subscribe to main-process menu / media-key commands. Returns an unsubscribe. */
  onCommand: (callback: (command: DesktopCommand) => void) => () => void;
  /** Self-update bridge. Present only in the packaged desktop app. */
  update?: {
    check: () => void;
    download: () => void;
    install: () => void;
    onAvailable: (callback: (info: UpdateAvailableInfo) => void) => void;
    onProgress: (callback: (info: UpdateProgressInfo) => void) => void;
    onDownloaded: (callback: (info: { version: string }) => void) => void;
    onNotAvailable: (callback: () => void) => void;
    onError: (callback: (info: { message: string }) => void) => void;
  };
}

declare global {
  interface Window {
    streamifyDesktop?: StreamifyDesktopBridge;
  }
}
