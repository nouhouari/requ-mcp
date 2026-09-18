// Configures mermaid (the IIFE build exposes window.mermaid itself). Kept as an
// external file rather than an inline <script> so the dashboard runs under a
// Content-Security-Policy without 'unsafe-inline' for scripts. Loaded deferred
// right after mermaid.min.js, so it runs before the window 'load' event and
// mermaid's own startOnLoad hook never fires; renders go through runMermaid().
(function () {
  if (!window.mermaid || typeof window.mermaid.initialize !== 'function') return;
  window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
})();
