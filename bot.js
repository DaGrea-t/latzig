require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
const { SigningCosmWasmClient } = require('@cosmjs/cosmwasm-stargate');
const { GasPrice, coins } = require('@cosmjs/stargate');

// ============== CONFIG ==============
const CONFIG = {
  CYCLE_INTERVAL_MS: Number(process.env.TRADE_DELAY_MS) || 1200,
  NOTIFY_EVERY_SWAPS: 50,
  DUST_DUMP_EVERY_CYCLES: 50,
  GAS_BUFFER_UZIG: 1_000_000n,
  DEFAULT_SLIPPAGE: '0.025',
  DUST_DUMP_SLIPPAGE: '0.05',
  MAX_CONSECUTIVE_FAILURES: 5,
};

// ============== ENV VALIDATION ==============
const REQUIRED_ENV = ['BOT_TOKEN', 'OWNER_ID', 'MNEMONIC', 'RPC', 'FACTORY', 'BRIDGE_DENOM', 'NATIVE_DENOM'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}
const OWNER_ID = Number(process.env.OWNER_ID);
if (!Number.isFinite(OWNER_ID)) {
  console.error('OWNER_ID must be a numeric Telegram user id');
  process.exit(1);
}

// ============== TOKEN DENOMS ==============
const TOKEN_DENOMS = {
  BRIDGE: process.env.BRIDGE_DENOM,
  MISSED: 'coin.zig1yg2cl37ey7snegl0ltzsmxt5aa4gnp53tqymzhx0lh9prl8zll0q5hwkce.missedit',
  THROB: 'coin.zig1cjszvv3lf35c0wvqek3548raup3zz6apk2cgc0z3mamjwn8rt9qqwjt0pu.throb',
  KARAK: 'coin.zig15nes6ctvl8f7tdwdgv5ekgfuv2k54qcq58s7zx5p86rdv2y4vn6qmjlqug.karakchai',
};

// ============== STATE ==============
const state = {
  step: null, // 'awaiting_amount' | 'awaiting_slippage' | 'awaiting_custom_slippage' | null
  pairToken: null,
  amountMin: null,
  amountMax: null,
  slippage: CONFIG.DEFAULT_SLIPPAGE,
  trading: false,
  cycle: 0,
  swaps: 0,
  interval: null,
  startedAt: null,
  consecutiveFailures: 0,
  pairAddress: null,
};

let wallet, account, client;

// ============== BOT ==============
const bot = new Telegraf(process.env.BOT_TOKEN);

bot.use((ctx, next) => {
  if (ctx.from?.id !== OWNER_ID) return;
  return next();
});

// ============== HELPERS ==============
const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

const uzigToZig = (uzig) => (Number(uzig) / 1_000_000).toFixed(4);

const zigStrToUzig = (zigStr) => BigInt(Math.floor(parseFloat(zigStr) * 1_000_000));

function randUzigInRange(minStr, maxStr) {
  const min = Number(minStr);
  const max = Number(maxStr);
  if (min === max) return min.toString();
  return Math.floor(min + Math.random() * (max - min)).toString();
}

const fetchBalance = async (denom) => (await client.getBalance(account.address, denom)).amount;

const formatUptime = (ms) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m ${s % 60}s`;
};

// ============== PAIR ADDRESS ==============
async function getPairAddress(targetDenom) {
  const query = {
    pair: {
      asset_infos: [
        { native_token: { denom: process.env.NATIVE_DENOM } },
        { native_token: { denom: targetDenom } },
      ],
    },
  };
  try {
    const res = await client.queryContractSmart(process.env.FACTORY, query);
    const pair = res.contract_addr || res.pair_addr || res.pair?.contract_addr;
    if (!pair) throw new Error('pair not present in response');
    return pair;
  } catch (e) {
    log('Pair query failed:', e.message);
    return null;
  }
}

// ============== SWAP ==============
async function executeSwap(pairAddress, offerDenom, askDenom, amount, slippage = state.slippage) {
  const isBuy = offerDenom === process.env.NATIVE_DENOM;
  log(`${isBuy ? 'BUY' : 'SELL'} ${uzigToZig(amount)}`);

  try {
    const before = await fetchBalance(askDenom);
    const msg = {
      swap: {
        offer_asset: { info: { native_token: { denom: offerDenom } }, amount },
        max_spread: slippage,
        to: null,
      },
    };
    await client.execute(
      account.address,
      pairAddress,
      msg,
      'auto',
      `Latzigt ${isBuy ? 'Buy' : 'Sell'}`,
      coins(amount, offerDenom),
    );
    const after = await fetchBalance(askDenom);
    const received = (BigInt(after) - BigInt(before || '0')).toString();

    state.swaps += 1;
    if (state.swaps % CONFIG.NOTIFY_EVERY_SWAPS === 0) {
      const zigBal = await fetchBalance(process.env.NATIVE_DENOM);
      bot.telegram.sendMessage(
        OWNER_ID,
        `Latzigt Bot — ${CONFIG.NOTIFY_EVERY_SWAPS} Swap Update\n\n` +
          `Token: ${state.pairToken}\n` +
          `Cycles: ${state.cycle}   Swaps: ${state.swaps}\n` +
          `ZIG Balance: ${uzigToZig(zigBal)} ZIG\n` +
          `Status: Active`,
      );
    }

    return BigInt(received) > 0n ? received : null;
  } catch (err) {
    log('Swap failed:', err.message);
    return null;
  }
}

// ============== TRADING LOOP ==============
async function startTrading() {
  if (state.trading) {
    return bot.telegram.sendMessage(OWNER_ID, 'Already trading. Use /stop first.');
  }

  const targetDenom = TOKEN_DENOMS[state.pairToken];
  if (!targetDenom) return bot.telegram.sendMessage(OWNER_ID, 'Token not supported.');

  state.pairAddress = await getPairAddress(targetDenom);
  if (!state.pairAddress) return bot.telegram.sendMessage(OWNER_ID, 'Trading pair not found.');

  state.trading = true;
  state.cycle = 0;
  state.swaps = 0;
  state.consecutiveFailures = 0;
  state.startedAt = Date.now();

  const amountLabel = state.amountMin === state.amountMax
    ? `${uzigToZig(state.amountMin)} ZIG`
    : `${uzigToZig(state.amountMin)}-${uzigToZig(state.amountMax)} ZIG`;
  const slipPct = (Number(state.slippage) * 100).toFixed(2);
  bot.telegram.sendMessage(
    OWNER_ID,
    `Farming ${state.pairToken} started\n` +
      `Amount: ${amountLabel} / cycle\n` +
      `Slippage: ${slipPct}%`,
  );

  state.interval = setInterval(async () => {
    try {
      state.cycle += 1;
      const cycleAmount = randUzigInRange(state.amountMin, state.amountMax);
      const floor = BigInt(cycleAmount) + CONFIG.GAS_BUFFER_UZIG;

      const zigBalance = await fetchBalance(process.env.NATIVE_DENOM);
      if (BigInt(zigBalance) < floor) {
        return stopTrading(`Trading stopped: Balance ${uzigToZig(zigBalance)} ZIG < required ${uzigToZig(floor)} ZIG.`);
      }

      const targetTokenDenom = TOKEN_DENOMS[state.pairToken];
      const received = await executeSwap(state.pairAddress, process.env.NATIVE_DENOM, targetTokenDenom, cycleAmount);
      if (received) {
        await executeSwap(state.pairAddress, targetTokenDenom, process.env.NATIVE_DENOM, received);
        state.consecutiveFailures = 0;
      } else {
        state.consecutiveFailures += 1;
      }

      if (state.cycle % CONFIG.DUST_DUMP_EVERY_CYCLES === 0) {
        const leftover = await fetchBalance(targetTokenDenom);
        if (BigInt(leftover || '0') > 0n) {
          await executeSwap(state.pairAddress, targetTokenDenom, process.env.NATIVE_DENOM, leftover, CONFIG.DUST_DUMP_SLIPPAGE);
        }
      }

      if (state.consecutiveFailures >= CONFIG.MAX_CONSECUTIVE_FAILURES) {
        return stopTrading(`Trading stopped: ${CONFIG.MAX_CONSECUTIVE_FAILURES} consecutive failures.`);
      }
    } catch (err) {
      log('Cycle error:', err.message);
      state.consecutiveFailures += 1;
    }
  }, CONFIG.CYCLE_INTERVAL_MS);
}

function stopTrading(reason = 'Trading stopped.') {
  if (state.interval) clearInterval(state.interval);
  state.interval = null;
  state.trading = false;
  state.step = null;
  bot.telegram.sendMessage(OWNER_ID, reason);
}

// ============== COMMANDS ==============
bot.start(async (ctx) => {
  const bal = await fetchBalance(process.env.NATIVE_DENOM);
  ctx.replyWithHTML(
    `<b>Latzigt Bot ready</b>\n\n` +
      `Address: <code>${account.address}</code>\n` +
      `Balance: ${uzigToZig(bal)} ZIG\n\n` +
      `Commands:\n` +
      `/trade — start farming\n` +
      `/live — status + stop button\n` +
      `/stop — stop trading\n` +
      `/balance — refresh ZIG balance`,
  );
});

bot.command('balance', async (ctx) => {
  const bal = await fetchBalance(process.env.NATIVE_DENOM);
  ctx.replyWithHTML(`<b>${uzigToZig(bal)} ZIG</b>\n<code>${account.address}</code>`);
});

bot.command('trade', (ctx) => {
  if (state.trading) return ctx.reply('Already trading. Use /stop first.');
  state.step = null;
  ctx.reply(
    'Select token to farm:',
    Markup.inlineKeyboard([
      [Markup.button.callback('MISSED', 'select_MISSED')],
      [Markup.button.callback('THROB', 'select_THROB')],
      [Markup.button.callback('KARAK', 'select_KARAK')],
      [Markup.button.callback('BRIDGE', 'select_BRIDGE')],
    ]),
  );
});

bot.action(/^select_(.+)$/, (ctx) => {
  const token = ctx.match[1];
  if (!TOKEN_DENOMS[token]) return ctx.answerCbQuery('Unknown token');
  state.pairToken = token;
  state.step = 'awaiting_amount';
  ctx.answerCbQuery();
  ctx.reply(
    `${token} selected.\n\nEnter amount per cycle:\n• Fixed: e.g. \`30\`\n• Range: e.g. \`30-50\``,
    { parse_mode: 'Markdown' },
  );
});

bot.action(/^slip_(.+)$/, (ctx) => {
  if (state.step !== 'awaiting_slippage') return ctx.answerCbQuery('No pending slippage selection.');
  const key = ctx.match[1];
  ctx.answerCbQuery();
  if (key === 'custom') {
    state.step = 'awaiting_custom_slippage';
    return ctx.reply('Enter custom slippage % (e.g. `1.5` for 1.5%):', { parse_mode: 'Markdown' });
  }
  const pct = parseFloat(key);
  if (!Number.isFinite(pct) || pct <= 0) return ctx.reply('Invalid slippage.');
  state.slippage = (pct / 100).toString();
  state.step = null;
  startTrading();
});

bot.action('stop_trade', (ctx) => {
  ctx.answerCbQuery();
  if (!state.trading) return ctx.reply('Not trading.');
  stopTrading('Trading stopped via /live.');
});

bot.command('stop', (ctx) => {
  if (!state.trading) return ctx.reply('Not trading.');
  stopTrading('Trading stopped.');
});

bot.command('live', async (ctx) => {
  if (!state.trading) return ctx.reply('Not currently trading. Use /trade to start.');
  const bal = await fetchBalance(process.env.NATIVE_DENOM);
  const amountLabel = state.amountMin === state.amountMax
    ? `${uzigToZig(state.amountMin)} ZIG`
    : `${uzigToZig(state.amountMin)}-${uzigToZig(state.amountMax)} ZIG`;
  const slipPct = (Number(state.slippage) * 100).toFixed(2);
  ctx.replyWithHTML(
    `<b>Live Trade</b>\n\n` +
      `Token: <b>${state.pairToken}</b>\n` +
      `Amount: ${amountLabel}\n` +
      `Slippage: ${slipPct}%\n` +
      `Cycles: ${state.cycle}   Swaps: ${state.swaps}\n` +
      `Uptime: ${formatUptime(Date.now() - state.startedAt)}\n` +
      `Balance: ${uzigToZig(bal)} ZIG`,
    Markup.inlineKeyboard([[Markup.button.callback('Stop Trade', 'stop_trade')]]),
  );
});

bot.on('text', (ctx) => {
  const txt = ctx.message.text.trim();
  if (txt.startsWith('/')) return;

  if (state.step === 'awaiting_amount') {
    const m = txt.match(/^(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?$/);
    if (!m) return ctx.reply('Invalid format. Use `30` or `30-50`.', { parse_mode: 'Markdown' });
    const min = zigStrToUzig(m[1]);
    const max = m[2] ? zigStrToUzig(m[2]) : min;
    if (min <= 0n) return ctx.reply('Amount must be > 0.');
    if (max < min) return ctx.reply('Range max must be ≥ min.');
    state.amountMin = min.toString();
    state.amountMax = max.toString();
    state.step = 'awaiting_slippage';
    return ctx.reply(
      'Select slippage:',
      Markup.inlineKeyboard([
        [Markup.button.callback('0.5%', 'slip_0.5'), Markup.button.callback('1%', 'slip_1')],
        [Markup.button.callback('2.5%', 'slip_2.5'), Markup.button.callback('5%', 'slip_5')],
        [Markup.button.callback('Custom', 'slip_custom')],
      ]),
    );
  }

  if (state.step === 'awaiting_custom_slippage') {
    if (!/^\d+(\.\d+)?$/.test(txt)) return ctx.reply('Enter a number, e.g. `1.5`.', { parse_mode: 'Markdown' });
    const pct = parseFloat(txt);
    if (pct <= 0 || pct > 50) return ctx.reply('Slippage must be between 0 and 50%.');
    state.slippage = (pct / 100).toString();
    state.step = null;
    return startTrading();
  }
});

// ============== BOOT ==============
(async () => {
  wallet = await DirectSecp256k1HdWallet.fromMnemonic(process.env.MNEMONIC, { prefix: 'zig' });
  [account] = await wallet.getAccounts();
  client = await SigningCosmWasmClient.connectWithSigner(process.env.RPC, wallet, {
    gasPrice: GasPrice.fromString('0.05uzig'),
  });

  log(`Wallet ready: ${account.address}`);

  await bot.launch();
  log('Latzigt Bot is LIVE (single-user mode)');
  bot.telegram.sendMessage(OWNER_ID, `Latzigt Bot online.\nAddress: <code>${account.address}</code>`, {
    parse_mode: 'HTML',
  });
})().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});

const shutdown = (signal) => {
  if (state.interval) clearInterval(state.interval);
  bot.stop(signal);
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
