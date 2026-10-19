/**
 * rss-dispatcher — cron relay for telegram-rss-bot
 * ==================================================
 *
 * Why this exists: the main Worker (telegram-rss-bot) cannot fetch its own
 * URL — Cloudflare rejects a self-invocation with error 1042. Its `scheduled`
 * handler is also capped at 10ms of CPU on the free plan, so it can't do the
 * heavy RSS polling itself. The main Worker's cron therefore POSTs to this
 * dispatcher's /trigger endpoint, and this dispatcher relays the request back
 * to the main Worker's /internal/check endpoint as a normal HTTP fetch, which
 * runs under the full CPU budget (exactly like a manual /check).
 *
 * Secrets / vars:
 *   INTERNAL_POLL_SECRET (secret)  -> shared secret; /trigger only accepts
 *                                     requests carrying it, and it is forwarded
 *                                     to the main Worker's /internal/check.
 *   TARGET_URL            (plain)  -> main Worker URL, e.g.
 *                                     https://telegram-rss-bot.<sub>.workers.dev
 */

export interface DispatcherEnv {
  TARGET_URL: string;
  INTERNAL_POLL_SECRET: string;
}

const POLL_SECRET_HEADER = "X-Internal-Poll-Secret";

export default {
  async fetch(request: Request, env: DispatcherEnv): Promise<Response> {
    const url = new URL(request.url);

    // Health check.
    if (url.pathname === "/ping" && request.method === "GET") {
      return new Response("rss-dispatcher ok", { status: 200 });
    }

    // Relay entry point: called by telegram-rss-bot's cron trigger.
    if (url.pathname === "/trigger" && request.method === "POST") {
      const secret = request.headers.get(POLL_SECRET_HEADER);
      if (!env.INTERNAL_POLL_SECRET || secret !== env.INTERNAL_POLL_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      try {
        const res = await fetch(`${env.TARGET_URL}/internal/check`, {
          method: "POST",
          headers: {
            [POLL_SECRET_HEADER]: env.INTERNAL_POLL_SECRET,
            "Content-Type": "application/json",
          },
        });
        const body = await res.text().catch(() => "");
        if (!res.ok) {
          console.error("Relay to target failed:", res.status, body.slice(0, 300));
        }
        return new Response(body, {
          status: res.status,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        console.error("Relay fetch failed:", (err as Error)?.message ?? err);
        return new Response(JSON.stringify({ error: "relay_failed" }), { status: 502 });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};
