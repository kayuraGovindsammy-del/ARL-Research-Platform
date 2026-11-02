import type { Metadata } from "next";
import "./globals.css";
import { SiteHeader } from "@/components/SiteHeader";

export const metadata: Metadata = {
  title: "ARL Control — Astro-Research Laboratory",
  description:
    "Real-time monitoring and control for the Radio Telescope Array, Mars Habitation Experiment and On-Demand Power Generation services.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="relative min-h-screen font-sans">
        {/* Ambient layers: stars, then the Mars horizon. Both are inert. */}
        <div aria-hidden className="starfield" />
        <div aria-hidden className="horizon" />

        <div className="relative z-10 flex min-h-screen flex-col">
          <SiteHeader />
          <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-5">{children}</main>
          <footer className="mx-auto w-full max-w-[1600px] px-4 pb-6 pt-2">
            <div className="hairline mb-3" />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] uppercase tracking-[0.18em] text-console-muted/70">
              <span className="text-console-signal/80">ARL mission control</span>
              <span className="text-console-edge">/</span>
              <span>Mars analogue station</span>
              <span className="text-console-edge">/</span>
              <span>SSE telemetry</span>
              <span className="text-console-edge">/</span>
              <span>MQTT ingestion</span>
              <span className="text-console-edge">/</span>
              <span>SQLite replay</span>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
