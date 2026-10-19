import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";

const SECRET = "test-secret";
const FEED_URL = "https://example.com/feed";

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

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    TELEGRAM_BOT_TOKEN: "TOKEN",
    ADMIN_USER_ID: "111",
    COMMAND_API_SECRET: SECRET,
    DEFAULT_CHAT_ID: "111",
    FETCH_OG_IMAGE: "false",
    ...overrides,
  } as any;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(feedResponse?: Response) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
    const url = String(input);

    if (url === FEED_URL) {
      return (
        feedResponse ??
        new Response(FEED_XML, {
          status: 200,
          headers: { "Content-Type": "application/rss+xml" },
        })
      );
    }

    if (url.includes("api.telegram.org")) {
      return json({ ok: true, result: { message_id: 1 } });
    }

    return json({ ok: false, description: `unexpected fetch ${url}` }, 500);
  });
}

async function post(
  path: string,
  body: unknown,
  env = makeEnv(),
  secret: string | null = SECRET,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  return worker.fetch(
    new Request(`https://bot.test${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    env,
  );
}

async function get(path: string, env = makeEnv()): Promise<Response> {
  return worker.fetch(new Request(`https://bot.test${path}`), env);
}

afterEach(() => vi.unstubAllGlobals());

const feed = {
  url: FEED_URL,
  title: "Test Feed",
  addedAt: 1,
  lastChecked: 0,
  lastError: null,
  itemCount: 2,
};

function telegramCalls(): any[][] {
  return (globalThis.fetch as any).mock.calls.filter(([url]: any[]) =>
    String(url).includes("api.telegram.org"),
  );
}

describe("command API auth", () => {
  it("rejects missing or wrong command secrets", async () => {
    mockFetch();
    const noAuth = await post("/api/poll", {}, makeEnv(), null);
    expect(noAuth.status).toBe(401);
    expect(await noAuth.json()).toEqual({ ok: false, error: "Unauthorized" });

    const wrong = await post("/api/feed/preview", { url: FEED_URL }, makeEnv(), "nope");
    expect(wrong.status).toBe(401);
  });
});

describe("feed preview", () => {
  it("fetches/parses a feed, sends confirmation + preview, returns seen hashes", async () => {
    mockFetch();

    const res = await post("/api/feed/preview", { url: FEED_URL, chatId: 111 });
    expect(res.status).toBe(200);

    const body: any = await res.json();
    expect(body.ok).toBe(true);
    expect(body.feed.url).toBe(FEED_URL);
    expect(body.feed.title).toBe("Test Feed");
    expect(body.feed.itemCount).toBe(2);
    expect(body.feed.seenIds).toHaveLength(2);
    expect(body.feed.seenIds[0]).toMatch(/^[0-9a-f]{64}$/);

    const calls = telegramCalls();
    expect(calls).toHaveLength(2);
    const texts = calls.map(([, init]: any[]) => JSON.parse(init.body).text);
    expect(texts[0]).toContain("Feed added");
    expect(texts[1]).toContain("Newest");
  });

  it("rejects an invalid URL without fetching", async () => {
    mockFetch();
    const res = await post("/api/feed/preview", { url: "ftp://example.com/feed" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "❌ Invalid URL." });
  });

  it("returns a clear error when the feed cannot be fetched", async () => {
    mockFetch(new Response("nope", { status: 500 }));
    const res = await post("/api/feed/preview", { url: FEED_URL });
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error).toMatch(/Could not fetch feed/);
  });

  it("rejects a document with no RSS/Atom items", async () => {
    mockFetch(
      new Response("<rss><channel><title>Empty</title></channel></rss>", {
        status: 200,
        headers: { "Content-Type": "application/rss+xml" },
      }),
    );
    const res = await post("/api/feed/preview", { url: FEED_URL });
    expect(res.status).toBe(422);
  });
});

describe("poll", () => {
  it("returns an empty result when no feeds are supplied", async () => {
    mockFetch();
    const res = await post("/api/poll", { feeds: [], seen: [] });
    expect(await res.json()).toEqual({
      ok: true,
      summary: { feeds: 0, sent: 0, errors: 0 },
      seen: [],
      meta: [],
    });
  });

  it("sends unseen items and returns their ids plus metadata", async () => {
    mockFetch();

    const res = await post("/api/poll", { feeds: [feed], seen: [] });
    const body: any = await res.json();
    expect(body.ok).toBe(true);
    expect(body.summary).toEqual({ feeds: 1, sent: 2, errors: 0 });
    expect(body.seen).toHaveLength(2);
    expect(body.seen.every((id: string) => /^[0-9a-f]{64}$/.test(id))).toBe(true);
    expect(body.meta).toEqual([
      { url: FEED_URL, lastChecked: expect.any(Number), lastError: null, itemCount: 2 },
    ]);

    expect(telegramCalls()).toHaveLength(2);
  });

  it("does not resend articles that are already seen", async () => {
    mockFetch();
    const first = await post("/api/poll", { feeds: [feed], seen: [] });
    const seen = ((await first.json()) as any).seen;

    const second = await post("/api/poll", { feeds: [feed], seen });
    const body: any = await second.json();
    expect(body.summary).toEqual({ feeds: 1, sent: 0, errors: 0 });
    expect(body.seen).toEqual([]);
  });

  it("records a feed fetch error without failing the poll", async () => {
    mockFetch(new Response("blocked", { status: 526 }));

    const res = await post("/api/poll", { feeds: [feed], seen: [] });
    const body: any = await res.json();
    expect(body.summary).toEqual({ feeds: 1, sent: 0, errors: 1 });
    expect(body.meta[0]).toMatchObject({ url: FEED_URL, lastError: expect.any(String) });
  });
});

describe("root", () => {
  it("describes the stateless feed engine", async () => {
    mockFetch();
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("feed engine is running");
  });
});
