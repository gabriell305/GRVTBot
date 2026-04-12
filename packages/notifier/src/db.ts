// Read-only handle to the bot's SQLite database.
//
// Uses the `sqlite3` package (callback-based, but with prebuilt binaries on
// every common platform — better-sqlite3's node-gyp build chain is too
// fragile across the dev/CI/VPS matrix). All methods are wrapped in
// Promises so the worker loop reads naturally.
//
// We open with OPEN_READONLY so we physically cannot mutate the file the
// bot writes to.

import sqlite3 from 'sqlite3';
import { childLogger } from './logger.js';

const log = childLogger('db');

export interface BotRow {
  id: number;
  pair: string;
  status: 'running' | 'paused' | 'stopped' | 'error';
  direction: 'long' | 'short';
  leverage: number;
  investment_usdt: number;
  total_pnl_usdt: number;
  grid_profit_usdt: number;
  trend_pnl_usdt: number;
  avg_entry_price: number;
  liquidation_price: number;
  last_error?: string | null;
  // F.1: per-bot alert config (nullable — uses global defaults when null)
  alert_drawdown_pct?: number | null;
  alert_fill_batch?: number | null;
  alert_liq_proximity_pct?: number | null;
}

export interface RoundtripRow {
  id: number;
  buy_price: number;
  sell_price: number;
  size: number;
  profit: number;
  created_at: string;
}

export interface DailySnapshotRow {
  id: number;
  bot_id: number;
  date: string;
  equity: number;
  grid_profit_net: number;
  trend_pnl: number;
  total_pnl: number;
  round_trips: number;
}

export class NotifierDb {
  private db: sqlite3.Database;

  constructor(filePath: string) {
    log.info({ filePath }, 'opening database (readonly)');
    this.db = new sqlite3.Database(filePath, sqlite3.OPEN_READONLY);
  }

  private all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve((rows as T[]) ?? []);
      });
    });
  }

  private get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row as T | undefined);
      });
    });
  }

  /**
   * All bots, fresh on every poll. Cheap (single row in v0).
   */
  getAllBots(): Promise<BotRow[]> {
    return this.all<BotRow>(
      `SELECT id, pair, status, direction, leverage, investment_usdt,
              total_pnl_usdt, grid_profit_usdt, trend_pnl_usdt,
              avg_entry_price, liquidation_price,
              alert_drawdown_pct, alert_fill_batch, alert_liq_proximity_pct
       FROM grid_bots`
    );
  }

  /**
   * F.2: Get the latest fill price for a bot's instrument as a proxy
   * for mark price. The notifier is read-only on the DB and has no
   * GRVT API access, so the last fill is the best we have.
   */
  async getLastFillPrice(botId: number): Promise<number | null> {
    const row = await this.get<{ price: number }>(
      `SELECT price FROM fills_archive
       WHERE bot_id = ?
       ORDER BY event_time DESC
       LIMIT 1`,
      [botId]
    );
    return row?.price ?? null;
  }

  /**
   * Roundtrips with id > sinceId. Used to detect new fills/profits.
   */
  getRoundtripsSince(sinceId: number, limit: number = 100): Promise<RoundtripRow[]> {
    return this.all<RoundtripRow>(
      `SELECT id, buy_price, sell_price, size, profit, created_at
       FROM paired_roundtrips
       WHERE id > ?
       ORDER BY id ASC
       LIMIT ?`,
      [sinceId, limit]
    );
  }

  /**
   * Latest snapshot for the daily summary.
   */
  getLatestSnapshot(botId: number): Promise<DailySnapshotRow | undefined> {
    return this.get<DailySnapshotRow>(
      `SELECT id, bot_id, date, equity, grid_profit_net, trend_pnl,
              total_pnl, round_trips
       FROM daily_snapshots
       WHERE bot_id = ?
       ORDER BY date DESC
       LIMIT 1`,
      [botId]
    );
  }

  /**
   * Compute the current aggregate equity across all bots.
   * Equity = investment + total_pnl per bot, summed.
   */
  async getCurrentEquity(): Promise<number> {
    const row = await this.get<{ eq: number }>(
      `SELECT COALESCE(SUM(investment_usdt + total_pnl_usdt), 0) as eq
       FROM grid_bots`
    );
    return row?.eq ?? 0;
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
