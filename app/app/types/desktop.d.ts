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

export interface AuthStartResult {
  ok: boolean;
  /** Opaque per-attempt id, echoes back if the flow completes. */
  state?: string;
  message?: string;
}

export interface AuthResult {
  /** Supabase token_hash; exchanged for a session with verifyOtp. */
  token_hash: string;
  type: "magiclink" | "email" | string;
  email?: string;
}

export interface AuthError {
  message: string;
}

export interface StreamifyDesktopBridge {
  platform: string;
  isDesktop: true;
  /** Packaged app version, e.g. "0.1.0". */
  version: string;
  setTheme?: (
    theme: "light" | "dark",
    colors?: { background: string; foreground: string }
  ) => void;
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
  /**
   * In-window overlay row (the strip drawn on top of the app content): dots
   * menu, back/forward chevrons. Present only in the desktop build.
   */
  titleBar?: {
    /** Pop the application menu (File, Edit, View, Playback, Help). */
    openMenu: () => void;
    // Back/forward are driven by the renderer's own Navigation API, so there is
    // no bridge surface for them — see OverlayTitleBar.
  };
  /**
   * Proxy: main owns the setting (it decides how the Next child reaches the
   * network); the renderer just mirrors it for the UI.
   */
  proxy?: {
    /** Current proxy config: "system" | "manual" | "off" plus the manual URL. */
    get: () => Promise<{ mode: string; url: string }>;
    /** Save a proxy config. Returns it plus restartRequired. */
    set: (config: {
      mode: "system" | "manual" | "off";
      url: string;
    }) => Promise<{ mode: string; url: string; restartRequired: boolean }>;
  };
  /**
   * Browser-mediated sign-in. The desktop never takes a password: main opens
   * the webplayer, the user authorizes there, and main redeems a PKCE-bound
   * grant before handing the renderer a token hash.
   */
  auth?: {
    /** Open the webplayer confirm page in the OS browser. */
    start: () => AuthStartResult;
    /** Claim a redeem result the push missed (delivered at most once). */
    take: () => AuthResult | null;
    /** Fires once when the deep link round-trip succeeded. */
    onResult: (callback: (result: AuthResult) => void) => () => void;
    /** Fires when the attempt failed, expired, or was rejected. */
    onError: (callback: (error: AuthError) => void) => () => void;
  };
}

declare global {
  interface Window {
    streamifyDesktop?: StreamifyDesktopBridge;
  }
}
