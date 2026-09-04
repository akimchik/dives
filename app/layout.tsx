import type { Metadata } from "next";

import { CausticOverlay } from "@/components/CausticOverlay";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

import "./globals.css";
import "leaflet/dist/leaflet.css";

export const metadata: Metadata = {
  title: "Dives",
  description: "Your personal scuba dive logbook.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <TooltipProvider>
            {/* Mounted once, app-wide: the only underwater motif in the UI (plan Step 6). It is
                pointer-events-none and fixed at z-25, rendering above page content (edit boxes,
                buttons, etc.) so it tints every screen without intercepting a single click. */}
            <CausticOverlay />
            {children}
            <Toaster richColors />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
