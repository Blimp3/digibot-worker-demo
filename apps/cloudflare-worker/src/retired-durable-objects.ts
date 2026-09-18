import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

/**
 * Compatibility shell for the previously provisioned Durable Object class.
 *
 * It has no binding, routes, network access, D1 access, or rescheduling path.
 * Keeping the historical class export lets a queued alarm drain without
 * irreversibly deleting the namespace and its stored state during the
 * download-only rollout.
 */
export class NewsScheduler extends DurableObject<Env> {
  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
  }
}
