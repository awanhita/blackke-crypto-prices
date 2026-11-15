/**
 * blackke-crypto-prices — a tiny read-only crypto spot-price API with an
 * x402 paywall, built for the vAPI Network Earn "List your API" quest.
 *
 * Owner: blackke — payout wallet 0x2a0a50805cf0aA0176BB338690006eCA7095B9c1
 * Price: $0.001 USDC per call, on Base (eip155:8453), via the PayAI
 * facilitator at https://facilitator.payai.network (no API key needed).
 *
 * Endpoints (all GET):
 *   /                  - free info about this API
 *   /health            - free liveness check
 *   /openapi.json      - free OpenAPI 3.0 document
 *   /.well-known/x402  - free x402 discovery document
 *   /price             - PAID: {BTC, ETH, SOL} spot prices in USD
 *   /price?symbol=BTC - PAID: one symbol's spot price in USD
 *
 * Payment (x402, scheme "exact", USDC on Base):
 *   - Unpaid request -> HTTP 402 with a Payment-Required body. The
 *     `accepts` array carries TWO options for the same $0.001 payment:
 *       v2: network "eip155:8453", amount "1000" (x402 v2 format)
 *       v1: network "base", maxAmountRequired "1000" (x402 v1 format)
 *     Both describe the same chain (Base mainnet, chain id 8453) and the
 *     same asset (USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
 *     the client picks the entry its x402 library understands.
 *   - Paid request -> client sends the signed EIP-3009 authorization in
 *     the `X-Payment` (or `PAYMENT-SIGNATURE`) header, base64 JSON.
 *     This worker verifies it with POST {facilitator}/verify and settles
 *     it with POST {facilitator}/settle, then serves the data and returns
 *     the settlement in the `PAYMENT-RESPONSE` header.
 *
 * No secrets, no private keys, no signing keys anywhere in this file.
 * The worker never signs anything: the buyer signs, the facilitator
 * settles, the USDC goes straight to the payout wallet above.
 */

const PAY_TO = "0x2a0a50805cf0aA0176BB338690006eCA7095B9c1";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FACILITATOR = "https://facilitator.payai.network";
const PRICE_ATOMIC = "1000"; // 1000 micro-USDC = $0.001 (USDC has 6 decimals)
const PRICE_DISPLAY = "$0.001 USDC";
const MAX_TIMEOUT_SECONDS = 300;
const ASSET_EXTRA = { name: "USDC", version: "2" };

const SYMBOLS = { BTC: "bitcoin", ETH: "ethereum", SOL: "solana" };
const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd";

// Short-lived in-memory price cache (30 s) so a burst of paid calls does
// not hammer the free upstream on every request.
let priceCache = { at: 0, data: null };
const CACHE_TTL_MS = 30_000;

/** Fetch live BTC/ETH/SOL spot prices in USD from CoinGecko (free, no key). */
export async function fetchPrices() {
  const now = Date.now();
  if (priceCache.data && now - priceCache.at < CACHE_TTL_MS) return priceCache.data;
  const res = await fetch(COINGECKO_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`upstream price source returned HTTP ${res.status}`);
  const raw = await res.json();
  const out = {};
  for (const [symbol, id] of Object.entries(SYMBOLS)) {
    const price = raw?.[id]?.usd;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      throw new Error(`upstream price source returned no usable price for ${symbol}`);
    }
    out[symbol] = price;
  }
  priceCache = { at: now, data: out };
  return out;
}

function v1Requirements(resourceUrl, description) {
  return {
    scheme: "exact",
    network: "base",
    maxAmountRequired: PRICE_ATOMIC,
    resource: resourceUrl,
    description,
    mimeType: "application/json",
    payTo: PAY_TO,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    asset: USDC_BASE,
    extra: ASSET_EXTRA,
  };
}

function v2Requirements() {
  return {
    scheme: "exact",
    network: "eip155:8453",
    amount: PRICE_ATOMIC,
    asset: USDC_BASE,
    payTo: PAY_TO,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: ASSET_EXTRA,
  };
}

/** The 402 challenge body (x402 v2 envelope) advertising both options. */
function paymentRequiredBody(resourceUrl, description) {
  return {
    x402Version: 2,
    error: "Payment Required",
    resource: { url: resourceUrl, description, mimeType: "application/json" },
    accepts: [v2Requirements(), v1Requirements(resourceUrl, description)],
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      ...extraHeaders,
    },
  });
}

function paymentRequiredResponse(request, description) {
  const body = paymentRequiredBody(request.url, description);
  const encoded = b64encode(JSON.stringify(body));
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      // x402 v2 header name; the X- variant is what v1 clients read.
      "PAYMENT-REQUIRED": encoded,
      "X-Payment-Required": encoded,
    },
  });
}

function b64encode(str) {
  // Workers (and Node 16+) both provide btoa for ASCII/UTF-8-safe JSON.
  // Our JSON is ASCII-only, so btoa is safe here.
  return btoa(str);
}

function b64decode(str) {
  return atob(str.replace(/-/g, "+").replace(/_/g, "/"));
}

function readPaymentHeader(request) {
  const raw =
    request.headers.get("X-Payment") || request.headers.get("PAYMENT-SIGNATURE");
  if (!raw) return null;
  try {
    return JSON.parse(b64decode(raw.trim()));
  } catch {
    return { __malformed: true };
  }
}

/**
 * Verify + settle a payment payload with the PayAI facilitator.
 * Supports both x402 versions, dispatched on the payload's x402Version:
 *   v1: {x402Version:1, paymentPayload, paymentRequirements}
 *   v2: {x402Version:2, paymentPayload, paymentRequirements}
 * (v2's paymentPayload itself carries `accepted`; the facilitator also
 * wants the matching requirements at the top level. Both shapes were
 * probed live against facilitator.payai.network on 2026-11-15 and reach
 * full authorization validation there.)
 * Returns {ok:true, settle} on success, {ok:false, reason, detail} otherwise.
 */
async function verifyAndSettle(payment, resourceUrl, description) {
  const version = payment?.x402Version === 2 ? 2 : 1;
  let requirements;
  let payloadForFacilitator = payment;
  if (version === 2) {
    requirements = v2Requirements();
    // v2 payloads carry `accepted`; make sure it is present and matches
    // what we advertised, so the facilitator validates against our terms.
    if (!payment.accepted) {
      payloadForFacilitator = { ...payment, accepted: requirements };
    }
  } else {
    requirements = v1Requirements(resourceUrl, description);
  }

  const body = JSON.stringify({
    x402Version: version,
    paymentPayload: payloadForFacilitator,
    paymentRequirements: requirements,
  });

  let verify;
  try {
    const res = await fetch(`${FACILITATOR}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    verify = await res.json();
  } catch (e) {
    return { ok: false, reason: "facilitator_unreachable", detail: String(e) };
  }
  if (!verify?.isValid) {
    return {
      ok: false,
      reason: verify?.invalidReason || "invalid_payment",
      detail: verify?.invalidMessage || "facilitator rejected the payment",
    };
  }

  let settle;
  try {
    const res = await fetch(`${FACILITATOR}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    settle = await res.json();
  } catch (e) {
    return { ok: false, reason: "facilitator_unreachable", detail: String(e) };
  }
  if (!settle?.success) {
    return {
      ok: false,
      reason: settle?.errorReason || "settle_failed",
      detail: settle?.errorMessage || "facilitator could not settle the payment",
    };
  }
  return { ok: true, settle };
}

function openApiDoc(baseUrl) {
  return {
    openapi: "3.0.0",
    info: {
      title: "blackke Crypto Spot Prices",
      version: "1.0.0",
      description:
        "Read-only crypto spot prices (BTC, ETH, SOL in USD). Each /price call costs $0.001 USDC on Base (eip155:8453), paid via x402 through the PayAI facilitator to 0x2a0a50805cf0aA0176BB338690006eCA7095B9c1.",
    },
    servers: [{ url: baseUrl }],
    paths: {
      "/price": {
        get: {
          summary: "Spot prices in USD",
          parameters: [
            {
              name: "symbol",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["BTC", "ETH", "SOL"] },
              description: "One symbol. Omit for all three.",
            },
          ],
          responses: {
            200: {
              description: "Prices in USD",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      prices: {
                        type: "object",
                        additionalProperties: { type: "number" },
                      },
                      currency: { type: "string", example: "USD" },
                      source: { type: "string", example: "coingecko" },
                      asOf: { type: "string", format: "date-time" },
                    },
                  },
                },
              },
            },
            402: { description: "Payment Required — $0.001 USDC on Base via x402" },
          },
        },
      },
      "/health": {
        get: {
          summary: "Liveness check (free)",
          responses: { 200: { description: "Service is up" } },
        },
      },
    },
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers": "X-Payment, PAYMENT-SIGNATURE, Content-Type",
        },
      });
    }
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed", allowed: ["GET"] }, 405);
    }

    const baseUrl = `${url.protocol}//${url.host}`;

    if (path === "/") {
      return json({
        name: "blackke Crypto Spot Prices",
        description:
          "Read-only BTC/ETH/SOL spot prices in USD. Paid per call via x402.",
        owner: "blackke",
        price: PRICE_DISPLAY,
        priceAtomic: PRICE_ATOMIC,
        asset: `USDC on Base (${USDC_BASE})`,
        network: "eip155:8453 (Base mainnet)",
        payTo: PAY_TO,
        facilitator: FACILITATOR,
        endpoints: {
          price: `${baseUrl}/price`,
          priceOne: `${baseUrl}/price?symbol=BTC`,
          health: `${baseUrl}/health`,
          openapi: `${baseUrl}/openapi.json`,
          discovery: `${baseUrl}/.well-known/x402`,
        },
      });
    }

    if (path === "/health") {
      return json({ status: "ok", service: "blackke-crypto-prices", time: new Date().toISOString() });
    }

    if (path === "/openapi.json") {
      return json(openApiDoc(baseUrl));
    }

    if (path === "/.well-known/x402") {
      return json({
        x402Version: 2,
        resource: {
          url: `${baseUrl}/price`,
          description: "BTC/ETH/SOL spot prices in USD",
          mimeType: "application/json",
        },
        accepts: [v2Requirements(), v1Requirements(`${baseUrl}/price`, "Crypto spot prices")],
      });
    }

    if (path === "/price") {
      const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
      if (symbol && !SYMBOLS[symbol]) {
        return json(
          { error: "unknown_symbol", supported: Object.keys(SYMBOLS) },
          400,
        );
      }
      const description = symbol
        ? `Spot price of ${symbol} in USD`
        : "Spot prices of BTC, ETH and SOL in USD";

      // --- x402 paywall ---
      const payment = readPaymentHeader(request);
      if (!payment) {
        return paymentRequiredResponse(request, description);
      }
      if (payment.__malformed) {
        return json({ error: "invalid_payment_header", detail: "X-Payment is not valid base64 JSON" }, 400);
      }
      const result = await verifyAndSettle(payment, request.url, description);
      if (!result.ok) {
        // Payment was attached but did not verify/settle: tell the client
        // why, with a fresh 402 so it can pay again correctly.
        const res = paymentRequiredResponse(request, description);
        const body = JSON.parse(await res.text());
        body.error = `Payment not accepted: ${result.reason}`;
        body.detail = result.detail;
        return new Response(JSON.stringify(body), {
          status: 402,
          headers: res.headers,
        });
      }

      // --- paid: serve the data ---
      let prices;
      try {
        prices = await fetchPrices();
      } catch (e) {
        return json({ error: "upstream_unavailable", detail: String(e) }, 502);
      }
      const selected = symbol ? { [symbol]: prices[symbol] } : prices;
      const settlement = {
        success: result.settle.success,
        transaction: result.settle.transaction,
        network: result.settle.network,
        payer: result.settle.payer,
      };
      return json(
        {
          prices: selected,
          currency: "USD",
          source: "coingecko",
          asOf: new Date().toISOString(),
          paid: { amountAtomic: PRICE_ATOMIC, asset: USDC_BASE, network: "eip155:8453" },
        },
        200,
        {
          "PAYMENT-RESPONSE": b64encode(JSON.stringify(settlement)),
          "X-Payment-Response": b64encode(JSON.stringify(settlement)),
        },
      );
    }

    return json({ error: "not_found", available: ["/", "/health", "/openapi.json", "/price"] }, 404);
  },
};
