import { beforeEach, describe, expect, it, vi } from "vitest";
import "./test-mocks.js";
import { fetchBlueBubblesHistory, fetchBlueBubblesHistoryForTarget } from "./history.js";
import { getCachedBlueBubblesPrivateApiStatus } from "./probe.js";
import { resolveChatGuidForTarget } from "./send.js";
import { installBlueBubblesFetchTestHooks } from "./test-harness.js";
import type { BlueBubblesSendTarget } from "./types.js";

vi.mock("./send.js", async () => {
  const actual = await vi.importActual<typeof import("./send.js")>("./send.js");
  return {
    ...actual,
    resolveChatGuidForTarget: vi.fn(),
  };
});

const mockFetch = vi.fn();
const privateApiStatusMock = vi.mocked(getCachedBlueBubblesPrivateApiStatus);

installBlueBubblesFetchTestHooks({
  mockFetch,
  privateApiStatusMock,
});

describe("history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes BlueBubbles history entries into chronological order", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            {
              guid: "msg-2",
              text: " second ",
              is_from_me: true,
              date_created: 1_710_000_200,
            },
            {
              guid: "msg-1",
              body: "first",
              sender: { display_name: "Jane Doe" },
              date_created: 1_710_000_100,
            },
          ],
        }),
    });

    const result = await fetchBlueBubblesHistory("iMessage;-;+15551234567", 10, {
      serverUrl: "http://localhost:1234",
      password: "test",
    });

    expect(result).toEqual({
      resolved: true,
      entries: [
        {
          sender: "Jane Doe",
          body: "first",
          timestamp: 1_710_000_100_000,
          messageId: "msg-1",
          fromMe: false,
        },
        {
          sender: "me",
          body: "second",
          timestamp: 1_710_000_200_000,
          messageId: "msg-2",
          fromMe: true,
        },
      ],
    });
  });

  it("maps targeted reads into message tool summaries", async () => {
    vi.mocked(resolveChatGuidForTarget).mockResolvedValueOnce("iMessage;-;+15551234567");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          messages: [
            {
              guid: "msg-1",
              text: "hello",
              sender: { display_name: "Jane Doe" },
              dateCreated: 1_710_000_100,
            },
          ],
        }),
    });

    const target: BlueBubblesSendTarget = {
      kind: "handle",
      address: "+15551234567",
      service: "auto",
    };
    const result = await fetchBlueBubblesHistoryForTarget({
      baseUrl: "http://localhost:1234",
      password: "test",
      target,
      limit: 5,
    });

    expect(resolveChatGuidForTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://localhost:1234",
        password: "test",
        target,
        throwOnQueryError: true,
      }),
    );
    expect(result).toEqual({
      chatGuid: "iMessage;-;+15551234567",
      target: "chat_guid:iMessage;-;+15551234567",
      messages: [
        {
          messageId: "msg-1",
          authorTag: "Jane Doe",
          text: "hello",
          fromMe: false,
          timestamp: new Date(1_710_000_100_000).toISOString(),
          timestampMs: 1_710_000_100_000,
        },
      ],
    });
  });

  it("throws when the target cannot be resolved", async () => {
    vi.mocked(resolveChatGuidForTarget).mockResolvedValueOnce(null);

    await expect(
      fetchBlueBubblesHistoryForTarget({
        baseUrl: "http://localhost:1234",
        password: "test",
        target: { kind: "chat_id", chatId: 999 },
      }),
    ).rejects.toThrow(/chat could not be resolved/i);
  });
});
