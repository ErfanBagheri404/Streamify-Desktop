/**
 * The Electron preload script exposes this bridge on `window`. It only exists
 * in the desktop build, so every consumer must feature-detect it.
 */
export type DesktopCommand = "play-pause" | "play" | "pause" | "next" | "previous" | "seek";

/** One OS command from the main process (tray, menu, media keys, MPRIS). */
export interface DesktopCommandPayload {
  command: DesktopCommand;
  /** Seconds for `seek`; undefined for the rest. */
  payload?: number;
}

/** Current song as the OS sees it (what the Now Playing surface shows). */
export interface NowPlayingSong {
  id: string;
  title: string;
  artist: string;
  duration?: number;
  coverUrl?: string;
}

/** Track + playback state pushed to the main process for Now Playing + MPRIS. */
export interface NowPlayingReport {
  song: NowPlayingSong | null;
  isPlaying: boolean;
  hasNext: boolean;
  hasPrevious: boolean;
  position: number;
  /** False suppresses the OS notification; MPRIS metadata still updates. */
  notify: boolean;
}

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
  /** Subscribe to main-process menu / tray / media-key / MPRIS commands.
   *  Each command is `{ command, payload }`; payload carries the seek position
   *  (seconds) for `seek`. Returns an unsubscribe. */
  onCommand: (callback: (command: DesktopCommandPayload) => void) => () => void;
  /** Push current track + playback state to the OS (Now Playing + MPRIS). */
  reportNowPlaying: (payload: NowPlayingReport) => void;
  /** Push the current playback position (seconds), fire-and-forget. */
  reportPosition: (seconds: number) => void;
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
