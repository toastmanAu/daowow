# Entry screen preview

Open `entry.html`, or serve locally:

```sh
python3 -m http.server 8931 --bind 127.0.0.1 --directory apps/web
```

Visit `http://127.0.0.1:8931/entry.html`. The existing protocol simulator remains
at `index.html`; the two pages link to each other.

This is a display-only interface, not a transaction builder. The 100 CKB sample
ticket principal and 1–100 quantity limit are preview values, not authenticated
round terms. Cell capacity, fees and transaction total remain unquoted. There
is no wallet provider, RPC, account collection, signing, submission, persistence,
live countdown or fake confirmation. CSP disallows network connections and
form submissions. CSS lottery balls are decorative, not results or the future
Three.js draw implementation.

Files: `entry.html` (content), `entry.css` (responsive visual system),
`entry-model.js` (exact BigInt display calculations), `entry.js` (DOM behavior).
No build step, CDN, remote fonts or added package dependencies.

## Verification — 2026-09-15

```sh
node --test apps/web/test/*.test.js
node apps/web/test/entry.test.js
```

Three entry model tests cover malformed/limit quantities, exact principal and
CKB precision; existing core/engine/security suites also pass. The browser
regression is `test/entry.browser.js`, a function expression for the Playwright
browser tool's `filename` option, with the server above running. It tests presets,
invalid input, review values, forward/reverse dialog focus, Escape/focus return,
wallet information, 320/390/768/1024/1440 widths and reduced motion.

Desktop/mobile screenshots were visually inspected; mobile artwork overlap was
corrected. Browser console has no warnings/errors, and observed requests were
only the four local page/style/script resources. Bounded code/security review
approved the changes. These checks are not a full screen-reader or WCAG audit.

Next integration work: authenticated round discovery, wallet/network handling,
full-capacity transaction quotes, signing, confirmation and reorg-aware state.
The historical simulator is not the live adapter for this screen.
