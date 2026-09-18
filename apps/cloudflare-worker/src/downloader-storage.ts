/**
 * Composition-root storage adapter for the downloader Mini App.
 *
 * The app handler receives these fixed operations, never a D1 database or an
 * R2 bucket. This keeps future Mini Apps from reaching downloader tables or
 * objects by accidentally retaining a broad Worker environment reference.
 */

import {
  deleteTerminalJobForUser,
  getJobByIdForUser,
  listJobsForUser,
  listTerminalJobsForUser,
} from "./db";
import { getUserActivityStats, type UserActivityStats } from "./stats";
import { validateR2ObjectKey } from "./r2";
import type {
  ActivityWindow,
  D1DatabaseLike,
  HistoryJobRecord,
  JobHistoryListOptions,
  JobHistoryPage,
  R2BucketLike,
} from "./types";

export interface DownloaderMiniAppStorage {
  getActivityStats(window: ActivityWindow): Promise<UserActivityStats>;
  listHistory(options?: JobHistoryListOptions): Promise<JobHistoryPage>;
  listTerminalHistory(options?: JobHistoryListOptions): Promise<JobHistoryPage>;
  getHistoryItem(jobId: string): Promise<HistoryJobRecord | null>;
  deleteHistoryItem(jobId: string): Promise<boolean>;
  deleteHistoryMediaObject(jobId: string, objectKey: string): Promise<"deleted" | "invalid" | "unavailable">;
}

/** Build a fixed downloader storage surface bound to one authorized owner. */
export function createDownloaderMiniAppStorage(
  db: D1DatabaseLike,
  mediaBucket: R2BucketLike | undefined,
  userId: string,
): DownloaderMiniAppStorage {
  return Object.freeze({
    getActivityStats: (window: ActivityWindow) => getUserActivityStats(db, userId, window),
    listHistory: (options?: JobHistoryListOptions) => listJobsForUser(db, userId, options),
    listTerminalHistory: (options?: JobHistoryListOptions) => listTerminalJobsForUser(db, userId, options),
    getHistoryItem: (jobId: string) => getJobByIdForUser(db, jobId, userId),
    deleteHistoryItem: (jobId: string) => deleteTerminalJobForUser(db, jobId, userId),
    deleteHistoryMediaObject: async (jobId: string, objectKey: string): Promise<"deleted" | "invalid" | "unavailable"> => {
      if (!validateR2ObjectKey(objectKey, jobId)) return "invalid";
      if (!mediaBucket) return "unavailable";
      try {
        await mediaBucket.delete(objectKey);
        return "deleted";
      } catch {
        return "unavailable";
      }
    },
  });
}
