/**
 * Pure formatting helpers for the command layer.
 *
 * No SDK imports here on purpose: this module is unit-tested with plain
 * Node/Vitest, outside the Telegram Serverless runtime.
 */

export const USAGE_TEXT =
  "🤖 <b>RSS Feed Reader Bot</b>\n\n" +
  "<b>Commands:</b>\n" +
  "/add &lt;url&gt; — add an RSS/Atom feed\n" +
  "/remove &lt;url|index&gt; — remove a feed\n" +
  "/list — list active feeds\n" +
  "/check — check feeds now\n\n" +
  "Management commands require admin access.";

/** Split "/add@MyBot https://x" into { command: "add", args: "https://x" }. */
export function parseCommand(text) {
  const match = String(text ?? "").match(
    /^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s+([\s\S]*))?$/,
  );
  if (!match) return { command: "", args: "" };
  return { command: match[1].toLowerCase(), args: (match[2] ?? "").trim() };
}

/** Escape plain text for Telegram's HTML parse mode. */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Pack lines into messages of at most `max` characters, splitting on line
 * boundaries. A single overly long line is left intact (Telegram will reject
 * it, but that can only happen with a pathological feed title).
 */
export function chunkLines(lines, max = 3500) {
  const chunks = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > max && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** One or more ready-to-send messages listing the active feeds. */
export function formatFeedList(feeds) {
  const header = `📡 Active feeds (${feeds.length}):`;
  const lines = feeds.map((feed, index) => {
    const error = feed.lastError ? `\n    ⚠️ ${escapeHtml(feed.lastError)}` : "";
    return `${index + 1}. <b>${escapeHtml(feed.title)}</b>\n    ${escapeHtml(feed.url)}${error}`;
  });
  return chunkLines([header, "", ...lines]);
}

export function formatRemoved(removed) {
  return `🗑 Removed: <b>${escapeHtml(removed?.title || removed?.url || "")}</b>`;
}

export function formatAdmin(userId, added) {
  return added
    ? `✅ Added admin <code>${userId}</code>.`
    : `🗑 Removed admin <code>${userId}</code>.`;
}

export function formatCheck(summary) {
  if (summary?.pending) return "🔍 Check started — new items will arrive shortly.";
  const feeds = Number(summary?.feeds ?? 0);
  const sent = Number(summary?.sent ?? 0);
  const errors = Number(summary?.errors ?? 0);
  return `✅ Check complete: ${feeds} feed(s), ${sent} new item(s) sent, ${errors} error(s).`;
}
