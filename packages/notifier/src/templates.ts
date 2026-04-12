// Telegram message templates. Markdown-formatted, kept short and dense.
// Numbers use `code` blocks so monospace renders correctly in mobile clients.

import type { BotRow, DailySnapshotRow, RoundtripRow } from './db.js';

function fmtUsd(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function fmtPnl(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}$${n.toFixed(2)}`;
}

function fmtPct(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

/**
 * Batched fill notification — one message for N round-trips.
 * Triggered when there are NOTIFY_FILL_BATCH new round-trips since last poll.
 */
export function fillsTemplate(roundtrips: RoundtripRow[]): string {
  if (roundtrips.length === 0) return '';
  const total = roundtrips.reduce((sum, r) => sum + r.profit, 0);
  const lines = roundtrips.slice(0, 10).map((r) => {
    const arrow = r.profit >= 0 ? '✅' : '❌';
    return `${arrow} \`${fmtUsd(r.buy_price)}\` → \`${fmtUsd(r.sell_price)}\`  ${fmtPnl(r.profit)}`;
  });
  const more = roundtrips.length > 10 ? `\n…+${roundtrips.length - 10} more` : '';
  return [
    `*${roundtrips.length} new round-trip${roundtrips.length === 1 ? '' : 's'}*  total ${fmtPnl(total)}`,
    '',
    ...lines,
    more,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Drawdown alert — equity dropped from HWM by more than the configured %.
 */
export function drawdownTemplate(
  currentEquity: number,
  hwm: number,
  thresholdPct: number
): string {
  const drop = currentEquity - hwm;
  const dropPct = (drop / hwm) * 100;
  return [
    `🚨 *Drawdown alert*`,
    '',
    `Equity:  \`${fmtUsd(currentEquity)}\``,
    `HWM:     \`${fmtUsd(hwm)}\``,
    `Drop:    ${fmtPnl(drop)} (${fmtPct(dropPct)})`,
    '',
    `Threshold: ${thresholdPct}%. Check the dashboard.`,
  ].join('\n');
}

/**
 * Bot status transition (running ↔ paused/stopped/error).
 */
export function statusChangeTemplate(
  bot: BotRow,
  fromStatus: string,
  toStatus: string
): string {
  const emoji =
    toStatus === 'running'
      ? '▶️'
      : toStatus === 'paused'
        ? '⏸'
        : toStatus === 'error'
          ? '🔴'
          : '⏹';
  return [
    `${emoji} *Bot ${bot.id}* (${bot.pair}) is now *${toStatus.toUpperCase()}*`,
    `Was: \`${fromStatus}\``,
    bot.last_error ? `\nError: \`${bot.last_error}\`` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Daily summary — sent at DAILY_SUMMARY_HOUR_UTC.
 */
/**
 * F.2: Liquidation proximity alert — mark price is dangerously close
 * to the estimated liquidation price.
 */
export function liqProximityTemplate(
  bot: BotRow,
  markPrice: number,
  liqPrice: number,
  distancePct: number
): string {
  const emoji = distancePct < 5 ? '🚨🚨' : '⚠️';
  return [
    `${emoji} *Liquidation proximity — Bot ${bot.id}* (${bot.pair})`,
    '',
    `Mark:   \`${fmtUsd(markPrice)}\``,
    `Liq:    \`${fmtUsd(liqPrice)}\``,
    `Distance: \`${distancePct.toFixed(1)}%\``,
    '',
    distancePct < 5
      ? '‼️ *CRITICAL* — consider pausing or closing this bot immediately.'
      : 'Monitor closely. The bot will auto-pause if safeguard is enabled.',
  ].join('\n');
}

export function dailySummaryTemplate(
  bot: BotRow,
  snapshot: DailySnapshotRow | undefined,
  yesterdayEquity: number | null
): string {
  const equity = bot.investment_usdt + bot.total_pnl_usdt;
  const pct = (bot.total_pnl_usdt / bot.investment_usdt) * 100;
  const dayDelta =
    yesterdayEquity != null
      ? `\nDay:        ${fmtPnl(equity - yesterdayEquity)} (${fmtPct(((equity - yesterdayEquity) / yesterdayEquity) * 100)})`
      : '';
  const rtCount = snapshot?.round_trips ?? '—';
  return [
    `📊 *Daily summary — Bot ${bot.id} ${bot.pair}*`,
    '',
    `Equity:     \`${fmtUsd(equity)}\``,
    `Total PnL:  ${fmtPnl(bot.total_pnl_usdt)} (${fmtPct(pct)})${dayDelta}`,
    `Realized:   ${fmtPnl(bot.grid_profit_usdt)}`,
    `Unrealized: ${fmtPnl(bot.trend_pnl_usdt)}`,
    `Round-trips today: ${rtCount}`,
    `Status: \`${bot.status}\``,
  ].join('\n');
}
