const POSITIVE_TELEGRAM_USER_ID = /^[1-9]\d{0,19}$/u;

export const REQUIRED_TELEGRAM_USER_ID_COUNT = 2 as const;

function parsePositiveTelegramUserId(value: string): string | null {
  if (!POSITIVE_TELEGRAM_USER_ID.test(value)) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 && String(numeric) === value ? value : null;
}

/**
 * Parse the shared secret serialization without partially accepting a bad
 * configuration. Commas and whitespace are retained for compatibility with
 * the existing production format; exactly two distinct positive safe
 * integers are required.
 */
export function parseAllowedTelegramUserIds(value: string | undefined): ReadonlySet<string> | null {
  if (typeof value !== "string") return null;
  const serialized = value.trim();
  if (!serialized) return null;

  const tokens = serialized.split(/(?:\s*,\s*|\s+)/u);
  if (tokens.length !== REQUIRED_TELEGRAM_USER_ID_COUNT) return null;
  const parsed = tokens.map(parsePositiveTelegramUserId);
  const ids = parsed.filter((id): id is string => id !== null);
  if (ids.length !== REQUIRED_TELEGRAM_USER_ID_COUNT) return null;
  const uniqueIds = new Set(ids);
  return uniqueIds.size === REQUIRED_TELEGRAM_USER_ID_COUNT ? uniqueIds : null;
}
