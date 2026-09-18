import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  confirmedDeliveryMessageIds,
  positiveTelegramMessageId,
  telegramMessageIds,
} from "../src/db";
import { isValidTrimRange, parseTrimTiming } from "../src/trim";
import type { JobDeliveryRecord, JobRecord } from "../src/types";

const fixtureText = readFileSync(new URL("./fixtures/integration-envelope-v1.json", import.meta.url), "utf8");

type Receipt = {
  botId: string;
  chatId: string;
  messageId: string;
  fileId: string;
};

type ArchiveError = {
  code: string;
  message: string;
  retryable: boolean;
};

type Archive = {
  deliveryState: string;
  documentReceipt: Receipt | null;
  integrityState: string;
  roundTripSha256: string | null;
  error: ArchiveError | null;
  retryReady: boolean;
};

type IntegrationEnvelopeFixture = {
  version: number;
  operationId: string;
  action: string;
  accountId: string;
  requestedAt: string;
  forceRecheck: boolean;
  media: {
    mediaSha256: string;
    byteLength: number;
    mimeType: string;
    inputKind: string;
    audioDurationSeconds: number | null;
    segment: { startSeconds: number; endSeconds: number } | null;
    fullSourceSha256: string | null;
  };
  result: {
    resultRef: string;
    accountId: string;
    mediaSha256: string;
    verificationPolicyVersion: string;
    resultSchemaVersion: number;
    originallyCheckedAt: string;
    cacheSource: string;
    evidence: { requestId: string };
  };
  archive: Archive;
  historySync: {
    state: string;
    historyId: string | null;
    error: ArchiveError | null;
  };
};

const fixture = JSON.parse(fixtureText) as IntegrationEnvelopeFixture;
const fixtureSha256 = "df1145520283e067c1d35262cdd95202fc2e1be5b5290af0519dac197f46159c";

function deliveryFromArchive(archive: Archive): Pick<
  JobDeliveryRecord,
  "state" | "method" | "telegram_message_id" | "telegram_message_ids"
> {
  return {
    state: archive.deliveryState as JobDeliveryRecord["state"],
    method: archive.documentReceipt ? "telegram" : null,
    telegram_message_id: archive.documentReceipt?.messageId ?? null,
    telegram_message_ids: null,
  };
}

function scalarJob(): Pick<JobRecord, "requested_clip_ranges"> {
  return { requested_clip_ranges: null };
}

describe("INTEGRATION-001 DigiBot adapter fixture", () => {
  it("pins the shared bytes and projects a confirmed image receipt", () => {
    expect(createHash("sha256").update(fixtureText).digest("hex")).toBe(fixtureSha256);
    expect(fixture.version).toBe(1);
    expect(fixture.action).toBe("check");
    expect(fixture.operationId).toBe("11111111-1111-4111-8111-111111111111");
    expect(fixture.requestedAt).toBe("2026-09-16T09:59:00.000Z");
    expect(fixture.forceRecheck).toBe(false);
    expect(fixture.accountId).toBe(fixture.result.accountId);
    expect(fixture.media.inputKind).toBe("original");
    expect(fixture.media.segment).toBeNull();
    expect(fixture.media.mediaSha256).toBe(fixture.result.mediaSha256);
    expect(fixture.media.mediaSha256).toBe(fixture.archive.roundTripSha256);
    expect(fixture.result.resultRef).toBe("result-fixture-1");
    expect(fixture.result.verificationPolicyVersion).toBe("content-provenance-c2pa-6273cdcb4f27-v2");
    expect(fixture.result.resultSchemaVersion).toBe(2);
    expect(fixture.result.cacheSource).toBe("fresh");
    expect(fixture.result.evidence.requestId).toBe("22222222-2222-4222-8222-222222222222");
    expect(fixture.archive.deliveryState).toBe("confirmed");
    expect(fixture.archive.integrityState).toBe("verified");
    expect(fixture.historySync.state).toBe("synced");

    const receipt = fixture.archive.documentReceipt;
    expect(receipt).not.toBeNull();
    expect(receipt?.botId).toBe("123456789");
    expect(receipt?.chatId).toBe("987654321");
    expect(positiveTelegramMessageId(receipt?.messageId)).toBe("101");
    expect(confirmedDeliveryMessageIds(deliveryFromArchive(fixture.archive), scalarJob())).toEqual([]);
  });

  it("rejects malformed and unknown receipts without asserting retry safety", () => {
    const receipt = fixture.archive.documentReceipt;
    expect(receipt).not.toBeNull();

    const malformed = {
      ...fixture.archive,
      documentReceipt: receipt ? { ...receipt, messageId: "0" } : null,
    };
    expect(confirmedDeliveryMessageIds(deliveryFromArchive(malformed), scalarJob())).toBeNull();

    const unknown = { ...fixture.archive, deliveryState: "unknown", retryReady: false };
    // Existing DigiBot state helpers establish confirmation only; the shared contract owns retry policy.
    expect(confirmedDeliveryMessageIds(deliveryFromArchive(unknown), scalarJob())).toBeNull();
    expect(unknown.retryReady).toBe(false);

    const clipJob: Pick<JobRecord, "requested_clip_ranges"> = {
      requested_clip_ranges: JSON.stringify([
        { startSeconds: 0, endSeconds: 10 },
        { startSeconds: 20, endSeconds: 30 },
      ]),
    };
    const clipReceipt = {
      ...deliveryFromArchive(fixture.archive),
      telegram_message_ids: JSON.stringify(["101", "102"]),
    };
    expect(confirmedDeliveryMessageIds(clipReceipt, clipJob)).toEqual(["101", "102"]);
    expect(telegramMessageIds(["101", "101"], 2, "101")).toBeNull();
  });

  it("maps segment scope to the existing trim helpers", () => {
    const parsed = parseTrimTiming("from 00:10 to 00:40");
    expect(parsed).toEqual({ ok: true, range: { startSeconds: 10, endSeconds: 40 } });
    if (!parsed.ok) throw new Error(parsed.message);

    const processingMedia = {
      ...fixture.media,
      mediaSha256: "b".repeat(64),
      mimeType: "audio/mpeg",
      byteLength: 4_194_304,
      inputKind: "derived_audio_segment",
      audioDurationSeconds: 30,
      segment: parsed.range,
      fullSourceSha256: "c".repeat(64),
    };
    expect(fixture.action).not.toBe("download");
    expect(isValidTrimRange(processingMedia.segment.startSeconds, processingMedia.segment.endSeconds)).toBe(true);
    expect(isValidTrimRange(40, 40)).toBe(false);
    expect(isValidTrimRange(40, 10)).toBe(false);
    // Synthetic fixture values exercise field separation; no media bytes are hashed here.
    expect(processingMedia.fullSourceSha256).not.toBe(processingMedia.mediaSha256);
  });
});
