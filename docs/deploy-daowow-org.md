# Publishing the dApp at daowow.org

The site is static files. Nothing is compiled; `tools/build-site.mjs` copies a
fixed list of files into `dist/site` and refuses to finish if any of them
names a private address. That list is the boundary between this repository
and the internet, and `apps/web/test/build-site.test.js` pins it.

## What gets published

| On the site | From the repository |
|---|---|
| `/dapp/` | `apps/web/dapp/` — the app, its stylesheet, `manifest.json` |
| `/chain/`, `/core.js` | `apps/web/chain/*.js`, `apps/web/core.js` |
| `/vendor/` | `apps/web/vendor/` without its README |
| `/_headers`, `/_redirects` | `apps/web/site/` |

`/` redirects to `/dapp/`. The old `entry.html`, `refund.html` and
`how-it-works.html` addresses redirect into the matching tab.

Not published: contracts, tools, tests, `deployments/`, and the prototype
simulator at `apps/web/index.html`.

## The node

The published `manifest.json` points at the public testnet node
`https://testnet.ckb.dev`. It is generated from the dev deployment by:

```sh
node tools/public-manifest.mjs
```

Run that again after any redeploy. A test fails if the two manifests differ in
anything but the node address, and the page's security policy only allows
connections to that one host, so changing the node means changing both
`apps/web/dapp/index.html` and `apps/web/site/_headers`.

## Publishing with wrangler

The Pages project is `daowow` (created 2026-11-10 as a direct-upload project,
production branch `main`). It is served at <https://daowow.pages.dev/>.

```sh
node --test 'apps/web/test/*.test.js'
node tools/build-site.mjs
wrangler pages deploy dist/site --project-name daowow --branch main
```

Deploying with any other `--branch` name gives a preview address instead of
replacing the live site, which is the place to try a change on a phone first.

## Pointing daowow.org at it, once

wrangler has no command for this; it is done in the dashboard.

1. Workers & Pages → `daowow` → Custom domains → Set up a custom domain →
   `daowow.org`. The domain is already on Cloudflare, so the DNS record is
   created for you.
2. SSL/TLS → Edge Certificates → turn on **Always Use HTTPS**. JoyID on a
   phone will not work without HTTPS.

## Checking a build before it goes out

```sh
node --test 'apps/web/test/*.test.js'
node tools/build-site.mjs
grep -r "192.168" dist/site        # must print nothing
python3 -m http.server 8933 --bind 127.0.0.1 --directory dist/site
```

Then open `http://127.0.0.1:8933/` and check that it lands on the app, that
all four tabs work, and that the browser console shows no blocked requests.

## After it is live

- `curl -sI https://daowow.org/dapp/ | grep -i content-security-policy` should
  show the policy from `_headers`, including `frame-ancestors 'none'`.
- Connect a JoyID wallet on a phone and open My tickets.
- The 3D draw library (about 690 KB) is only downloaded when someone opens a
  draw, so the first paint of the app does not wait for it.
