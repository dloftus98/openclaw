import crypto from "node:crypto";
import { resolveBlueBubblesServerAccount } from "./account-resolve.js";
import {
  getCachedBlueBubblesPrivateApiStatus,
  isBlueBubblesPrivateApiStatusEnabled,
} from "./probe.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { stripMarkdown } from "./runtime-api.js";
import { warnBlueBubbles } from "./runtime.js";
import { extractBlueBubblesMessageId, resolveBlueBubblesSendTarget } from "./send-helpers.js";
import { extractHandleFromChatGuid, normalizeBlueBubblesHandle } from "./targets.js";
import {
  blueBubblesFetchWithTimeout,
  buildBlueBubblesApiUrl,
  type BlueBubblesSendTarget,
  type SsrFPolicy,
} from "./types.js";

function blueBubblesPolicy(allowPrivateNetwork: boolean | undefined): SsrFPolicy {
  return allowPrivateNetwork ? { allowPrivateNetwork: true } : {};
}

export type BlueBubblesSendOpts = {
  serverUrl?: string;
  password?: string;
  accountId?: string;
  timeoutMs?: number;
  cfg?: OpenClawConfig;
  /** Message GUID to reply to (reply threading) */
  replyToMessageGuid?: string;
  /** Part index for reply (default: 0) */
  replyToPartIndex?: number;
  /** Effect ID or short name for message effects (e.g., "slam", "balloons") */
  effectId?: string;
};

export type BlueBubblesSendResult = {
  messageId: string;
};

/** Maps short effect names to full Apple effect IDs */
const EFFECT_MAP: Record<string, string> = {
  // Bubble effects
  slam: "com.apple.MobileSMS.expressivesend.impact",
  loud: "com.apple.MobileSMS.expressivesend.loud",
  gentle: "com.apple.MobileSMS.expressivesend.gentle",
  invisible: "com.apple.MobileSMS.expressivesend.invisibleink",
  "invisible-ink": "com.apple.MobileSMS.expressivesend.invisibleink",
  "invisible ink": "com.apple.MobileSMS.expressivesend.invisibleink",
  invisibleink: "com.apple.MobileSMS.expressivesend.invisibleink",
  // Screen effects
  echo: "com.apple.messages.effect.CKEchoEffect",
  spotlight: "com.apple.messages.effect.CKSpotlightEffect",
  balloons: "com.apple.messages.effect.CKHappyBirthdayEffect",
  confetti: "com.apple.messages.effect.CKConfettiEffect",
  love: "com.apple.messages.effect.CKHeartEffect",
  heart: "com.apple.messages.effect.CKHeartEffect",
  hearts: "com.apple.messages.effect.CKHeartEffect",
  lasers: "com.apple.messages.effect.CKLasersEffect",
  fireworks: "com.apple.messages.effect.CKFireworksEffect",
  celebration: "com.apple.messages.effect.CKSparklesEffect",
};

function resolveEffectId(raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim().toLowerCase();
  if (EFFECT_MAP[trimmed]) {
    return EFFECT_MAP[trimmed];
  }
  const normalized = trimmed.replace(/[\s_]+/g, "-");
  if (EFFECT_MAP[normalized]) {
    return EFFECT_MAP[normalized];
  }
  const compact = trimmed.replace(/[\s_-]+/g, "");
  if (EFFECT_MAP[compact]) {
    return EFFECT_MAP[compact];
  }
  return raw;
}

type PrivateApiDecision = {
  canUsePrivateApi: boolean;
  throwEffectDisabledError: boolean;
  warningMessage?: string;
};

function resolvePrivateApiDecision(params: {
  privateApiStatus: boolean | null;
  wantsReplyThread: boolean;
  wantsEffect: boolean;
}): PrivateApiDecision {
  const { privateApiStatus, wantsReplyThread, wantsEffect } = params;
  const needsPrivateApi = wantsReplyThread || wantsEffect;
  const canUsePrivateApi =
    needsPrivateApi && isBlueBubblesPrivateApiStatusEnabled(privateApiStatus);
  const throwEffectDisabledError = wantsEffect && privateApiStatus === false;
  if (!needsPrivateApi || privateApiStatus !== null) {
    return { canUsePrivateApi, throwEffectDisabledError };
  }
  const requested = [
    wantsReplyThread ? "reply threading" : null,
    wantsEffect ? "message effects" : null,
  ]
    .filter(Boolean)
    .join(" + ");
  return {
    canUsePrivateApi,
    throwEffectDisabledError,
    warningMessage: `Private API status unknown; sending without ${requested}. Run a status probe to restore private-api features.`,
  };
}

async function parseBlueBubblesMessageResponse(res: Response): Promise<BlueBubblesSendResult> {
  const body = await res.text();
  if (!body) {
    return { messageId: "ok" };
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    return { messageId: extractBlueBubblesMessageId(parsed) };
  } catch {
    return { messageId: "ok" };
  }
}

export type BlueBubblesChatRecord = Record<string, unknown>;

export type BlueBubblesListedChat = {
  id: string;
  target: string;
  kind: "direct" | "group";
  name?: string;
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number;
  lastActivityAt?: string;
  lastActivityMs?: number;
  participants?: string[];
};

const DEFAULT_CHAT_LIST_LIMIT = 20;
const MAX_CHAT_LIST_LIMIT = 100;

function clampChatListLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_CHAT_LIST_LIMIT;
  }
  if (!Number.isFinite(limit)) {
    return DEFAULT_CHAT_LIST_LIMIT;
  }
  const normalized = Math.floor(limit);
  if (normalized <= 0) {
    return 0;
  }
  return Math.min(normalized, MAX_CHAT_LIST_LIMIT);
}

function isBlueBubblesChatGuid(value: string): boolean {
  const parts = value.split(";");
  if (parts.length !== 3) {
    return false;
  }
  const service = parts[0]?.trim();
  const separator = parts[1]?.trim();
  const identifier = parts[2]?.trim();
  return Boolean(service && identifier && (separator === "+" || separator === "-"));
}

function extractRawChatGuid(chat: BlueBubblesChatRecord): string | null {
  const candidates = [chat.chatGuid, chat.guid, chat.chat_guid];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed && isBlueBubblesChatGuid(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

function extractChatGuid(chat: BlueBubblesChatRecord): string | null {
  const candidates = [
    chat.chatGuid,
    chat.guid,
    chat.chat_guid,
    chat.identifier,
    chat.chatIdentifier,
    chat.chat_identifier,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function extractChatId(chat: BlueBubblesChatRecord): number | null {
  const candidates = [chat.chatId, chat.id, chat.chat_id];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return null;
}

function extractChatIdentifierFromChatGuid(chatGuid: string): string | null {
  const parts = chatGuid.split(";");
  if (parts.length < 3) {
    return null;
  }
  const identifier = parts[2]?.trim();
  return identifier ? identifier : null;
}

function extractParticipantAddresses(chat: BlueBubblesChatRecord): string[] {
  const raw =
    (Array.isArray(chat.participants) ? chat.participants : null) ??
    (Array.isArray(chat.handles) ? chat.handles : null) ??
    (Array.isArray(chat.participantHandles) ? chat.participantHandles : null);
  if (!raw) {
    return [];
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      out.push(entry);
      continue;
    }
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      const candidate =
        (typeof record.address === "string" && record.address) ||
        (typeof record.handle === "string" && record.handle) ||
        (typeof record.id === "string" && record.id) ||
        (typeof record.identifier === "string" && record.identifier);
      if (candidate) {
        out.push(candidate);
      }
    }
  }
  return out;
}

function extractParticipantLabels(chat: BlueBubblesChatRecord): string[] {
  const raw =
    (Array.isArray(chat.participants) ? chat.participants : null) ??
    (Array.isArray(chat.handles) ? chat.handles : null) ??
    (Array.isArray(chat.participantHandles) ? chat.participantHandles : null);
  if (!raw) {
    return [];
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (trimmed) {
        out.push(trimmed);
      }
      continue;
    }
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const candidate =
      (typeof record.displayName === "string" && record.displayName.trim()) ||
      (typeof record.display_name === "string" && record.display_name.trim()) ||
      (typeof record.name === "string" && record.name.trim()) ||
      (typeof record.address === "string" && record.address.trim()) ||
      (typeof record.handle === "string" && record.handle.trim()) ||
      (typeof record.id === "string" && record.id.trim()) ||
      (typeof record.identifier === "string" && record.identifier.trim());
    if (candidate) {
      out.push(candidate);
    }
  }
  return out;
}

function extractChatIdentifier(chat: BlueBubblesChatRecord): string | null {
  const direct =
    (typeof chat.identifier === "string" && chat.identifier.trim()) ||
    (typeof chat.chatIdentifier === "string" && chat.chatIdentifier.trim()) ||
    (typeof chat.chat_identifier === "string" && chat.chat_identifier.trim()) ||
    null;
  if (direct) {
    return direct;
  }
  const guid = extractRawChatGuid(chat);
  return guid ? extractChatIdentifierFromChatGuid(guid) : null;
}

function normalizeChatTimestampMs(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw < 1_000_000_000_000 ? Math.round(raw * 1000) : Math.round(raw);
  }
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    return parsed < 1_000_000_000_000 ? Math.round(parsed * 1000) : Math.round(parsed);
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

function extractChatLastActivityMs(chat: BlueBubblesChatRecord): number | null {
  const lastMessage =
    (chat.lastMessage && typeof chat.lastMessage === "object"
      ? (chat.lastMessage as Record<string, unknown>)
      : null) ??
    (chat.latestMessage && typeof chat.latestMessage === "object"
      ? (chat.latestMessage as Record<string, unknown>)
      : null) ??
    (chat.last_message && typeof chat.last_message === "object"
      ? (chat.last_message as Record<string, unknown>)
      : null) ??
    (chat.latest_message && typeof chat.latest_message === "object"
      ? (chat.latest_message as Record<string, unknown>)
      : null);

  const candidates: unknown[] = [
    chat.lastActivityAt,
    chat.lastActivity,
    chat.lastMessageAt,
    chat.lastMessageDate,
    chat.dateCreated,
    chat.date_created,
    chat.date,
    chat.timestamp,
    chat.time,
    lastMessage?.dateCreated,
    lastMessage?.date_created,
    lastMessage?.date,
    lastMessage?.timestamp,
    lastMessage?.dateDelivered,
    lastMessage?.date_delivered,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeChatTimestampMs(candidate);
    if (normalized != null) {
      return normalized;
    }
  }
  return null;
}

function extractChatName(chat: BlueBubblesChatRecord): string | null {
  const direct =
    (typeof chat.displayName === "string" && chat.displayName.trim()) ||
    (typeof chat.display_name === "string" && chat.display_name.trim()) ||
    (typeof chat.name === "string" && chat.name.trim()) ||
    (typeof chat.title === "string" && chat.title.trim()) ||
    null;
  if (direct) {
    return direct;
  }
  const labels = extractParticipantLabels(chat);
  if (labels.length > 0) {
    return labels.join(", ");
  }
  const guid = extractRawChatGuid(chat);
  if (guid) {
    const handle = extractHandleFromChatGuid(guid);
    if (handle) {
      return handle;
    }
  }
  return null;
}

function extractChatKind(chat: BlueBubblesChatRecord): "direct" | "group" {
  const guid = extractRawChatGuid(chat);
  if (guid?.includes(";+;")) {
    return "group";
  }
  if (guid?.includes(";-;")) {
    return "direct";
  }
  if (chat.isGroup === true || chat.is_group === true || chat.group === true) {
    return "group";
  }
  return extractParticipantAddresses(chat).length > 1 ? "group" : "direct";
}

async function queryChats(params: {
  baseUrl: string;
  password: string;
  timeoutMs?: number;
  offset: number;
  limit: number;
  allowPrivateNetwork?: boolean;
  throwOnHttpError?: boolean;
  errorContext?: string;
}): Promise<BlueBubblesChatRecord[]> {
  const url = buildBlueBubblesApiUrl({
    baseUrl: params.baseUrl,
    path: "/api/v1/chat/query",
    password: params.password,
  });
  const res = await blueBubblesFetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        limit: params.limit,
        offset: params.offset,
        with: ["participants"],
      }),
    },
    params.timeoutMs,
    blueBubblesPolicy(params.allowPrivateNetwork),
  );
  if (!res.ok) {
    if (params.throwOnHttpError) {
      const errorText = await res.text().catch(() => "");
      throw new Error(
        `BlueBubbles ${params.errorContext ?? "chat query"} failed (${res.status}): ${errorText || "unknown"}`,
      );
    }
    return [];
  }
  const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const data = payload && typeof payload.data !== "undefined" ? (payload.data as unknown) : null;
  if (Array.isArray(data)) {
    return data as BlueBubblesChatRecord[];
  }
  if (params.throwOnHttpError) {
    throw new Error("BlueBubbles chat query returned an unexpected response.");
  }
  return [];
}

function toBlueBubblesChatListing(chat: BlueBubblesChatRecord): BlueBubblesListedChat | null {
  const chatGuid = extractRawChatGuid(chat) ?? undefined;
  const chatIdentifier = extractChatIdentifier(chat) ?? undefined;
  const chatId = extractChatId(chat) ?? undefined;
  const kind = extractChatKind(chat);
  const target = chatGuid
    ? `chat_guid:${chatGuid}`
    : chatIdentifier
      ? `chat_identifier:${chatIdentifier}`
      : typeof chatId === "number"
        ? `chat_id:${chatId}`
        : null;
  if (!target) {
    return null;
  }
  const lastActivityMs = extractChatLastActivityMs(chat) ?? undefined;
  return {
    id: target,
    target,
    kind,
    name: extractChatName(chat) ?? undefined,
    chatGuid,
    chatIdentifier,
    chatId,
    lastActivityAt:
      typeof lastActivityMs === "number" ? new Date(lastActivityMs).toISOString() : undefined,
    lastActivityMs,
    participants: extractParticipantLabels(chat),
  };
}

export async function listBlueBubblesChats(params: {
  baseUrl: string;
  password: string;
  timeoutMs?: number;
  limit?: number;
  allowPrivateNetwork?: boolean;
}): Promise<BlueBubblesListedChat[]> {
  const effectiveLimit = clampChatListLimit(params.limit);
  if (effectiveLimit <= 0) {
    return [];
  }

  const pageSize = Math.min(Math.max(effectiveLimit, 50), 200);
  const seen = new Map<string, { chat: BlueBubblesListedChat; index: number }>();
  let index = 0;
  for (let offset = 0; offset < 5000 && seen.size < effectiveLimit; offset += pageSize) {
    const chats = await queryChats({
      baseUrl: params.baseUrl,
      password: params.password,
      timeoutMs: params.timeoutMs,
      offset,
      limit: pageSize,
      allowPrivateNetwork: params.allowPrivateNetwork,
      throwOnHttpError: true,
      errorContext: "channel-list",
    });
    if (chats.length === 0) {
      break;
    }
    for (const chat of chats) {
      const listing = toBlueBubblesChatListing(chat);
      if (!listing || seen.has(listing.id)) {
        continue;
      }
      seen.set(listing.id, { chat: listing, index });
      index += 1;
      if (seen.size >= effectiveLimit) {
        break;
      }
    }
    if (chats.length < pageSize) {
      break;
    }
  }

  return [...seen.values()]
    .sort((a, b) => {
      const aTime = a.chat.lastActivityMs ?? -1;
      const bTime = b.chat.lastActivityMs ?? -1;
      if (aTime !== bTime) {
        return bTime - aTime;
      }
      return a.index - b.index;
    })
    .slice(0, effectiveLimit)
    .map(({ chat }) => chat);
}

export async function resolveChatGuidForTarget(params: {
  baseUrl: string;
  password: string;
  timeoutMs?: number;
  target: BlueBubblesSendTarget;
  allowPrivateNetwork?: boolean;
  throwOnQueryError?: boolean;
}): Promise<string | null> {
  if (params.target.kind === "chat_guid") {
    return params.target.chatGuid;
  }

  const normalizedHandle =
    params.target.kind === "handle" ? normalizeBlueBubblesHandle(params.target.address) : "";
  const targetChatId = params.target.kind === "chat_id" ? params.target.chatId : null;
  const targetChatIdentifier =
    params.target.kind === "chat_identifier" ? params.target.chatIdentifier : null;

  const limit = 500;
  let participantMatch: string | null = null;
  for (let offset = 0; offset < 5000; offset += limit) {
    const chats = await queryChats({
      baseUrl: params.baseUrl,
      password: params.password,
      timeoutMs: params.timeoutMs,
      offset,
      limit,
      allowPrivateNetwork: params.allowPrivateNetwork,
      throwOnHttpError: params.throwOnQueryError,
      errorContext: "chat lookup",
    });
    if (chats.length === 0) {
      break;
    }
    for (const chat of chats) {
      if (targetChatId != null) {
        const chatId = extractChatId(chat);
        if (chatId != null && chatId === targetChatId) {
          return extractChatGuid(chat);
        }
      }
      if (targetChatIdentifier) {
        const guid = extractChatGuid(chat);
        if (guid) {
          // Back-compat: some callers might pass a full chat GUID.
          if (guid === targetChatIdentifier) {
            return guid;
          }

          // Primary match: BlueBubbles `chat_identifier:*` targets correspond to the
          // third component of the chat GUID: `service;(+|-) ;identifier`.
          const guidIdentifier = extractChatIdentifierFromChatGuid(guid);
          if (guidIdentifier && guidIdentifier === targetChatIdentifier) {
            return guid;
          }
        }

        const identifier =
          typeof chat.identifier === "string"
            ? chat.identifier
            : typeof chat.chatIdentifier === "string"
              ? chat.chatIdentifier
              : typeof chat.chat_identifier === "string"
                ? chat.chat_identifier
                : "";
        if (identifier && identifier === targetChatIdentifier) {
          return guid ?? extractChatGuid(chat);
        }
      }
      if (normalizedHandle) {
        const guid = extractChatGuid(chat);
        const directHandle = guid ? extractHandleFromChatGuid(guid) : null;
        if (directHandle && directHandle === normalizedHandle) {
          return guid;
        }
        if (!participantMatch && guid) {
          // Only consider DM chats (`;-;` separator) as participant matches.
          // Group chats (`;+;` separator) should never match when searching by handle/phone.
          // This prevents routing "send to +1234567890" to a group chat that contains that number.
          const isDmChat = guid.includes(";-;");
          if (isDmChat) {
            const participants = extractParticipantAddresses(chat).map((entry) =>
              normalizeBlueBubblesHandle(entry),
            );
            if (participants.includes(normalizedHandle)) {
              participantMatch = guid;
            }
          }
        }
      }
    }
  }
  return participantMatch;
}

/**
 * Creates a new DM chat for the given address and returns the chat GUID.
 * Requires Private API to be enabled in BlueBubbles.
 *
 * If a `message` is provided it is sent as the initial message in the new chat;
 * otherwise an empty-string message body is used (BlueBubbles still creates the
 * chat but will not deliver a visible bubble).
 */
export async function createChatForHandle(params: {
  baseUrl: string;
  password: string;
  address: string;
  message?: string;
  timeoutMs?: number;
  allowPrivateNetwork?: boolean;
}): Promise<{ chatGuid: string | null; messageId: string }> {
  const url = buildBlueBubblesApiUrl({
    baseUrl: params.baseUrl,
    path: "/api/v1/chat/new",
    password: params.password,
  });
  const payload = {
    addresses: [params.address],
    message: params.message ?? "",
    tempGuid: `temp-${crypto.randomUUID()}`,
  };
  const res = await blueBubblesFetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    params.timeoutMs,
    blueBubblesPolicy(params.allowPrivateNetwork),
  );
  if (!res.ok) {
    const errorText = await res.text();
    if (
      res.status === 400 ||
      res.status === 403 ||
      errorText.toLowerCase().includes("private api")
    ) {
      throw new Error(
        `BlueBubbles send failed: Cannot create new chat - Private API must be enabled. Original error: ${errorText || res.status}`,
      );
    }
    throw new Error(`BlueBubbles create chat failed (${res.status}): ${errorText || "unknown"}`);
  }
  const body = await res.text();
  let messageId = "ok";
  let chatGuid: string | null = null;
  if (body) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      messageId = extractBlueBubblesMessageId(parsed);
      // Extract chatGuid from the response data
      const data = parsed.data as Record<string, unknown> | undefined;
      if (data) {
        chatGuid =
          (typeof data.chatGuid === "string" && data.chatGuid) ||
          (typeof data.guid === "string" && data.guid) ||
          null;
        // Also try nested chats array (some BB versions nest it)
        if (!chatGuid) {
          const chats = data.chats ?? data.chat;
          if (Array.isArray(chats) && chats.length > 0) {
            const first = chats[0] as Record<string, unknown> | undefined;
            chatGuid =
              (typeof first?.guid === "string" && first.guid) ||
              (typeof first?.chatGuid === "string" && first.chatGuid) ||
              null;
          } else if (chats && typeof chats === "object" && !Array.isArray(chats)) {
            const chatObj = chats as Record<string, unknown>;
            chatGuid =
              (typeof chatObj.guid === "string" && chatObj.guid) ||
              (typeof chatObj.chatGuid === "string" && chatObj.chatGuid) ||
              null;
          }
        }
      }
    } catch {
      // ignore parse errors
    }
  }
  return { chatGuid, messageId };
}

/**
 * Creates a new chat (DM) and sends an initial message.
 * Requires Private API to be enabled in BlueBubbles.
 */
async function createNewChatWithMessage(params: {
  baseUrl: string;
  password: string;
  address: string;
  message: string;
  timeoutMs?: number;
  allowPrivateNetwork?: boolean;
}): Promise<BlueBubblesSendResult> {
  const result = await createChatForHandle({
    baseUrl: params.baseUrl,
    password: params.password,
    address: params.address,
    message: params.message,
    timeoutMs: params.timeoutMs,
    allowPrivateNetwork: params.allowPrivateNetwork,
  });
  return { messageId: result.messageId };
}

export async function sendMessageBlueBubbles(
  to: string,
  text: string,
  opts: BlueBubblesSendOpts = {},
): Promise<BlueBubblesSendResult> {
  const trimmedText = text ?? "";
  if (!trimmedText.trim()) {
    throw new Error("BlueBubbles send requires text");
  }
  // Strip markdown early and validate - ensures messages like "***" or "---" don't become empty
  const strippedText = stripMarkdown(trimmedText);
  if (!strippedText.trim()) {
    throw new Error("BlueBubbles send requires text (message was empty after markdown removal)");
  }

  const { baseUrl, password, accountId, allowPrivateNetwork } = resolveBlueBubblesServerAccount({
    cfg: opts.cfg ?? {},
    accountId: opts.accountId,
    serverUrl: opts.serverUrl,
    password: opts.password,
  });
  const privateApiStatus = getCachedBlueBubblesPrivateApiStatus(accountId);

  const target = resolveBlueBubblesSendTarget(to);
  const chatGuid = await resolveChatGuidForTarget({
    baseUrl,
    password,
    timeoutMs: opts.timeoutMs,
    target,
    allowPrivateNetwork,
  });
  if (!chatGuid) {
    // If target is a phone number/handle and no existing chat found,
    // auto-create a new DM chat using the /api/v1/chat/new endpoint
    if (target.kind === "handle") {
      return createNewChatWithMessage({
        baseUrl,
        password,
        address: target.address,
        message: strippedText,
        timeoutMs: opts.timeoutMs,
        allowPrivateNetwork,
      });
    }
    throw new Error(
      "BlueBubbles send failed: chatGuid not found for target. Use a chat_guid target or ensure the chat exists.",
    );
  }
  const effectId = resolveEffectId(opts.effectId);
  const wantsReplyThread = Boolean(opts.replyToMessageGuid?.trim());
  const wantsEffect = Boolean(effectId);
  const privateApiDecision = resolvePrivateApiDecision({
    privateApiStatus,
    wantsReplyThread,
    wantsEffect,
  });
  if (privateApiDecision.throwEffectDisabledError) {
    throw new Error(
      "BlueBubbles send failed: reply/effect requires Private API, but it is disabled on the BlueBubbles server.",
    );
  }
  if (privateApiDecision.warningMessage) {
    warnBlueBubbles(privateApiDecision.warningMessage);
  }
  const payload: Record<string, unknown> = {
    chatGuid,
    tempGuid: crypto.randomUUID(),
    message: strippedText,
  };
  if (privateApiDecision.canUsePrivateApi) {
    payload.method = "private-api";
  }

  // Add reply threading support
  if (wantsReplyThread && privateApiDecision.canUsePrivateApi) {
    payload.selectedMessageGuid = opts.replyToMessageGuid;
    payload.partIndex = typeof opts.replyToPartIndex === "number" ? opts.replyToPartIndex : 0;
  }

  // Add message effects support
  if (effectId && privateApiDecision.canUsePrivateApi) {
    payload.effectId = effectId;
  }

  const url = buildBlueBubblesApiUrl({
    baseUrl,
    path: "/api/v1/message/text",
    password,
  });
  const res = await blueBubblesFetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    opts.timeoutMs,
    blueBubblesPolicy(allowPrivateNetwork),
  );
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`BlueBubbles send failed (${res.status}): ${errorText || "unknown"}`);
  }
  return parseBlueBubblesMessageResponse(res);
}
