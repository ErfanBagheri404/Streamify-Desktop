/**
 * The Electron preload script exposes this bridge on `window`. It only exists
 * in the desktop build, so every consumer must feature-detect it.
 */
export type DesktopCommand = "play-pause" | "next" | "previous";

export interface StreamifyDesktopBridge {
  platform: string;
  isDesktop: true;
  setTheme?: (theme: "light" | "dark") => void;
  /** Subscribe to main-process menu / media-key commands. Returns an unsubscribe. */
  onCommand: (callback: (command: DesktopCommand) => void) => () => void;
}

declare global {
  interface Window {
    streamifyDesktop?: StreamifyDesktopBridge;
  }
}
