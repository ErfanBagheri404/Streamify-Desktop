"use client";

import { usePathname } from "next/navigation";
import AppBootstrap from "./AppBootstrap";
import CloudLibraryBridge from "./CloudLibraryBridge";
import CommunityBanner from "./CommunityBanner";
import LeftPanel from "./LeftPanel";
import MobileAppGate from "./MobileAppGate";
import OverlayTitleBar from "./OverlayTitleBar";
import PageTitle from "./PageTitle";
import ShellLayout from "./ShellLayout";
import UpdateModal from "./UpdateModal";
import { isStandaloneAuthPath } from "../lib/auth-routes";
import { AudioProvider } from "../contexts/AudioContext";
import { SettingsProvider } from "../contexts/SettingsContext";
import { SidePanelProvider } from "../contexts/SidePanelContext";
import { ToastProvider } from "../contexts/ToastContext";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isAuthPage = isStandaloneAuthPath(pathname);

  if (isAuthPage) {
    return (
      <SettingsProvider>
        <ToastProvider>
          <AppBootstrap />
          <OverlayTitleBar />
          {children}
        </ToastProvider>
      </SettingsProvider>
    );
  }

  return (
    <SettingsProvider>
      <ToastProvider>
        <AppBootstrap />
        <OverlayTitleBar />
        <AudioProvider>
          <PageTitle />
          <SidePanelProvider>
            <CloudLibraryBridge />
            <MobileAppGate />
            <CommunityBanner />
            <LeftPanel />
            <ShellLayout>{children}</ShellLayout>
            <UpdateModal />
          </SidePanelProvider>
        </AudioProvider>
      </ToastProvider>
    </SettingsProvider>
  );
}
