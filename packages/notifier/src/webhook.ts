// F.3 — Generic webhook sink. POSTs alert events as JSON to a
// user-configured URL. Enables Discord, Slack, PagerDuty, or any
// custom integration without code changes. Falls back to dry-run
// (logging) when WEBHOOK_URL is not set.

import { request } from 'undici';
import { childLogger } from './logger.js';

const log = childLogger('webhook');

export class WebhookClient {
  private readonly enabled: boolean;
  private readonly url: string | null;
  private readonly secret: string | null;

  constructor(url: string | undefined, secret?: string) {
    if (url) {
      this.enabled = true;
      this.url = url;
      this.secret = secret ?? null;
      log.info({ url: url.replace(/\/[^/]*$/, '/***') }, 'webhook enabled');
    } else {
      this.enabled = false;
      this.url = null;
      this.secret = null;
    }
  }

  /**
   * POST an alert event. The payload shape is stable so downstream
   * consumers (Discord bots, Slack apps, etc.) can parse reliably.
   */
  async send(event: {
    type: string;
    botId?: number;
    pair?: string;
    message: string;
    data?: Record<string, unknown>;
  }): Promise<void> {
    if (!this.enabled || !this.url) {
      log.debug({ event: event.type }, '[webhook dry-run] would send');
      return;
    }

    const body = JSON.stringify({
      ...event,
      ts: Date.now(),
    });

    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (this.secret) {
        headers['x-webhook-secret'] = this.secret;
      }

      const res = await request(this.url, {
        method: 'POST',
        headers,
        body,
        headersTimeout: 10_000,
        bodyTimeout: 10_000,
      });

      if (res.statusCode >= 300) {
        const resBody = await res.body.text();
        log.warn({ status: res.statusCode, body: resBody }, 'webhook send failed');
      } else {
        await res.body.dump();
      }
    } catch (err) {
      log.error({ err: (err as Error).message }, 'webhook request errored');
    }
  }
}
