/** @type {import('tailwindcss').Config} */
// Build-time Tailwind (v3) for the dashboard, replacing the cdn.tailwindcss.com
// runtime JIT. `npm run build:css` writes src/public/tailwind.css, which is
// committed so `npm start` (tsx, no build step) can serve it straight from src.
module.exports = {
  content: ["./src/public/index.html", "./src/public/app.js"],
  theme: {
    extend: {
      fontFamily: { sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"] },
    },
  },
  // app.js only ever returns complete class names (badge-*/chip-*, defined in
  // style.css, not Tailwind utilities), so nothing needs safelisting today.
  safelist: [],
  plugins: [],
};
