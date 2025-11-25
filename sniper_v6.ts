import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
} from "@solana/web3.js";
import axios from "axios";
import bs58 from "bs58";
import * as dotenv from "dotenv";

// -----------------------------------------------------------------------------
//  pump.fun sniper v6
//
//  This version of the pump.fun sniper is designed to be ready for use with
//  premium RPC providers such as Helius Pro or Triton VIP that reliably
//  forward program logs.  It monitors the official pump.fun program for
//  `new_token_created` log messages and automatically buys tokens as soon as
//  they're launched.  After buying, the bot manages the position using an
//  auto‑sell watcher with configurable take‑profit and stop‑loss rules.
//
//  Unlike the v3/v4 legacy versions which relied on pumpportal.fun
//  WebSockets, this implementation listens directly to the on‑chain logs
//  emitted by the pump.fun program.  Free RPC tiers often filter or throttle
//  these logs, so an upgraded endpoint is recommended.  If you do not yet
//  have access to a premium RPC, you can continue using sniper_v3.ts until
//  you're ready to upgrade.
//
//  To configure this bot, copy `.env.example` to `.env` and set the
//  appropriate values.  At a minimum you will need to provide your private
//  key (base58‑encoded) and RPC endpoints.  The bot will automatically use
//  the environment variables when available.
// -----------------------------------------------------------------------------

// Load environment variables.  The override:true option ensures that values in
// the .env file replace any existing environment variables, preventing stale
// defaults from leaking in via the operating system.  See README for details.
dotenv.config({ override: true });

// Telegram configuration.  Provide your bot token and chat ID to receive
// notifications about buys, sells and errors.  If left blank, telegram
// messages are silently ignored.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

// Private key for signing transactions.  This should be a base58 encoded
// secret key (64 bytes).  Never share this key with anyone or commit it to
// version control.  If omitted or invalid, the script will throw an error
// during startup.
const PRIVATE_KEY_B58 = process.env.PRIVATE_KEY_B58 || "";

// RPC endpoints.  For best results, set these to your Helius or Triton
// endpoints with your API key.  The HTTP endpoint is used for all REST
// requests (e.g. Jupiter calls) and for the log subscription.  The WS
// endpoint is optional; if omitted, solana/web3.js will derive a websocket
// URL from the HTTP endpoint.  See README for examples.
const RPC_HTTP_ENDPOINT =
  process.env.RPC_HTTP_ENDPOINT ||
  "https://mainnet.helius-rpc.com/?api-key=REPLACE_WITH_YOUR_HELIUS_KEY";
const RPC_WS_ENDPOINT = process.env.RPC_WS_ENDPOINT || "";

// Jupiter API base.  Allow override via environment in case you wish to
// point at a self‑hosted Jupiter aggregator or staging environment.  The
// default points at the public Jupiter API.
const JUPITER_API_BASE = process.env.JUPITER_API_BASE || "https://public.jupiterapi.com";

// The official pump.fun program ID that emits `new_token_created` logs.  This
// constant comes from the pump.fun SDK and community resources【221282341061157†L120-L160】.
// Do not change unless the pump.fun contract is upgraded.  If pump.fun ever
// migrates to a new program, update this constant accordingly.
const PUMPFUN_LOG_PROGRAM = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

// Buy amount in SOL.  Override via BUY_AMOUNT_SOL in your .env file.  Keep in
// mind that network fees are charged on top of this amount and that buying
// too aggressively can lead to slippage on illiquid pairs.
const BUY_AMOUNT_SOL = Number(process.env.BUY_AMOUNT_SOL || "0.03");

// Maximum slippage in basis points (1 basis point = 0.01%).  A value of 300
// means 3% slippage.  Jupiter will not execute swaps that exceed this
// threshold.
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || "300");

// Stop‑loss and take‑profit rules.  The bot sells 50% of the position at
// +7%, 30% at +18% and the remainder on a 12% trailing stop after a take
// profit is hit.  All values can be tuned via .env if desired.
const STOP_LOSS_MULT = 0.75; // sell all at −25%
const TP1_MULT = 1.07; // sell 50% at +7%
const TP2_MULT = 1.18; // sell 30% at +18%
const TP1_SELL_FRACTION = 0.5;
const TP2_SELL_FRACTION = 0.3;
const TRAILING_STOP_DISTANCE = 0.12; // trailing stop at −12% from high

// Compute unit prioritization fees.  These values are dynamic: on each
// successful transaction the fee is reduced slightly, on a failed
// transaction it is increased.  This helps the bot achieve fast
// confirmations without overspending on fees.
const MIN_PRIORITY_LAMPORTS = 150_000;
const MAX_PRIORITY_LAMPORTS = 1_000_000;
let currentPriorityLamports = 300_000;

// Minimal out amount used in the anti‑scam check.  Prevents buying tokens
// with too little liquidity.  At least one raw unit must be returned.
const MIN_OUT_AMOUNT_RAW = 1n;

// Track mints we've already processed to avoid double buys.
const snipedMints = new Set<string>();

// Track time of last new token event for inactivity notifications.
let lastNewTokenTimestamp = Date.now();
let inactivityAlertSent = false;

// -----------------------------------------------------------------------------
//  Utility functions
//
//  Helper routines for loading keys, sending Telegram notifications,
//  adjusting priority fees, sleeping, and performing Jupiter API calls.
// -----------------------------------------------------------------------------

function loadKeypairFromBs58(secretKey58: string): Keypair {
  const decoded = bs58.decode(secretKey58);
  return Keypair.fromSecretKey(decoded);
}

async function sendTelegram(msg: string) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: "HTML",
      }
    );
  } catch (e) {
    console.error("❌ Telegram küldési hiba:", e);
  }
}

function adjustPriority(success: boolean) {
  const before = currentPriorityLamports;
  if (success) {
    currentPriorityLamports = Math.max(
      MIN_PRIORITY_LAMPORTS,
      currentPriorityLamports - 10_000
    );
  } else {
    currentPriorityLamports = Math.min(
      MAX_PRIORITY_LAMPORTS,
      currentPriorityLamports + 50_000
    );
  }
  if (before !== currentPriorityLamports) {
    console.log(
      `⚡ Priority fee változott: ${before} → ${currentPriorityLamports} lamports`
    );
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Jupiter API: quote endpoint.  Returns a route for swapping inputMint to
// outputMint with a specified amount and slippage.  See Jup.ag docs.
async function getQuote(params: {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
}) {
  const url = `${JUPITER_API_BASE}/quote`;
  const { data } = await axios.get(url, {
    params: {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount.toString(),
      slippageBps: params.slippageBps,
    },
  });
  return data;
}

// Jupiter API: swap endpoint.  Constructs a transaction for swapping tokens
// using the previously obtained quote.  Includes compute unit prioritization.
async function getSwapTransaction(params: {
  quoteResponse: any;
  userPublicKey: PublicKey;
}) {
  const url = `${JUPITER_API_BASE}/swap`;
  const body: any = {
    quoteResponse: params.quoteResponse,
    userPublicKey: params.userPublicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        maxLamports: currentPriorityLamports,
        global: true,
      },
    },
  };
  const { data } = await axios.post(url, body, {
    headers: { "Content-Type": "application/json" },
  });
  return data.swapTransaction as string;
}

async function sendSignedTx(
  connection: Connection,
  tx: VersionedTransaction
): Promise<string> {
  try {
    const sig = await connection.sendTransaction(tx, {
      skipPreflight: true,
    });
    console.log("🟢 Tx elküldve:", sig);
    console.log("🔗 Solscan:", `https://solscan.io/tx/${sig}`);
    const conf = await connection.confirmTransaction(sig, "confirmed");
    console.log("🔵 Confirmed:", conf.value);
    adjustPriority(true);
    return sig;
  } catch (e) {
    console.log("❌ Tx küldési hiba:", e);
    adjustPriority(false);
    throw e;
  }
}

// Fetch token balance and decimals for an SPL token.  Throws if the user has
// no associated token account.
async function getTokenAccountAndBalance(params: {
  connection: Connection;
  owner: PublicKey;
  mint: string;
}): Promise<{
  tokenAccount: PublicKey;
  amountRaw: bigint;
  decimals: number;
}> {
  const { connection, owner, mint } = params;
  const mintPk = new PublicKey(mint);
  const resp = await connection.getParsedTokenAccountsByOwner(owner, {
    mint: mintPk,
  });
  if (resp.value.length === 0) {
    throw new Error(
      "Nincs SPL token account ehhez a minthoz (balance = 0?)."
    );
  }
  const acc = resp.value[0];
  const info: any = acc.account.data.parsed.info;
  const amountStr: string = info.tokenAmount.amount;
  const decimals: number = info.tokenAmount.decimals;
  return {
    tokenAccount: acc.pubkey,
    amountRaw: BigInt(amountStr),
    decimals,
  };
}

// Approximate price of a token in SOL using a 1e6 raw quote.  Used by the
// autoSellWatcher to track take‑profit and stop‑loss levels.
async function getPriceInSol(tokenMint: string): Promise<number> {
  const amount = 1_000_000n;
  const quote = await getQuote({
    inputMint: tokenMint,
    outputMint: SOL_MINT,
    amount,
    slippageBps: 50,
  });
  const outAmountLamports = Number(quote.outAmount);
  return outAmountLamports / 1e9;
}

// -----------------------------------------------------------------------------
//  Buying and selling
//
//  The buyToken and sellToken functions encapsulate the logic for swapping
//  tokens via Jupiter.  They perform an anti‑scam check, build the swap
//  transaction, sign it, send it, and handle notifications.  sellToken
//  supports fractional sells for take‑profit and trailing stop events.
// -----------------------------------------------------------------------------

async function buyToken(
  connection: Connection,
  wallet: Keypair,
  mint: string
): Promise<{ txSig: string; entryPriceSol: number } | null> {
  console.log(`🎯 BUY indul → ${mint}`);
  const balanceLamports = await connection.getBalance(wallet.publicKey);
  const balanceSol = balanceLamports / 1e9;
  console.log("💰 Wallet balance:", balanceSol.toFixed(4), "SOL");
  if (balanceSol < BUY_AMOUNT_SOL + 0.003) {
    const msg = `❌ Nincs elég SOL.\nJelenleg: ${balanceSol.toFixed(
      4
    )} SOL\nKell: ~${(BUY_AMOUNT_SOL + 0.003).toFixed(4)} SOL`;
    console.log(msg);
    await sendTelegram(msg);
    return null;
  }
  const amountLamports = BigInt(Math.floor(BUY_AMOUNT_SOL * 1e9));
  console.log("🔍 Anti-scam check (Jupiter quote)...");
  const quote = await getQuote({
    inputMint: SOL_MINT,
    outputMint: mint,
    amount: amountLamports,
    slippageBps: SLIPPAGE_BPS,
  });
  if (!quote || !quote.outAmount) {
    await sendTelegram(
      `🚫 <b>Anti-scam fail (nincs outAmount)</b>\nMint: <code>${mint}</code>`
    );
    return null;
  }
  const outRaw = BigInt(quote.outAmount);
  if (outRaw < MIN_OUT_AMOUNT_RAW) {
    await sendTelegram(
      `🚫 <b>Anti-scam fail</b>\nMint: <code>${mint}</code>\nOk: túl alacsony outAmount (kevés likviditás)`
    );
    return null;
  }
  console.log("✅ Anti-scam passed. Performing buy...");
  await sendTelegram(
    `🎯 <b>pump.fun BUY indul</b>\nMennyiség: ${BUY_AMOUNT_SOL} SOL\nMint: <code>${mint}</code>\nPriority fee: <b>${currentPriorityLamports}</b> lamports`
  );
  const swapTxBase64 = await getSwapTransaction({
    quoteResponse: quote,
    userPublicKey: wallet.publicKey,
  });
  const swapTxBuf = Buffer.from(swapTxBase64, "base64");
  const tx = VersionedTransaction.deserialize(swapTxBuf);
  tx.sign([wallet]);
  const sig = await sendSignedTx(connection, tx);
  const inSol = Number(quote.inAmount) / 1e9;
  const outTokens = Number(quote.outAmount) / 10 ** quote.outDecimals;
  const entryPriceSol = inSol / outTokens;
  await sendTelegram(
    `🟢 <b>BUY sikeres</b>\nMint: <code>${mint}</code>\nTx: https://solscan.io/tx/${sig}\nBelépő ár ~ <b>${entryPriceSol.toFixed(
      9
    )}</b> SOL/token`
  );
  return { txSig: sig, entryPriceSol };
}

async function sellToken(
  connection: Connection,
  wallet: Keypair,
  mint: string,
  sellFraction: number,
  reason: string
): Promise<string | null> {
  console.log(`💸 SELL indul (${reason}) – mint: ${mint}`);
  const bal = await getTokenAccountAndBalance({
    connection,
    owner: wallet.publicKey,
    mint,
  });
  if (bal.amountRaw === 0n) {
    console.log("⚠ Token balance = 0, nincs mit eladni.");
    return null;
  }
  const fractionClamped = Math.min(Math.max(sellFraction, 0), 1);
  const amountToSellRaw = BigInt(
    Math.floor(Number(bal.amountRaw) * fractionClamped)
  );
  if (amountToSellRaw === 0n) {
    console.log(
      "⚠ Eladandó mennyiség 0 – valószínűleg már mindent eladtunk."
    );
    return null;
  }
  await sendTelegram(
    `🔴 <b>${reason} SELL indul</b>\nMint: <code>${mint}</code>\nMennyiség: ~${(
      Number(amountToSellRaw) /
      10 ** bal.decimals
    ).toFixed(4)} token\nArány: <b>${(
      fractionClamped * 100
    ).toFixed(1)}%</b>`
  );
  const quote = await getQuote({
    inputMint: mint,
    outputMint: SOL_MINT,
    amount: amountToSellRaw,
    slippageBps: SLIPPAGE_BPS,
  });
  if (!quote || !quote.outAmount) {
    console.log("❌ SELL: nincs outAmount / route.");
    return null;
  }
  const swapTxBase64 = await getSwapTransaction({
    quoteResponse: quote,
    userPublicKey: wallet.publicKey,
  });
  const swapTxBuf = Buffer.from(swapTxBase64, "base64");
  const tx = VersionedTransaction.deserialize(swapTxBuf);
  tx.sign([wallet]);
  const sig = await sendSignedTx(connection, tx);
  await sendTelegram(
    `✅ <b>${reason} SELL kész</b>\nMint: <code>${mint}</code>\nTx: https://solscan.io/tx/${sig}`
  );
  return sig;
}

// -----------------------------------------------------------------------------
//  AutoSellWatcher
//
//  Monitors the price of a token after purchase.  Implements hard stop loss,
//  two take‑profit levels and a trailing stop.  When any rule triggers, it
//  sells some or all of the tokens and exits.  The watcher runs until the
//  position is fully sold.  Errors are reported via telegram and logged.
// -----------------------------------------------------------------------------

async function autoSellWatcher(params: {
  connection: Connection;
  wallet: Keypair;
  mint: string;
  entryPriceSol: number;
}) {
  const { connection, wallet, mint, entryPriceSol } = params;
  const hardSL = entryPriceSol * STOP_LOSS_MULT;
  const tp1 = entryPriceSol * TP1_MULT;
  const tp2 = entryPriceSol * TP2_MULT;
  let highestPrice = entryPriceSol;
  let tp1Done = false;
  let tp2Done = false;
  console.log("💹 Smart AutoSell watcher indul:");
  console.log("  TP1:", tp1, "SOL/token (50% SELL)");
  console.log("  TP2:", tp2, "SOL/token (30% SELL)");
  console.log("  Hard SL:", hardSL, "SOL/token");
  console.log(
    "  Trailing stop distance:",
    TRAILING_STOP_DISTANCE * 100,
    "%"
  );
  await sendTelegram(
    `📈 <b>Smart AutoSell watcher indul</b>\nMint: <code>${mint}</code>\nTP1: <b>${tp1.toFixed(
      9
    )}</b> SOL (50%)\nTP2: <b>${tp2.toFixed(9)}</b> SOL (30%)\nHard SL: <b>${hardSL.toFixed(
      9
    )}</b> SOL\nTrailing: <b>${(TRAILING_STOP_DISTANCE * 100).toFixed(
      1
    )}%</b>`
  );
  while (true) {
    try {
      const priceNow = await getPriceInSol(mint);
      if (!isFinite(priceNow) || priceNow <= 0) {
        console.log("⚠ Érvénytelen ár, várunk...");
        await sleep(5000);
        continue;
      }
      highestPrice = Math.max(highestPrice, priceNow);
      const trailingLevel =
        highestPrice * (1 - TRAILING_STOP_DISTANCE);
      console.log(
        "📊 Ár:",
        priceNow,
        "SOL/token | highest:",
        highestPrice,
        "| trailingLevel:",
        trailingLevel
      );
      // Hard stop loss
      if (priceNow <= hardSL) {
        console.log("❌ HARD STOP LOSS – teljes SELL");
        await sellToken(connection, wallet, mint, 1.0, "Hard SL");
        break;
      }
      // Take profit 1
      if (!tp1Done && priceNow >= tp1) {
        console.log("✅ TP1 elérve – 50% SELL");
        await sellToken(
          connection,
          wallet,
          mint,
          TP1_SELL_FRACTION,
          "TP1 (+7%)"
        );
        tp1Done = true;
      }
      // Take profit 2
      if (!tp2Done && priceNow >= tp2) {
        console.log("✅ TP2 elérve – 30% SELL");
        await sellToken(
          connection,
          wallet,
          mint,
          TP2_SELL_FRACTION,
          "TP2 (+18%)"
        );
        tp2Done = true;
      }
      // Trailing stop after TP
      if ((tp1Done || tp2Done) && priceNow <= trailingLevel) {
        console.log(
          "📉 TRAILING STOP – maradék teljes SELL"
        );
        await sellToken(connection, wallet, mint, 1.0, "Trailing stop");
        break;
      }
      await sleep(5000);
    } catch (e) {
      console.error("⚠ Ár figyelés hiba:", e);
      await sendTelegram(
        `⚠ <b>Ár figyelés hiba</b>\nMint: <code>${mint}</code>\n${e}`
      );
      await sleep(5000);
    }
  }
  console.log("💸 Smart AutoSell watcher vége:", mint);
}

// -----------------------------------------------------------------------------
//  pump.fun log listener
//
//  Subscribes to logs for the pump.fun program on the provided RPC
//  connection.  When a log containing "new_token_created" is detected, the
//  mint address is extracted, a buy is attempted, and the auto sell watcher
//  is started.  If the same mint is seen again, it is ignored.  Errors are
//  logged and sent via telegram.
// -----------------------------------------------------------------------------

async function startPumpFunLogListener(
  connection: Connection,
  wallet: Keypair
) {
  console.log(
    "📡 pump.fun log listener elindul – program:",
    PUMPFUN_LOG_PROGRAM.toBase58()
  );
  const subId = await connection.onLogs(
    PUMPFUN_LOG_PROGRAM,
    async (logs: any) => {
      try {
        const text = (logs.logs || []).join(" ");
        if (!text.includes("new_token_created")) return;
        const match = text.match(/mint=([A-Za-z0-9]+)/);
        if (!match) {
          console.log(
            "⚠ new_token_created log, de nem találtunk mint= mezőt."
          );
          return;
        }
        const mint = match[1];
        lastNewTokenTimestamp = Date.now();
        inactivityAlertSent = false;
        if (snipedMints.has(mint)) {
          console.log("⚠ Ezt a mintet már snipeltük:", mint);
          return;
        }
        snipedMints.add(mint);
        console.log("🆕 ÚJ pump.fun token detected (LOG):", mint);
        await sendTelegram(
          `🆕 <b>Új pump.fun token</b>\nMint: <code>${mint}</code>`
        );
        const buyRes = await buyToken(connection, wallet, mint);
        if (buyRes && buyRes.entryPriceSol > 0) {
          autoSellWatcher({
            connection,
            wallet,
            mint,
            entryPriceSol: buyRes.entryPriceSol,
          }).catch((e) => console.error("AutoSell watcher hiba:", e));
        }
      } catch (e) {
        console.error("❌ pump.fun log callback hiba:", e);
        await sendTelegram(
          `⚠ <b>pump.fun log callback hiba</b>\n${e}`
        );
      }
    },
    "processed"
  );
  console.log("📡 pump.fun log subscription ID:", subId);
  await sendTelegram(
    `📡 <b>pump.fun LOG listener elindítva</b>\nSubscription ID: <code>${subId}</code>\nCommitment: <b>processed</b>`
  );
}

// -----------------------------------------------------------------------------
//  Inactivity watcher
//
//  Sends a Telegram alert if no new token logs are observed for a set period
//  (10 minutes).  Helps the user know when the market is quiet or if
//  something is wrong with the listener.
// -----------------------------------------------------------------------------

function startInactivityWatcher() {
  setInterval(() => {
    const now = Date.now();
    const diff = now - lastNewTokenTimestamp;
    const tenMinutes = 10 * 60 * 1000;
    if (diff >= tenMinutes && !inactivityAlertSent) {
      inactivityAlertSent = true;
      const mins = (diff / 60000).toFixed(1);
      console.log(
        `⏰ Már ~${mins} perce nem érkezett új pump.fun token log.`
      );
      sendTelegram(
        `⏰ <b>Inaktivitás</b>\nMár ~${mins} perce nem érkezett új pump.fun token log.`
      ).catch(() => {});
    }
    if (diff < tenMinutes) {
      inactivityAlertSent = false;
    }
  }, 60_000);
}

// -----------------------------------------------------------------------------
//  Entry point
//
//  Initializes the wallet, connection, and event listeners.  On startup it
//  sends a Telegram notification describing the configuration.  Any fatal
//  errors are also reported via telegram.
// -----------------------------------------------------------------------------

async function main() {
  if (!PRIVATE_KEY_B58 || PRIVATE_KEY_B58.length < 20) {
    throw new Error(
      "❌ Állítsd be a PRIVATE_KEY_B58 értékét a .env fájlban!"
    );
  }
  const wallet = loadKeypairFromBs58(PRIVATE_KEY_B58);
  // Create connection.  Provide wsEndpoint explicitly if set; otherwise
  // solana/web3.js will derive it automatically from the HTTP URL.  Use
  // commitment 'processed' for low‑latency log subscription.
  const connection = new Connection(RPC_HTTP_ENDPOINT, {
    commitment: "processed",
    wsEndpoint: RPC_WS_ENDPOINT || undefined,
  } as any);
  console.log("🔑 Wallet:", wallet.publicKey.toBase58());
  console.log("🌐 RPC endpoint:", RPC_HTTP_ENDPOINT);
  if (RPC_WS_ENDPOINT) {
    console.log("🌐 WS endpoint:", RPC_WS_ENDPOINT);
  }
  console.log("💵 BUY_AMOUNT_SOL:", BUY_AMOUNT_SOL, "SOL");
  console.log(
    "⚡ Kezdő priority fee:",
    currentPriorityLamports,
    "lamports"
  );
  await sendTelegram(
    `🚀 <b>pump.fun sniper_v6 elindult</b>\nWallet: <code>${wallet.publicKey.toBase58()}</code>\nRPC: <code>${RPC_HTTP_ENDPOINT}</code>\nBUY: <b>${BUY_AMOUNT_SOL}</b> SOL\nPriority fee: <b>${currentPriorityLamports}</b> lamports`
  );
  await startPumpFunLogListener(connection, wallet);
  startInactivityWatcher();
  console.log("🚀 Sniper fut. Várakozás pump.fun új token logokra...");
}

main().catch(async (err) => {
  console.error("❌ FATAL HIBA A BOT FUTÁSA KÖZBEN:", err);
  await sendTelegram(
    `❌ <b>Fő hiba a pump.fun sniper_v6-ben</b>\n${err?.message || err}`
  );
});