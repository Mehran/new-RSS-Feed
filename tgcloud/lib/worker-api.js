/**
 * The two calls that still need the Cloudflare feed engine.
 *
 * All persistent state lives in the Telegram Serverless database. The Worker
 * is stateless: it fetches/parses feeds, sends cards, and returns the new
 * article ids plus per-feed metadata for the caller to persist.
 */

import { fetch } from "sdk";
import { COMMAND_API_SECRET, WORKER_URL } from "./config.js";

async function post(path, body) {
  const res = await fetch(`${WORKER_URL}/api${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${COMMAND_API_SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    // A non-JSON error page (e.g. a Cloudflare 5xx) — use the status below.
  }

  if (!res.ok || data?.ok !== true) {
    const message =
      typeof data?.error === "string"
        ? data.error
        : `The feed engine is unavailable (HTTP ${res.status}).`;
    throw new Error(message);
  }
  return data;
}

/** Fetch/parse a feed, send the confirmation + preview, return its newest ids. */
export async function previewFeed(url, chatId) {
  const data = await post("/feed/preview", { url, chatId });
  return data.feed;
}

/**
 * Run a stateless poll on the Worker.
 * @returns {{ summary: {feeds:number,sent:number,errors:number}, seen: string[], meta: object[] }}
 */
export async function pollFeeds(feeds, seen, chatId) {
  return post("/poll", { feeds, seen, chatId });
}
