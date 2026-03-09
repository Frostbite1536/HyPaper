#!/usr/bin/env node

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = 'true';
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(url) {
  return url.endsWith('/') ? url : `${url}/`;
}

function httpUrl(baseUrl, path) {
  return new URL(path.replace(/^\//, ''), normalizeBaseUrl(baseUrl));
}

function nowIso() {
  return new Date().toISOString();
}

function roundPrice(value) {
  if (value >= 1000) return value.toFixed(2);
  if (value >= 1) return value.toFixed(4);
  return value.toFixed(6);
}

function roundSize(value) {
  if (value >= 1) return value.toFixed(4);
  if (value >= 0.1) return value.toFixed(5);
  return value.toFixed(6);
}

function extractFilledSize(status) {
  const filled = Number(status?.filled?.totalSz);
  return Number.isFinite(filled) && filled > 0 ? filled : null;
}

function extractFilledPrice(status) {
  const avgPx = Number(status?.filled?.avgPx);
  return Number.isFinite(avgPx) && avgPx > 0 ? avgPx : null;
}

function getNextDelayMs(intervalMinutes, alignToInterval) {
  const intervalMs = Math.max(1, Math.round(intervalMinutes * 60 * 1000));
  if (!alignToInterval) {
    return intervalMs;
  }
  const remainder = Date.now() % intervalMs;
  return remainder === 0 ? intervalMs : intervalMs - remainder;
}

async function getJson(baseUrl, path, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(httpUrl(baseUrl, path), {
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(`GET ${path} failed (${response.status}): ${JSON.stringify(data)}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(baseUrl, path, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(httpUrl(baseUrl, path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(`POST ${path} failed (${response.status}): ${JSON.stringify(data)}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveAssetIndex(baseUrl, coin, timeoutMs) {
  const meta = await postJson(baseUrl, '/info', { type: 'meta' }, timeoutMs);
  const universe = Array.isArray(meta?.universe) ? meta.universe : [];
  const index = universe.findIndex((asset) => asset?.name === coin);
  if (index < 0) {
    throw new Error(`Coin ${coin} not found in meta.universe`);
  }
  return index;
}

function printHelp() {
  console.log(`Usage: node scripts/btc-hourly-long.mjs [options]

Long BTC every hour by placing a buy order worth a fixed USD notional.

Options:
  --base-url <url>       API base URL (default: https://hyppaer-production.up.railway.app)
  --wallet <id>          Wallet/user id (default: 0xhourlybtc)
  --coin <symbol>        Coin symbol (default: BTC)
  --usd <amount>         USD notional per hourly buy (default: 50)
  --slippage-bps <bps>   Buy limit premium above mid price (default: 15)
  --tif <Gtc|Ioc|Alo>    Time in force (default: Ioc)
  --tp-pct <n>           Take-profit percent above fill price (default: 1)
  --sl-pct <n>           Stop-loss percent below fill price (default: 1)
  --interval-minutes <n> Run interval in minutes (default: 60)
  --fixed-interval       Wait exactly interval minutes between runs (no clock alignment)
  --leverage <1-200>     Optional leverage update before first order
  --max-runs <n>         Stop after n hourly runs
  --once                 Run immediately once, then exit
  --timeout-ms <ms>      HTTP timeout (default: 15000)
  --help                 Show this message

Examples:
  npm run bot:btc-hourly-long
  npm run bot:btc-hourly-long -- --wallet 0xpaperbot --usd 100 --slippage-bps 20
  npm run bot:btc-hourly-long -- --once --base-url http://localhost:3000
  npm run bot:btc-hourly-long -- --interval-minutes 2 --max-runs 3
  npm run bot:btc-hourly-long -- --tp-pct 1.5 --sl-pct 0.8
`);
}

async function placeTpSl(context, fillPrice, fillSize) {
  const { baseUrl, wallet, assetIndex, coin, tpPct, slPct, timeoutMs } = context;
  if (tpPct <= 0 || slPct <= 0) {
    console.log(`[${nowIso()}] TP/SL disabled (tpPct=${tpPct}, slPct=${slPct})`);
    return;
  }

  const tpTrigger = fillPrice * (1 + tpPct / 100);
  const slTrigger = fillPrice * (1 - slPct / 100);
  const size = roundSize(fillSize);
  const tpPx = roundPrice(tpTrigger);
  const slPx = roundPrice(slTrigger);

  const tpSlPayload = {
    wallet,
    action: {
      type: 'order',
      grouping: 'normalTpsl',
      orders: [
        {
          a: assetIndex,
          b: false,
          p: tpPx,
          s: size,
          r: true,
          t: {
            trigger: {
              isMarket: true,
              triggerPx: tpPx,
              tpsl: 'tp',
            },
            limit: { tif: 'Gtc' },
          },
        },
        {
          a: assetIndex,
          b: false,
          p: slPx,
          s: size,
          r: true,
          t: {
            trigger: {
              isMarket: true,
              triggerPx: slPx,
              tpsl: 'sl',
            },
            limit: { tif: 'Gtc' },
          },
        },
      ],
    },
  };

  const result = await postJson(baseUrl, '/exchange', tpSlPayload, timeoutMs);
  const statuses = result?.response?.data?.statuses ?? [];
  console.log(
    `[${nowIso()}] TP/SL attached for ${coin} | size=${size} tpTrigger=${tpPx} slTrigger=${slPx} statuses=${JSON.stringify(statuses)}`,
  );
}

async function placeHourlyLong(context) {
  const {
    baseUrl,
    wallet,
    coin,
    usdNotional,
    slippageBps,
    tif,
    timeoutMs,
    assetIndex,
  } = context;

  await getJson(baseUrl, '/health', timeoutMs);
  const mids = await postJson(baseUrl, '/info', { type: 'allMids' }, timeoutMs);
  const mid = Number(mids?.[coin]);
  if (!Number.isFinite(mid) || mid <= 0) {
    throw new Error(`Missing/invalid mid price for ${coin}: ${mids?.[coin]}`);
  }

  const limit = mid * (1 + slippageBps / 10000);
  const size = usdNotional / mid;
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(`Invalid size computed from usd=${usdNotional}, mid=${mid}`);
  }

  const orderPayload = {
    wallet,
    action: {
      type: 'order',
      grouping: 'na',
      orders: [
        {
          a: assetIndex,
          b: true,
          p: roundPrice(limit),
          s: roundSize(size),
          r: false,
          t: { limit: { tif } },
        },
      ],
    },
  };

  const orderResult = await postJson(baseUrl, '/exchange', orderPayload, timeoutMs);
  const statuses = orderResult?.response?.data?.statuses ?? [];
  const status = statuses[0] ?? { error: 'No status returned' };
  const filledSize = extractFilledSize(status);
  const filledPrice = extractFilledPrice(status);

  const state = await postJson(
    baseUrl,
    '/info',
    { type: 'clearinghouseState', user: wallet },
    timeoutMs,
  );
  const position = (state?.assetPositions ?? []).find((entry) => entry?.position?.coin === coin)?.position;

  const longSize = position?.szi ?? '0';
  const entryPx = position?.entryPx ?? '-';

  console.log(
    `[${nowIso()}] ${coin} buy sent | mid=${roundPrice(mid)} limit=${roundPrice(limit)} size=${roundSize(size)} status=${JSON.stringify(status)} | position.szi=${longSize} entryPx=${entryPx}`,
  );

  if (filledSize !== null && filledPrice !== null) {
    await placeTpSl(context, filledPrice, filledSize);
  } else {
    console.log(`[${nowIso()}] Skipping TP/SL attach because buy was not filled immediately.`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === 'true') {
    printHelp();
    return;
  }

  const baseUrl = args['base-url'] ?? 'https://hyppaer-production.up.railway.app';
  const wallet = args.wallet ?? '0xhourlybtc';
  const coin = args.coin ?? 'BTC';
  const usdNotional = toNumber(args.usd, 50);
  const slippageBps = toNumber(args['slippage-bps'], 15);
  const tif = args.tif ?? 'Ioc';
  const tpPct = toNumber(args['tp-pct'], 1);
  const slPct = toNumber(args['sl-pct'], 1);
  const intervalMinutes = toNumber(args['interval-minutes'], 60);
  const alignToInterval = args['fixed-interval'] !== 'true';
  const maxRuns = args['max-runs'] ? Math.max(1, Math.floor(toNumber(args['max-runs'], 1))) : null;
  const once = args.once === 'true';
  const timeoutMs = Math.max(1000, toNumber(args['timeout-ms'], 15000));
  const leverage = args.leverage ? Math.floor(toNumber(args.leverage, 20)) : null;

  if (!Number.isFinite(usdNotional) || usdNotional <= 0) {
    throw new Error(`--usd must be a positive number, got "${args.usd}"`);
  }
  if (!Number.isFinite(slippageBps) || slippageBps < 0) {
    throw new Error(`--slippage-bps must be >= 0, got "${args['slippage-bps']}"`);
  }
  if (!['Gtc', 'Ioc', 'Alo'].includes(tif)) {
    throw new Error(`--tif must be one of Gtc, Ioc, Alo, got "${tif}"`);
  }
  if (!Number.isFinite(tpPct) || tpPct < 0) {
    throw new Error(`--tp-pct must be >= 0, got "${args['tp-pct']}"`);
  }
  if (!Number.isFinite(slPct) || slPct < 0) {
    throw new Error(`--sl-pct must be >= 0, got "${args['sl-pct']}"`);
  }
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    throw new Error(`--interval-minutes must be > 0, got "${args['interval-minutes']}"`);
  }
  if (leverage !== null && (leverage < 1 || leverage > 200)) {
    throw new Error(`--leverage must be in range 1-200, got "${leverage}"`);
  }

  const assetIndex = await resolveAssetIndex(baseUrl, coin, timeoutMs);
  console.log(
    `[${nowIso()}] Strategy: ${coin} long | baseUrl=${baseUrl} wallet=${wallet} usd=${usdNotional} slippageBps=${slippageBps} tif=${tif} tpPct=${tpPct} slPct=${slPct} intervalMinutes=${intervalMinutes} aligned=${alignToInterval} assetIndex=${assetIndex}`,
  );

  if (leverage !== null) {
    await postJson(
      baseUrl,
      '/exchange',
      {
        wallet,
        action: {
          type: 'updateLeverage',
          asset: assetIndex,
          isCross: true,
          leverage,
        },
      },
      timeoutMs,
    );
    console.log(`[${nowIso()}] Leverage set to ${leverage}x (cross) for ${coin}`);
  }

  const runContext = {
    baseUrl,
    wallet,
    coin,
    usdNotional,
    slippageBps,
    tif,
    tpPct,
    slPct,
    timeoutMs,
    assetIndex,
  };

  if (once) {
    await placeHourlyLong(runContext);
    return;
  }

  let runs = 0;
  while (true) {
    if (maxRuns !== null && runs >= maxRuns) {
      console.log(`[${nowIso()}] Reached max runs (${maxRuns}). Exiting.`);
      return;
    }

    const waitMs = getNextDelayMs(intervalMinutes, alignToInterval);
    const executeAt = new Date(Date.now() + waitMs).toISOString();
    console.log(`[${nowIso()}] Waiting ${Math.round(waitMs / 1000)}s until next run at ${executeAt}`);
    await sleep(waitMs);

    try {
      await placeHourlyLong(runContext);
      runs += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${nowIso()}] Hourly run failed: ${message}`);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
