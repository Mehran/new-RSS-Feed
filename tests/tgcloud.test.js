import { describe, it, expect, vi } from "vitest";
import {
  chunkLines,
  formatCheck,
  formatFeedList,
  parseCommand,
} from "../tgcloud/lib/format.js";
import { handleMessage } from "../tgcloud/lib/command.js";

function makeApi() {
  return { sendMessage: vi.fn(async () => ({ message_id: 1 })) };
}

function makeWorker(overrides = {}) {
  return {
    getAdmins: vi.fn(async () => [42]),
    listFeeds: vi.fn(async () => []),
    addFeed: vi.fn(async () => ({ title: "Test", url: "https://x.test/feed" })),
    removeFeed: vi.fn(async () => ({ title: "Test", url: "https://x.test/feed" })),
    check: vi.fn(async () => ({ feeds: 3, sent: 2, errors: 0 })),
    setAdmin: vi.fn(async () => [42, 99]),
    ...overrides,
  };
}

const message = (text, fromId = 42, extra = {}) => ({
  message_id: 1,
  chat: { id: 1000, type: "private" },
  from: { id: fromId, is_bot: false },
  text,
  ...extra,
});

describe("parseCommand", () => {
  it("parses a command and its arguments", () => {
    expect(parseCommand("/add https://example.com/feed")).toEqual({
      command: "add",
      args: "https://example.com/feed",
    });
  });

  it("strips a @botname suffix", () => {
    expect(parseCommand("/list@MyBot")).toEqual({ command: "list", args: "" });
  });

  it("ignores plain text", () => {
    expect(parseCommand("hello")).toEqual({ command: "", args: "" });
  });
});

describe("formatting", () => {
  it("chunks on line boundaries and respects the limit", () => {
    const lines = Array.from({ length: 10 }, () => "x".repeat(20));
    const chunks = chunkLines(lines, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(50);
    expect(chunks.join("\n")).toBe(lines.join("\n"));
  });

  it("escapes feed titles and URLs", () => {
    const [text] = formatFeedList([
      { title: "A & B", url: "https://x.test/?a=1&b=2", lastError: null },
    ]);
    expect(text).toContain("A &amp; B");
    expect(text).toContain("a=1&amp;b=2");
    expect(text).toContain("Active feeds (1)");
  });

  it("formats summaries and the pending case", () => {
    expect(formatCheck({ feeds: 3, sent: 2, errors: 1 })).toBe(
      "✅ Check complete: 3 feed(s), 2 new item(s) sent, 1 error(s).",
    );
    expect(formatCheck({ pending: true })).toMatch(/Check started/);
  });
});

describe("handleMessage", () => {
  it("answers /start without touching the Worker", async () => {
    const api = makeApi();
    const worker = makeWorker();
    await handleMessage(message("/start"), { api, worker });

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0][0]).toMatchObject({ chat_id: 1000 });
    expect(worker.getAdmins).not.toHaveBeenCalled();
  });

  it("denies a management command from a non-admin", async () => {
    const api = makeApi();
    const worker = makeWorker({ getAdmins: vi.fn(async () => [42]) });

    await handleMessage(message("/add https://x.test/feed", 7), { api, worker });

    expect(worker.addFeed).not.toHaveBeenCalled();
    expect(api.sendMessage.mock.calls[0][0].text).toMatch(/not authorized/);
  });

  it("adds a feed for an admin and lets the Worker send the confirmation", async () => {
    const api = makeApi();
    const worker = makeWorker();

    await handleMessage(message("/add https://x.test/feed"), { api, worker });

    expect(worker.addFeed).toHaveBeenCalledWith("https://x.test/feed", 1000);
    // The Worker sends the confirmation + preview, so the handler stays silent.
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("lists feeds in HTML", async () => {
    const api = makeApi();
    const worker = makeWorker({
      listFeeds: vi.fn(async () => [
        { title: "One", url: "https://one.test/feed", lastError: null },
        { title: "Two", url: "https://two.test/feed", lastError: "HTTP 500" },
      ]),
    });

    await handleMessage(message("/list"), { api, worker });

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const payload = api.sendMessage.mock.calls[0][0];
    expect(payload.parse_mode).toBe("HTML");
    expect(payload.text).toContain("1. <b>One</b>");
    expect(payload.text).toContain("⚠️ HTTP 500");
  });

  it("reports a check summary", async () => {
    const api = makeApi();
    const worker = makeWorker();

    await handleMessage(message("/check"), { api, worker });

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.sendMessage.mock.calls[0][0].text).toMatch(/Checking/);
    expect(api.sendMessage.mock.calls[1][0].text).toBe(
      "✅ Check complete: 3 feed(s), 2 new item(s) sent, 0 error(s).",
    );
  });

  it("adds an admin", async () => {
    const api = makeApi();
    const worker = makeWorker();

    await handleMessage(message("/admin 99"), { api, worker });

    expect(worker.setAdmin).toHaveBeenCalledWith(99, true);
    expect(api.sendMessage.mock.calls[0][0].text).toContain("99");
  });

  it("explains when an env-based bootstrap admin cannot be removed", async () => {
    const api = makeApi();
    const worker = makeWorker({ setAdmin: vi.fn(async () => [42]) });

    await handleMessage(message("/unadmin 42"), { api, worker });

    expect(worker.setAdmin).toHaveBeenCalledWith(42, false);
    expect(api.sendMessage.mock.calls[0][0].text).toContain("ADMIN_USER_ID");
  });

  it("removes a KV-managed admin normally", async () => {
    const api = makeApi();
    const worker = makeWorker({ setAdmin: vi.fn(async () => [42]) });

    await handleMessage(message("/unadmin 99"), { api, worker });

    expect(api.sendMessage.mock.calls[0][0].text).toContain("Removed admin");
  });

  it("ignores messages from other bots", async () => {
    const api = makeApi();
    const worker = makeWorker();

    await handleMessage(
      message("/check", 9000, { from: { id: 9000, is_bot: true } }),
      { api, worker },
    );

    expect(worker.getAdmins).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("surfaces Worker errors to the user", async () => {
    const api = makeApi();
    const worker = makeWorker({
      listFeeds: vi.fn(async () => {
        throw new Error("The feed engine is unavailable (HTTP 503).");
      }),
    });

    await handleMessage(message("/list"), { api, worker });

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0][0].text).toContain("unavailable");
  });
});
