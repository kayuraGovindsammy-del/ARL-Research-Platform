import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        console: {
          void: "#05070d",
          panel: "#0b1018",
          edge: "#1c2533",
          grid: "#101823",
          ink: "#e6edf7",
          muted: "#7d8ca3",
          signal: "#38f2c3",
          solar: "#ffd166",
          alert: "#ff5d5d",
          warn: "#ffab4a",
          ok: "#4ade80",
          info: "#67b6ff",
        },
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      boxShadow: {
        panel: "inset 0 1px 0 rgba(255,255,255,0.03), 0 12px 30px -18px rgba(0,0,0,0.9)",
      },
      keyframes: {
        pulseSoft: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
      },
      animation: {
        pulseSoft: "pulseSoft 1.8s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
