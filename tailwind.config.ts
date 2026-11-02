import type { Config } from "tailwindcss";

/**
 * Space + Mars palette.
 *
 * The ground is the inside of a habitat at night (near-black with a violet
 * cast); the panels are basalt warmed by the regolith; the primary accent is
 * the ember of a Mars sunset, with a gold "sun" and a cold plasma blue for
 * anything that is not a warning. Semantic names are preserved (`void`,
 * `panel`, `ink`, `signal`, …) so every console inherits the theme without
 * re-learning a second vocabulary.
 */
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
          void: "#07060c",
          panel: "#140f0d",
          edge: "#33231d",
          grid: "#1d1512",
          ink: "#f6ece1",
          muted: "#a89285",
          signal: "#ff7a45",
          solar: "#ffc978",
          alert: "#ff4b3e",
          warn: "#ffa14b",
          ok: "#5fd39b",
          info: "#8ab4ff",
          rust: "#8c3b21",
          sand: "#e8c8a4",
          nebula: "#6f5cff",
        },
      },
      fontFamily: {
        sans: [
          "Space Grotesk",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
        display: ["Space Grotesk", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      letterSpacing: {
        mission: "0.34em",
      },
      boxShadow: {
        panel:
          "inset 0 1px 0 rgba(255, 201, 120, 0.05), 0 18px 40px -24px rgba(0,0,0,0.95)",
        ember: "0 0 0 1px rgba(255,122,69,0.35), 0 12px 30px -14px rgba(255,122,69,0.45)",
        sunken: "inset 0 1px 2px rgba(0,0,0,0.6)",
      },
      backgroundImage: {
        "mars-haze":
          "radial-gradient(120% 80% at 50% 118%, rgba(255,122,69,0.28), rgba(140,59,33,0.18) 38%, transparent 72%)",
        "ember-line": "linear-gradient(90deg, transparent, rgba(255,122,69,0.65), transparent)",
      },
      keyframes: {
        pulseSoft: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
        twinkle: {
          "0%, 100%": { opacity: "0.55" },
          "50%": { opacity: "1" },
        },
        drift: {
          "0%": { transform: "translate3d(0,0,0)" },
          "100%": { transform: "translate3d(-40px, 24px, 0)" },
        },
        sweep: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
        riseIn: {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        pulseSoft: "pulseSoft 1.8s ease-in-out infinite",
        twinkle: "twinkle 6s ease-in-out infinite",
        drift: "drift 90s linear infinite",
        sweep: "sweep 5.5s linear infinite",
        riseIn: "riseIn 280ms ease-out both",
      },
    },
  },
  plugins: [],
};

export default config;
