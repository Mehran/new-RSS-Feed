/**
 * Thin client for the Cloudflare Worker's /api/* routes.
 *
 * The Serverless layer is stateless: feeds, seen items and admins live in
 * Cloudflare KV, and the Worker is the only thing that talks to Telegram for
 * article cards. Each method throws an Error whose message is safe to show to
 * the Telegram user.
 */

import { fetch } from "sdk";
import { COMMAND_API_SECRET, WORKER_URL } from "./config.js";

async function call(path, { method = "GET", body } = {}) {
  const res = await fetch(`${WORKER_URL}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${COMMAND_API_SECRET}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON error page (e.g. a Cloudflare 5xx) — fall through.
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

export const worker = {
  getAdmins: () => call("/admins").then((data) => data.admins ?? []),

  listFeeds: () => call("/feeds").then((data) => data.feeds ?? []),

  addFeed: (url, chatId) =>
    call("/feeds", { method: "POST", body: { url, chatId } }).then((data) => data.feed),

  removeFeed: (arg, chatId) =>
    call("/feeds/remove", { method: "POST", body: { arg, chatId } }).then(
      (data) => data.removed,
    ),

  check: (chatId) => call("/check", { method: "POST", body: { chatId } }),

  setAdmin: (userId, add) =>
    call("/admins", { method: "POST", body: { userId, add } }).then((data) => data.admins),
};
