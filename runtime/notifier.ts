// Synapse Forge v0.4 — Human Notification
// Webhook + file. Email is Phase 2.

import path from 'node:path';
import type { Review, Notification, ForgeConfig } from './types.js';
import { safeWriteJSON, withMeta } from './utils.js';

export class Notifier {
  private config: ForgeConfig;

  constructor(config: ForgeConfig) {
    this.config = config;
  }

  /**
   * Notify the human that delivery is complete (or needs attention).
   */
  async notify(review: Review, outputPath: string): Promise<void> {
    const payload: Notification = {
      status: review.verdict,
      project: review.project,
      completed_at: new Date().toISOString(),
      tasks_completed: review.tasks_completed,
      tasks_failed: review.tasks_failed,
      output_path: outputPath,
      notes: review.notes,
    };

    const type = this.config.notification.type;

    // Try primary channel
    try {
      if (type === 'webhook') {
        await this.sendWebhook(payload);
        console.log(`[Notifier] Webhook sent to ${this.config.notification.url}`);
        return;
      }
    } catch (err: any) {
      console.warn(`[Notifier] ${type} failed: ${err.message}`);
      // Fall through to file fallback
    }

    // File notification (always works)
    this.writeFile(payload);
    console.log(`[Notifier] Notification written to ${this.config.synapse_dir}/notification.json`);
  }

  private async sendWebhook(payload: Notification): Promise<void> {
    const url = this.config.notification.url;
    if (!url) throw new Error('Webhook URL not configured');

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      throw new Error(`Webhook returned ${resp.status}: ${await resp.text()}`);
    }
  }

  private writeFile(payload: Notification): void {
    safeWriteJSON(
      path.join(this.config.synapse_dir, 'notification.json'),
      withMeta(payload as any, 'forge'),
    );
  }
}
