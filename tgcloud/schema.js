/**
 * Telegram Serverless database schema.
 *
 * This is the source of truth for feeds, seen articles and admins. The
 * stateless Cloudflare Worker only fetches/parses feeds and sends cards; the
 * store (tgcloud/lib/store.js) reads and writes this state for every command
 * and for each poll.
 */

import { table, integer, text } from "sdk/db";

export const feeds = table("feeds", {
  url: text("url").primaryKey(),
  title: text("title").notNull(),
  chatId: integer("chat_id"),
  addedAt: integer("added_at").notNull(),
  lastChecked: integer("last_checked"),
  lastError: text("last_error"),
  itemCount: integer("item_count"),
});

export const seen = table("seen", {
  // SHA-256 of the canonical article GUID/link. Global (not per-feed) so the
  // same article is not posted twice when it appears in several feeds.
  itemId: text("item_id").primaryKey(),
  seenAt: integer("seen_at").notNull(),
});

export const admins = table("admins", {
  userId: integer("user_id").primaryKey(),
  addedAt: integer("added_at").notNull(),
});
