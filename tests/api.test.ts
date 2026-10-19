import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";

const SECRET = "test-secret";

const FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Test Feed</title>
  <item>
    <title>Newest &amp; best</title>
    <link>https://example.com/2</link>
    <guid>https://example.com/2</guid>
    <pubDate>Tue, 02 Jan 2024 10:00:00 GMT</pubDate>
    <description><![CDATA[<p>Second body.</p>]]></description>
  </item>
  <item>
    <title>Older</title>
    <link>https://example.com/1</link>
    <guid>https://example.com/1</guid>
    <pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate>
    <description><![CDATA[<p>First body.</p>]]></description>
  </item>
</channel></rss>`;

function makeKv() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      return {
        keys: [...store.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((name) => ({ name })),
        list_complete: true,
        cursor: "",
      };
    },
  };
}

function makeEnv() {
  const feeds = makeKv();
  const seen = makeKv();
  const settings = makeKv();
  return {
    env: {
      RSS_FEEDS: feeds,
      RSS_SEEN: seen,
      RSS_SETTINGS: settings,
      TELEGRAM_BOT_TOKEN: "TOKEN",
      ADMIN_USER_ID: "111",
      COMMAND_API_SECRET: SECRET,
      FETCH_OG_IMAGE: "false",
    } as any,
    feeds,
    seen,
    settings,
  };
}

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
    } as any,
    pending,
  };
}

function apiRequest(path: string, init: RequestInit = {}, secret: string | null = SECRET) {
  const headers: Record<string, string> = {};
  if (secret) headers.Authorization = `Bearer ${secret}`;
  if (init.body) headers["Content-Type"] = "application/json";
  return new Request(`https://bot.test${path}`, { ...init, headers });
}

function callApi(path: string, init: RequestInit = {}, secret: string | null = SECRET) {
  const { env } = makeEnv();
  const { ctx } = makeCtx();
  return { env, res: worker.fetch(apiRequest(path, init, secret), env, ctx) };
}

afterEach(() => vi.unstubAllGlobals());

describe("command API auth", () => {
  it("rejects a missing or wrong secret", async () => {
    const noAuth = await callApi("/api/feeds", {}, null).res;
    expect(noAuth.status).toBe(401);
    expect(await noAuth.json()).toEqual({ ok: false, error: "Unauthorized" });

    const wrong = await callApi("/api/feeds", {}, "nope").res;
    expect(wrong.status).toBe(401);
  });
});

describe("admins", () => {
  it("lists the ADMIN_USER_ID", async () => {
    const { env } = makeEnv();
    const { ctx } = makeCtx();
    const res = await worker.fetch(apiRequest("/api/admins"), env, ctx);
    expect(await res.json()).toEqual({ ok: true, admins: [111] });
  });

  it("adds and removes an admin in KV", async () => {
    const { env, settings } = makeEnv();
    const { ctx } = makeCtx();

    const added = await worker.fetch(
      apiRequest("/api/admins", { method: "POST", body: JSON.stringify({ userId: 222, add: true }) }),
      env,
      ctx,
    );
    expect(await added.json()).toEqual({ ok: true, admins: [111, 222], added: true });
    expect(JSON.parse(settings.store.get("admins")!)).toEqual([111, 222]);

    const removed = await worker.fetch(
      apiRequest("/api/admins", { method: "POST", body: JSON.stringify({ userId: 111, add: false }) }),
      env,
      ctx,
    );
    expect(await removed.json()).toEqual({ ok: true, admins: [222], added: false });
  });

  it("rejects an invalid user id", async () => {
    const { env } = makeEnv();
    const { ctx } = makeCtx();
    const res = await worker.fetch(
      apiRequest("/api/admins", { method: "POST", body: JSON.stringify({ userId: "abc" }) }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });
});

describe("feeds", () => {
  it("starts empty", async () => {
    const { env } = makeEnv();
    const { ctx } = makeCtx();
    const res = await worker.fetch(apiRequest("/api/feeds"), env, ctx);
    expect(await res.json()).toEqual({ ok: true, feeds: [] });
  });

  it("adds a feed, stores it, and backfills seen ids", async () => {
    const { env, feeds, seen } = makeEnv();
    const { ctx } = makeCtx();

    const fetchSpy = vi.fn(async (input: any) => {
      const url = String(input);
      if (url === "https://example.com/feed") {
        return new Response(FEED_XML, { headers: { "content-type": "application/xml" } });
      }
      if (url.includes("api.telegram.org")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await worker.fetch(
      apiRequest("/api/feeds", {
        method: "POST",
        body: JSON.stringify({ url: "example.com/feed", chatId: 999 }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ok).toBe(true);
    expect(body.feed).toMatchObject({
      url: "https://example.com/feed",
      title: "Test Feed",
      itemCount: 2,
    });

    // One feed in RSS_FEEDS, two dedupe keys in RSS_SEEN.
    expect([...feeds.store.keys()]).toEqual(["feed:https://example.com/feed"]);
    expect([...seen.store.keys()]).toHaveLength(2);

    // Confirmation + preview card are delegated to the Worker.
    const telegramCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes("api.telegram.org"),
    );
    expect(telegramCalls).toHaveLength(2);
  });

  it("accepts a negative group chat id", async () => {
    const { env } = makeEnv();
    const { ctx } = makeCtx();
    const groupId = -1001234567890;

    const fetchSpy = vi.fn(async (input: any, init?: any) => {
      const url = String(input);
      if (url === "https://example.com/feed") {
        return new Response(FEED_XML, { headers: { "content-type": "application/xml" } });
      }
      if (url.includes("api.telegram.org")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await worker.fetch(
      apiRequest("/api/feeds", {
        method: "POST",
        body: JSON.stringify({ url: "example.com/feed", chatId: groupId }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    const telegramCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes("api.telegram.org"),
    );
    expect(telegramCalls.length).toBeGreaterThan(0);
    for (const [, init] of telegramCalls) {
      expect(JSON.parse(String(init.body)).chat_id).toBe(groupId);
    }
  });

  it("rejects a duplicate feed with 409", async () => {
    const { env, feeds } = makeEnv();
    const { ctx } = makeCtx();
    feeds.store.set(
      "feed:https://example.com/feed",
      JSON.stringify({ url: "https://example.com/feed", title: "Test Feed" }),
    );

    const res = await worker.fetch(
      apiRequest("/api/feeds", {
        method: "POST",
        body: JSON.stringify({ url: "https://example.com/feed" }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "⚠️ That feed is already added." });
  });

  it("removes a feed by 1-based index", async () => {
    const { env, feeds } = makeEnv();
    const { ctx } = makeCtx();
    feeds.store.set(
      "feed:https://example.com/feed",
      JSON.stringify({ url: "https://example.com/feed", title: "Test Feed", addedAt: 1 }),
    );

    const res = await worker.fetch(
      apiRequest("/api/feeds/remove", {
        method: "POST",
        body: JSON.stringify({ arg: "1" }),
      }),
      env,
      ctx,
    );

    expect(await res.json()).toEqual({
      ok: true,
      removed: { url: "https://example.com/feed", title: "Test Feed" },
    });
    expect(feeds.store.size).toBe(0);
  });

  it("returns 404 when removing an unknown feed", async () => {
    const { env } = makeEnv();
    const { ctx } = makeCtx();
    const res = await worker.fetch(
      apiRequest("/api/feeds/remove", {
        method: "POST",
        body: JSON.stringify({ arg: "https://nope.test/feed" }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
  });
});

describe("check", () => {
  it("runs a poll with no feeds and reports the summary", async () => {
    const { env } = makeEnv();
    const { ctx } = makeCtx();
    const res = await worker.fetch(
      apiRequest("/api/check", { method: "POST", body: JSON.stringify({ chatId: 999 }) }),
      env,
      ctx,
    );
    expect(await res.json()).toEqual({ ok: true, feeds: 0, sent: 0, errors: 0 });
  });

  it("rejects an unknown route", async () => {
    const { env } = makeEnv();
    const { ctx } = makeCtx();
    const res = await worker.fetch(apiRequest("/api/nope"), env, ctx);
    expect(res.status).toBe(404);
  });
});
