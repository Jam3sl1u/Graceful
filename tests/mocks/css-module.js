// CSS Modules (`*.module.css`) aren't parseable by Jest's transform (no CSS
// loader outside webpack/Next). Component tests import components that pull
// in a `.module.css` file (e.g. Button.tsx, invite-response.tsx) — map those
// imports to a Proxy that echoes the class name back, so `styles.button`
// resolves to a stable string instead of throwing a syntax error. Mirrors
// server-only.js's mock-via-moduleNameMapper pattern (jest.config.js).
module.exports = new Proxy(
  {},
  {
    get: (_target, prop) => prop,
  },
);
