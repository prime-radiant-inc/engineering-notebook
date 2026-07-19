import typography from "@tailwindcss/typography";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // claude-session-viewer "Superpowers Suite" design tokens
      colors: {
        ink: "#1b2631",
        "ink-light": "#374a5e",
        slate: "#6b7c8f",
        teal: "#1a6b5a",
        "teal-light": "#d4ece8",
        "teal-wash": "#eaf5f2",
        surface: "#f6f8fa",
        panel: "#eef1f5",
        edge: "#e1e4e8",
        "edge-light": "#eef1f5",
        accent: "#1a6b5a",
      },
      fontFamily: {
        display: ["Fraunces", "Georgia", "serif"],
        body: ["'DM Sans'", "-apple-system", "BlinkMacSystemFont", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [typography],
};
