/**
 * Serverless-side state: feeds, seen articles and admins.
 *
 * Feeds and admins are read/written directly with `sdk/db`. The only Worker
 * calls left are the two operations that need the feed engine:
 *   - previewFeed() fetches/parses a feed and sends the add confirmation/card
 *   - pollFeeds() fetches/parses the current feeds with a supplied seen set
 *
 * The Worker is stateless; this store owns persistence. /check loads the state,
 * calls the Worker, then writes back the returned seen ids and feed metadata.
 */

import { db } from "sdk";
import { asc, eq, lt } from "sdk/db";
import { admins, feeds, seen } from "../schema.js";
import { BOOTSTRAP_ADMIN_ID, DEFAULT_CHAT_ID } from "./config.js";
import { pollFeeds, previewFeed } from "./worker-api.js";

const SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SEEN_BATCH = 200;

function bootstrapIds() {
  return String(BOOTSTRAP_ADMIN_ID ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** Pick the poll destination: DEFAULT_CHAT_ID, then the command chat, then the
 * first bootstrap admin. Returns undefined only when none is configured. */
function checkTarget(chatId) {
  const configured = Number(String(DEFAULT_CHAT_ID ?? "").trim());
  if (Number.isSafeInteger(configured) && configured !== 0) return configured;
  if (Number.isSafeInteger(chatId) && chatId !== 0) return chatId;
  return bootstrapIds()[0];
}

function feedInfo(row) {
  return {
    url: row.url,
    title: row.title,
    addedAt: Number(row.addedAt ?? 0),
    lastChecked: Number(row.lastChecked ?? 0),
    lastError: row.lastError ?? null,
    itemCount: row.itemCount ?? undefined,
  };
}

/** Same canonicalization as the Worker, so duplicate checks agree. */
function normalizeUrl(input) {
  let s = String(input ?? "").trim();
  if (!s) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    u.hash = "";
    const toDelete = [];
    u.searchParams.forEach((_value, key) => {
      if (/^(utm_[a-z0-9]+|mc_[a-z0-9]+|fbclid|gclid|igshid|ref|source|campaign)$/i.test(key)) {
        toDelete.push(key);
      }
    });
    for (const key of toDelete) u.searchParams.delete(key);
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return s;
  }
}

function chunks(rows, size) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export const worker = {
  async getAdmins() {
    const rows = await db.select().from(admins).all();
    const ids = new Set(rows.map((row) => Number(row.userId)));
    for (const id of bootstrapIds()) ids.add(id);
    return [...ids];
  },

  async listFeeds() {
    const rows = await db.select().from(feeds).orderBy(asc(feeds.addedAt)).all();
    return rows.map(feedInfo);
  },

  async addFeed(rawUrl, chatId) {
    const url = normalizeUrl(rawUrl);
    if (!/^https?:\/\//i.test(url)) throw new Error("❌ Invalid URL.");

    const existing = await db.select().from(feeds).where(eq(feeds.url, url)).get();
    if (existing) throw new Error("⚠️ That feed is already added.");

    // The Worker fetches/parses the feed, sends the confirmation + preview card,
    // and returns the hashes of the newest items so history is not replayed.
    const preview = await previewFeed(url, chatId);
    const now = Date.now();

    await db
      .insert(feeds)
      .values({
        url: preview.url || url,
        title: preview.title || url,
        chatId: Number.isSafeInteger(chatId) ? chatId : null,
        addedAt: now,
        lastChecked: now,
        lastError: null,
        itemCount: preview.itemCount ?? null,
      })
      .run();

    const ids = Array.isArray(preview.seenIds) ? preview.seenIds.filter(Boolean) : [];
    for (const batch of chunks(ids, SEEN_BATCH)) {
      await db
        .insert(seen)
        .values(batch.map((itemId) => ({ itemId, seenAt: now })))
        .onConflictDoNothing({ target: seen.itemId })
        .run();
    }

    // Keep the table from growing forever. Seen entries are intentionally global
    // and outlive a removed feed (re-adding it must not replay old articles).
    await db.delete(seen).where(lt(seen.seenAt, now - SEEN_TTL_MS)).run();

    return {
      url: preview.url || url,
      title: preview.title || url,
      itemCount: preview.itemCount,
    };
  },

  async removeFeed(arg) {
    const value = String(arg ?? "").trim();
    if (!value) throw new Error("Usage: /remove <url> or /remove <index>");

    let row = null;
    if (/^\d+$/.test(value)) {
      const rows = await db.select().from(feeds).orderBy(asc(feeds.addedAt)).all();
      row = rows[Number(value) - 1] ?? null;
    } else {
      const url = normalizeUrl(value);
      row = await db.select().from(feeds).where(eq(feeds.url, url)).get();
    }

    if (!row) throw new Error("❌ Feed not found. Use /list to see active feeds.");
    await db.delete(feeds).where(eq(feeds.url, row.url)).run();
    return { url: row.url, title: row.title };
  },

  async check(chatId) {
    const feedRows = await db.select().from(feeds).orderBy(asc(feeds.addedAt)).all();
    if (feedRows.length === 0) return { feeds: 0, sent: 0, errors: 0 };

    const seenRows = await db.select({ itemId: seen.itemId }).from(seen).all();
    const seenIds = seenRows.map((row) => row.itemId);
    const target = checkTarget(chatId);

    const result = await pollFeeds(feedRows.map(feedInfo), seenIds, target);

    // Persist the new ids first: the Worker only returns articles it delivered,
    // and the caller marks them seen so the next poll does not repeat them.
    const now = Date.now();
    const delivered = Array.isArray(result.seen) ? result.seen.filter(Boolean) : [];
    for (const batch of chunks(delivered, SEEN_BATCH)) {
      await db
        .insert(seen)
        .values(batch.map((itemId) => ({ itemId, seenAt: now })))
        .onConflictDoNothing({ target: seen.itemId })
        .run();
    }

    for (const update of Array.isArray(result.meta) ? result.meta : []) {
      if (!update?.url) continue;
      await db
        .update(feeds)
        .set({
          lastChecked: Number(update.lastChecked) || now,
          lastError: update.lastError ?? null,
          itemCount: Number.isFinite(Number(update.itemCount))
            ? Number(update.itemCount)
            : null,
        })
        .where(eq(feeds.url, update.url))
        .run();
    }

    await db.delete(seen).where(lt(seen.seenAt, now - SEEN_TTL_MS)).run();

    return (
      result?.summary ?? {
        feeds: feedRows.length,
        sent: delivered.length,
        errors: 0,
      }
    );
  },

  async setAdmin(userId, add) {
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`Usage: /admin <user_id>`);

    if (add) {
      await db
        .insert(admins)
        .values({ userId: id, addedAt: Date.now() })
        .onConflictDoNothing({ target: admins.userId })
        .run();
    } else {
      await db.delete(admins).where(eq(admins.userId, id)).run();
    }

    return worker.getAdmins();
  },
};
