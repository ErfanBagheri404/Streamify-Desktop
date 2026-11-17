/**
 * The Electron preload script exposes this bridge on `window`. It only exists
 * in the desktop build, so every consumer must feature-detect it.
 */
export type DesktopCommand =
  | "play-pause"
  | "play"
  | "pause"
  | "next"
  | "previous"
  | "seek"
  | "like";

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
  /** Track's own page on its service — Rich Presence button 2 when http(s). */
  url?: string;
}

/** Track + playback state pushed to the main process for Now Playing + MPRIS. */
export interface NowPlayingReport {
  song: NowPlayingSong | null;
  isPlaying: boolean;
  /** True while the stream is buffering — freezes the Discord progress bar. */
  isLoading: boolean;
  hasNext: boolean;
  hasPrevious: boolean;
  position: number;
  /** True when the current track is in liked songs (taskbar like button). */
  liked?: boolean;
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

/** Result of picking an M3U file in the native open dialog. */
export type M3uImportResult =
  | {
      ok: true;
      path: string;
      entries: {
        path?: string;
        artist?: string;
        title?: string;
        duration?: number;
      }[];
      warnings: string[];
    }
  | { ok: false; canceled?: true; error?: string };

/** Last.fm connection state (never contains the secret or session key). */
export type LastFmStatus = {
  connected: boolean;
  username: string | null;
  hasCredentials: boolean;
  pendingAuth: boolean;
};

/** Result of saving a playlist as M3U via the native save dialog. */
export type M3uExportResult =
  | { ok: true; path: string; count: number }
  | { ok: false; canceled?: true; error?: string };

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
   * Last.fm scrobbling: main owns the credentials (apiSecret/sessionKey never
   * cross this bridge) and the now-playing/scrobble pipeline.
   */
  lastfm?: {
    /** { connected, username, hasCredentials, pendingAuth } — no secrets. */
    status: () => Promise<LastFmStatus>;
    /** Store an API key/secret pair (clears any existing session). */
    setCredentials: (credentials: {
      apiKey: string;
      apiSecret: string;
    }) => Promise<LastFmStatus>;
    /** Request a token and open the Last.fm auth page in the browser. */
    startAuth: () => Promise<{ ok: boolean; token?: string; error?: string }>;
    /** Exchange the pending token for a session key. */
    finishAuth: () => Promise<{
      ok: boolean;
      username?: string;
      error?: string;
    }>;
    /** Drop the session (keeps the key pair). */
    disconnect: () => Promise<LastFmStatus>;
    /** Sanity call (user.getInfo) — resolves { ok, username | error }. */
    test: () => Promise<{ ok: boolean; username?: string | null; error?: string }>;
    /** Turn scrobbling on/off (mirrors the settings toggle). */
    setEnabled: (enabled: boolean) => Promise<boolean>;
  };
  /** M3U playlist import/export (native file dialogs owned by main). */
  playlists?: {
    /** Open the M3U picker; resolves parsed entries plus parse warnings. */
    importM3u: () => Promise<M3uImportResult>;
    /** Save a playlist as M3U via the save dialog. */
    exportM3u: (payload: {
      name: string;
      tracks: {
        artist?: string;
        title: string;
        duration?: number;
        url?: string;
      }[];
    }) => Promise<M3uExportResult>;
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
