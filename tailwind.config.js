/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "SF Pro Text",
          "Segoe UI",
          "sans-serif",
        ],
      },
      colors: {
        surface: {
          DEFAULT: "#181410",
          raised: "#211c17",
          card: "#2a231c",
          inset: "#14110e",
          glow: "#322820",
        },
        cream: {
          DEFAULT: "#faf3e8",
          muted: "#dcc9b0",
          dim: "#b8a48c",
        },
        accent: {
          DEFAULT: "#f2b56d",
          muted: "#e09a42",
          soft: "rgba(242, 181, 109, 0.18)",
          glow: "rgba(255, 210, 150, 0.12)",
        },
      },
      boxShadow: {
        panel:
          "0 24px 48px rgba(0, 0, 0, 0.42), 0 0 0 1px rgba(255, 214, 160, 0.08), inset 0 1px 0 rgba(255, 230, 200, 0.1)",
        card: "inset 0 1px 0 rgba(255, 220, 180, 0.07)",
        tab: "inset 0 1px 0 rgba(255, 230, 200, 0.12), 0 4px 16px rgba(224, 154, 66, 0.12)",
        glow: "0 0 40px rgba(242, 181, 109, 0.15)",
      },
      backgroundImage: {
        "panel-warm": "linear-gradient(165deg, #2e261e 0%, #211c17 42%, #181410 100%)",
        "card-warm": "linear-gradient(145deg, rgba(255,220,180,0.06) 0%, rgba(42,35,28,0.9) 55%, rgba(30,26,20,0.95) 100%)",
        "accent-bar": "linear-gradient(90deg, #fcd9a0 0%, #f2b56d 45%, #e89540 100%)",
      },
    },
  },
  plugins: [],
};
