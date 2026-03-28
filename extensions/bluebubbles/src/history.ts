import { resolveBlueBubblesServerAccount } from "./account-resolve.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { resolveChatGuidForTarget } from "./send.js";
import type { BlueBubblesSendTarget } from "./types.js";
import { blueBubblesFetchWithTimeout, buildBlueBubblesApiUrl } from "./types.js";

export type BlueBubblesHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  messageId?: string;
  fromMe?: boolean;
};

export type BlueBubblesHistoryFetchResult = {
  entries: BlueBubblesHistoryEntry[];
  /**
   * True when at least one API path returned a recognized response shape.
   * False means all attempts failed or returned unusable data.
   */
  resolved: boolean;
  error?: string;
};

export type BlueBubblesMessageData = {
  guid?: string;
  messageId?: string;
  text?: string;
  body?: string;
  subject?: string;
  handle_id?: string;
  handleId?: string;
  is_from_me?: boolean;
  isFromMe?: boolean;
  date_created?: number;
  dateCreated?: number;
  date_delivered?: number;
  dateDelivered?: number;
  date?: number;
  timestamp?: number;
  associated_message_guid?: string;
  sender?: {
    address?: string;
    displayName?: string;
    display_name?: string;
  };
};

export type BlueBubblesChatOpts = {
  serverUrl?: string;
  password?: string;
  accountId?: string;
  timeoutMs?: number;
  cfg?: OpenClawConfig;
  allowPrivateNetwork?: boolean;
};

function resolveAccount(params: BlueBubblesChatOpts) {
  return resolveBlueBubblesServerAccount(params);
}

const MAX_HISTORY_FETCH_LIMIT = 100;
const HISTORY_SCAN_MULTIPLIER = 8;
const MAX_HISTORY_SCAN_MESSAGES = 500;
const MAX_HISTORY_BODY_CHARS = 2_000;

function clampHistoryLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return 0;
  }
  const normalized = Math.floor(limit);
  if (normalized <= 0) {
    return 0;
  }
  return Math.min(normalized, MAX_HISTORY_FETCH_LIMIT);
}

function truncateHistoryBody(text: string): string {
  if (text.length <= MAX_HISTORY_BODY_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_HISTORY_BODY_CHARS).trimEnd()}...`;
}

function normalizeHistoryTimestampMs(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 1_000_000_000_000 ? Math.round(raw) : Math.round(raw * 1000);
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      return undefined;
    }
    return parsed > 1_000_000_000_000 ? Math.round(parsed) : Math.round(parsed * 1000);
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function readHistoryMessageBody(message: BlueBubblesMessageData): string {
  const candidates = [message.text, message.body, message.subject];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return "";
}

function readHistoryMessageId(message: BlueBubblesMessageData): string | undefined {
  const candidates = [message.guid, message.messageId];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function readHistorySender(message: BlueBubblesMessageData, fromMe: boolean): string {
  if (fromMe) {
    return "me";
  }
  return (
    message.sender?.displayName ||
    message.sender?.display_name ||
    message.sender?.address ||
    message.handleId ||
    message.handle_id ||
    "Unknown"
  );
}

function formatHistoryTimestamp(timestampMs: number | undefined): {
  timestamp?: string;
  timestampMs?: number;
} {
  if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) {
    return {};
  }
  return {
    timestamp: new Date(timestampMs).toISOString(),
    timestampMs,
  };
}

export type BlueBubblesReadMessage = {
  messageId?: string;
  authorTag: string;
  fromMe?: boolean;
  text: string;
  timestamp?: string;
  timestampMs?: number;
};

export type BlueBubblesTargetHistoryResult = {
  chatGuid: string;
  target: string;
  messages: BlueBubblesReadMessage[];
};

/**
 * Fetch message history from BlueBubbles API for a specific chat.
 * This provides the initial backfill for both group chats and DMs.
 */
export async function fetchBlueBubblesHistory(
  chatIdentifier: string,
  limit: number,
  opts: BlueBubblesChatOpts = {},
): Promise<BlueBubblesHistoryFetchResult> {
  const effectiveLimit = clampHistoryLimit(limit);
  if (!chatIdentifier.trim() || effectiveLimit <= 0) {
    return { entries: [], resolved: true };
  }

  let baseUrl: string;
  let password: string;
  let allowPrivateNetwork = false;
  try {
    ({ baseUrl, password, allowPrivateNetwork } = resolveAccount(opts));
  } catch (error) {
    return {
      entries: [],
      resolved: false,
      error:
        error instanceof Error ? error.message : "BlueBubbles history account resolution failed.",
    };
  }
  if (typeof opts.allowPrivateNetwork === "boolean") {
    allowPrivateNetwork = opts.allowPrivateNetwork;
  }
  const ssrfPolicy = allowPrivateNetwork ? { allowPrivateNetwork: true } : {};
  let lastError: string | undefined;

  // Try different common API patterns for fetching messages
  const possiblePaths = [
    `/api/v1/chat/${encodeURIComponent(chatIdentifier)}/messages?limit=${effectiveLimit}&sort=DESC`,
    `/api/v1/messages?chatGuid=${encodeURIComponent(chatIdentifier)}&limit=${effectiveLimit}`,
    `/api/v1/chat/${encodeURIComponent(chatIdentifier)}/message?limit=${effectiveLimit}`,
  ];

  for (const path of possiblePaths) {
    try {
      const url = buildBlueBubblesApiUrl({ baseUrl, path, password });
      const res = await blueBubblesFetchWithTimeout(
        url,
        { method: "GET" },
        opts.timeoutMs ?? 10000,
        ssrfPolicy,
      );

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        lastError = `BlueBubbles history fetch failed (${res.status}) on ${path}: ${errorText || "unknown"}`;
        continue; // Try next path
      }

      const data = await res.json().catch(() => null);
      if (!data) {
        lastError = `BlueBubbles history fetch returned invalid JSON for ${path}.`;
        continue;
      }

      // Handle different response structures
      let messages: unknown[] = [];
      if (Array.isArray(data)) {
        messages = data;
      } else if (data.data && Array.isArray(data.data)) {
        messages = data.data;
      } else if (data.messages && Array.isArray(data.messages)) {
        messages = data.messages;
      } else {
        lastError = `BlueBubbles history fetch returned an unexpected payload for ${path}.`;
        continue;
      }

      const historyEntries: BlueBubblesHistoryEntry[] = [];

      const maxScannedMessages = Math.min(
        Math.max(effectiveLimit * HISTORY_SCAN_MULTIPLIER, effectiveLimit),
        MAX_HISTORY_SCAN_MESSAGES,
      );
      for (let i = 0; i < messages.length && i < maxScannedMessages; i++) {
        const item = messages[i];
        const msg = item as BlueBubblesMessageData;

        // Skip messages without text content
        const text = readHistoryMessageBody(msg);
        if (!text) {
          continue;
        }

        const fromMe = msg.is_from_me === true || msg.isFromMe === true;
        const sender = readHistorySender(msg, fromMe);
        const timestamp =
          normalizeHistoryTimestampMs(msg.date_created) ??
          normalizeHistoryTimestampMs(msg.dateCreated) ??
          normalizeHistoryTimestampMs(msg.date) ??
          normalizeHistoryTimestampMs(msg.timestamp) ??
          normalizeHistoryTimestampMs(msg.date_delivered) ??
          normalizeHistoryTimestampMs(msg.dateDelivered);

        historyEntries.push({
          sender,
          body: truncateHistoryBody(text),
          timestamp,
          messageId: readHistoryMessageId(msg),
          fromMe,
        });
      }

      // Sort by timestamp (oldest first for context)
      historyEntries.sort((a, b) => {
        const aTime = a.timestamp || 0;
        const bTime = b.timestamp || 0;
        return aTime - bTime;
      });

      return {
        entries: historyEntries.slice(0, effectiveLimit), // Ensure we don't exceed the requested limit
        resolved: true,
      };
    } catch (error) {
      // Continue to next path
      lastError = error instanceof Error ? error.message : "BlueBubbles history fetch failed.";
      continue;
    }
  }

  // If none of the API paths worked, return empty history
  return {
    entries: [],
    resolved: false,
    error: lastError ?? "BlueBubbles history fetch failed for every known endpoint.",
  };
}

export async function fetchBlueBubblesHistoryForTarget(params: {
  baseUrl: string;
  password: string;
  target: BlueBubblesSendTarget;
  limit?: number;
  timeoutMs?: number;
  allowPrivateNetwork?: boolean;
}): Promise<BlueBubblesTargetHistoryResult> {
  const chatGuid = await resolveChatGuidForTarget({
    baseUrl: params.baseUrl,
    password: params.password,
    timeoutMs: params.timeoutMs,
    target: params.target,
    allowPrivateNetwork: params.allowPrivateNetwork,
    throwOnQueryError: true,
  });
  if (!chatGuid) {
    throw new Error("BlueBubbles read failed: chat could not be resolved for the provided target.");
  }

  const effectiveLimit = params.limit ?? 20;
  const result = await fetchBlueBubblesHistory(chatGuid, effectiveLimit, {
    serverUrl: params.baseUrl,
    password: params.password,
    timeoutMs: params.timeoutMs,
    allowPrivateNetwork: params.allowPrivateNetwork,
  });
  if (!result.resolved) {
    throw new Error(result.error ?? "BlueBubbles read failed: unable to fetch chat history.");
  }

  return {
    chatGuid,
    target: `chat_guid:${chatGuid}`,
    messages: result.entries.map((entry) => ({
      messageId: entry.messageId,
      authorTag: entry.sender,
      fromMe: entry.fromMe,
      text: entry.body,
      ...formatHistoryTimestamp(entry.timestamp),
    })),
  };
}
