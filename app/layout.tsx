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
      <body className="min-h-screen font-sans">
        <SiteHeader />
        <main className="mx-auto w-full max-w-[1600px] px-4 py-4">{children}</main>
        <footer className="mx-auto w-full max-w-[1600px] px-4 pb-6 pt-2 text-[10px] uppercase tracking-[0.16em] text-console-muted/70">
          ARL platform · Next.js single-process server · SSE telemetry · MQTT ingestion · SQLite replay
        </footer>
      </body>
    </html>
  );
}
