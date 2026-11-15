# blackke Crypto Spot Prices — vAPI "List your API" quest

A tiny read-only API that returns BTC/ETH/SOL spot prices in USD, protected
by an x402 paywall: **$0.001 USDC per call on Base**, paid to blackke's
wallet `0x2a0a50805cf0aA0176BB338690006eCA7095B9c1`, verified and settled
through the PayAI facilitator (`https://facilitator.payai.network`, no key).

## Endpoints

| Route | Cost | Notes |
|---|---|---|
| `GET /` | free | API info, price, payout wallet |
| `GET /health` | free | liveness check |
| `GET /openapi.json` | free | OpenAPI 3.0 document |
| `GET /.well-known/x402` | free | x402 discovery document |
| `GET /price` | $0.001 | `{BTC, ETH, SOL}` spot prices, USD |
| `GET /price?symbol=BTC` | $0.001 | one symbol (`BTC`, `ETH`, `SOL`) |

Prices come from CoinGecko's free public API (no key), cached 30 s.

## How the paywall works (x402 "exact" scheme)

1. Unpaid `GET /price` → HTTP `402` with a `PAYMENT-REQUIRED` header
   (base64 JSON). The `accepts` array offers the same $0.001 payment in
   two shapes, so both x402 client generations work:
   - v2: `network "eip155:8453"`, `amount "1000"`
   - v1: `network "base"`, `maxAmountRequired "1000"`
   (Base mainnet, chain id 8453; USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`;
   1000 atomic units = $0.001 since USDC has 6 decimals.)
2. The client signs an EIP-3009 authorization and retries with the
   `X-Payment` (or `PAYMENT-SIGNATURE`) header, base64 JSON.
3. The Worker verifies it (`POST /verify`) and settles it
   (`POST /settle`) at the PayAI facilitator, then serves the data and
   returns the settlement in the `PAYMENT-RESPONSE` header.

Both the v1 and v2 verify envelopes were probed live against
`facilitator.payai.network` on 2026-11-15 and reach full authorization
validation there (dummy authorizations are rejected for expiry, as they
should be). A real paid call has not been tested end-to-end yet — that
needs a funded buyer wallet; see "Remaining steps".

No secrets, no private keys, no signing keys anywhere in this repo. The
Worker never signs anything: the buyer signs, the facilitator settles,
USDC goes straight to the payout wallet.

## Files

- `src/worker.js` — the whole Worker (plain JS, no build step)
- `wrangler.toml` — Worker name `blackke-crypto-prices`
- `test/test.mjs` — local test harness, run with `node test/test.mjs`

## Local tests

`node test/test.mjs` — 16/16 pass (2026-11-15), including:

- free endpoints (`/`, `/health`, `/openapi.json`, `/.well-known/x402`)
- unpaid `/price` → 402 with both v1 + v2 accepts, correct payee/asset/amount
- unknown symbol → 400, malformed `X-Payment` → 400
- dummy v1 and v2 payments → 402 with the facilitator's own rejection
  reason (expired authorization), proving the Worker ↔ facilitator path
- live prices through the Worker's own fetch path
  (e.g. BTC $65,035 / ETH $1,817.45 / SOL $71.96 at test time)

## Deploy (BLOCKED — needs the user's Cloudflare account)

This environment has **no Cloudflare login**: no `wrangler` binary, no
`~/.cloudflare` / `~/.wrangler`, no `CLOUDFLARE_API_TOKEN` / `CF_*` env
vars. Nothing was deployed and no credentials were invented or asked for
in chat.

To deploy, on a machine with the user's Cloudflare account:

1. Install wrangler and log in: `npm i -g wrangler && wrangler login`
   (opens dash.cloudflare.com to authorize; or set `CLOUDFLARE_API_TOKEN`).
2. From this directory: `npx wrangler deploy`
   → public URL like `https://blackke-crypto-prices.<subdomain>.workers.dev`
3. Sanity-check it:
   - `curl https://<url>/health` → `{"status":"ok",...}`
   - `curl -i https://<url>/price` → HTTP 402 with `PAYMENT-REQUIRED`
   - `curl https://<url>/openapi.json` → the OpenAPI document
4. Optional paid end-to-end test: pay $0.001 USDC on Base with an x402
   client (e.g. the vAPI "Try it" flow) and confirm a 200 with prices
   plus a `PAYMENT-RESPONSE` header.

## List it on vAPI (after deploy — needs the blackke browser session)

1. In the user's own Chrome (where the blackke vAPI session lives), open
   the Earn quests page and the "List your API" quest.
2. Submit the deployed Worker URL as the API endpoint, with the OpenAPI
   document at `<url>/openapi.json` if asked for one.
3. Set price **$0.001 per call**, network **Base (eip155:8453)**,
   asset **USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`**, payout
   wallet **`0x2a0a50805cf0aA0176BB338690006eCA7095B9c1`**.
4. vAPI verifies the endpoint (it calls it and pays via x402). If it
   reports a problem, the 402 body/headers above are the first thing to
   compare against what it expects.
5. Quest is +500 points when vAPI confirms the listing.

## Caveats

- The original List-API guide file (`prompt-list-your-api.md`, Telegram
  post 3771702) was read in Telegram Web on 2026-11-15 but never saved
  locally, so it could not be re-read here. This build follows the
  verified facts recorded from it instead: Cloudflare Worker,
  $0.001/call on Base, PayAI facilitator (not x402.org), payout = the
  user's wallet. If the user uploads that .md, re-check this Worker
  against it before listing.
- The guide's `eip155:8453` is the CAIP-2 name of Base mainnet; x402 v1
  calls the same chain `"base"`. Both are advertised, so either client
  generation can pay.
- A real paid call (200 + on-chain settlement) has not been observed yet;
  the tests prove the 402 shape and the verify round-trip, not a live
  settlement.
