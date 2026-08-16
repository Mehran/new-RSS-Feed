/**
 * Telegram RSS Feed Reader Bot — Cloudflare Workers
 * ==================================================
 *
 * Architecture:
 *   - Telegram <-> Worker via Webhook (POST /webhook). Commands are parsed
 *     and handled here. Only authorized admins may manage feeds / trigger checks.
 *   - Worker cron trigger (`scheduled`) polls every saved RSS feed, diffs new
 *     articles against the RSS_SEEN KV store, and posts card-style messages.
 *   - State lives in Cloudflare KV:
 *       RSS_FEEDS    -> feed URL -> { url, title, addedAt, lastChecked, lastError }
 *       RSS_SEEN     -> sha256(article id) -> timestamp (with TTL, auto-expires)
 *       RSS_SETTINGS -> "admins" -> JSON array of authorized admin user IDs
 *
 * Message card layout (HTML parse mode):
 *       <b>Title</b>
 *       <truncated excerpt, tags stripped>
 *       [ Read More ]  <- inline keyboard button linking to the article
 *   Image (from media:content / enclosure / <img>) is sent via sendPhoto;
 *   if none is found, the card falls back to sendMessage.
 */

import { XMLParser } from "fast-xml-parser";

/* ============================== Types ============================== */

interface Env {
  RSS_FEEDS: KVNamespace;
  RSS_SEEN: KVNamespace;
  RSS_SETTINGS: KVNamespace;
  TELEGRAM_BOT_TOKEN: string;
  ADMIN_USER_ID: string;
  WEBHOOK_SECRET: string;
  DEFAULT_CHAT_ID?: string;
  FETCH_OG_IMAGE?: string;
}

interface FeedInfo {
  url: string;
  title: string;
  addedAt: number;
  lastChecked: number;
  lastError: string | null;
  itemCount?: number;
}

interface ArticleItem {
  title: string;
  link: string;
  guid: string;
  descriptionHtml: string;
  pubDate: string;
  raw: any; // original parsed XML node (for media/enclosure extraction)
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number; type?: string };
  from?: { id: number; username?: string; first_name?: string };
  text?: string;
}

interface CheckSummary {
  feeds: number;
  sent: number;
  errors: number;
}

/* ============================= Constants ============================= */

const TELEGRAM_API = "https://api.telegram.org/bot";
const FEED_UA = "Mozilla/5.0 (compatible; TelegramRSSBot/1.0)";
const PAGE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MAX_ITEMS_PER_FEED = 30; // only inspect the newest N items per feed
const MAX_SEND_PER_RUN = 20; // hard cap on messages per check, protects limits
const SEEN_TTL_SECONDS = 60 * 60 * 24 * 30; // auto-expire seen entries after 30 days
const BODY_MAX = 300; // cleaned summary length before truncation
const CAPTION_MAX = 950; // Telegram photo captions cap at 1024; keep a safety margin

/* ========================== XML / RSS parser ========================== */

const xmlParser = new XMLParser({
  ignoreAttributes: false, // keep attributes under "@_"
  attributeNamePrefix: "@_",
  removeNSPrefix: false, // keep namespaces ("media:content", "content:encoded")
  parseTagValue: false, // keep values as strings
  parseAttributeValue: false,
  trimValues: false,
  processEntities: {
    enabled: true, // decode the 5 XML entities + numeric refs
    // Large feeds (e.g. zoomit.ir) contain thousands of numeric character
    // references (&#8204; = zero-width non-joiner, ubiquitous in Persian text),
    // which exceed fast-xml-parser's default 1000-expansion safety cap.
    // Raise the caps to a bounded but practical ceiling.
    maxTotalExpansions: 100_000,
    maxExpandedLength: 5_000_000,
  },
});

/** Parse an XML/RSS/Atom string (exported for unit testing). */
export function parseXml(xml: string): any {
  return xmlParser.parse(xml);
}

/** Return a value as an array (normalizes single vs. repeated XML tags). */
export function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Extract the text content of an arbitrary parsed XML node. */
export function textOf(value: any): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (typeof value === "object") {
    const t = value["#text"];
    return typeof t === "string" || typeof t === "number" ? String(t) : "";
  }
  return "";
}

/** Extract a URL from a parsed XML node (media:*, enclosure, atom link, …). */
export function nodeUrl(node: any): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  return node["@_url"] ?? node["@_href"] ?? node["#text"] ?? "";
}

/** Atom `<link>` elements can be strings or objects with @_href/@_rel. */
export function atomLink(entry: any): string {
  const links = asArray(entry?.link);
  for (const l of links) {
    const url = typeof l === "string" ? l : l?.["@_href"] ?? "";
    const rel = typeof l === "object" ? l["@_rel"] ?? "alternate" : "alternate";
    if (url && rel === "alternate") return String(url);
  }
  for (const l of links) {
    const url = typeof l === "string" ? l : l?.["@_href"] ?? "";
    if (url) return String(url);
  }
  return "";
}

/** Normalize RSS/Atom entries into a common shape. */
export function extractItems(parsed: any): ArticleItem[] {
  const items: ArticleItem[] = [];

  // RSS 2.0 / RDF: <rss><channel><item>
  for (const it of asArray(parsed?.rss?.channel?.item)) {
    items.push({
      title: textOf(it?.title),
      link: textOf(it?.link),
      guid: textOf(it?.guid),
      descriptionHtml:
        textOf(it?.["content:encoded"] ?? it?.encoded ?? it?.description ?? it?.summary ?? ""),
      pubDate: textOf(it?.pubDate ?? it?.["dc:date"]),
      raw: it,
    });
  }

  // Atom: <feed><entry>
  for (const e of asArray(parsed?.feed?.entry)) {
    items.push({
      title: textOf(e?.title),
      link: atomLink(e),
      guid: textOf(e?.id),
      descriptionHtml: textOf(e?.content ?? e?.summary ?? ""),
      pubDate: textOf(e?.updated ?? e?.published),
      raw: e,
    });
  }

  // Newest first (RSS order is usually already newest-first; this makes it explicit).
  return items.sort((a, b) => dateOf(b.pubDate) - dateOf(a.pubDate));
}

function dateOf(s: string): number {
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** Feed title (for card footer / add confirmation). */
export function extractFeedTitle(parsed: any): string {
  return textOf(parsed?.rss?.channel?.title ?? parsed?.feed?.title ?? "");
}

/* ======================== Image extraction ======================== */

export function isImageUrl(url: string): boolean {
  return /\.(jpe?g|png|gif|webp|avif|svg)(\?|#|$)/i.test(url);
}

/** Pull the first usable image straight from the feed (no extra fetches). */
export function extractImageFromFeed(raw: any): string | null {
  if (!raw) return null;

  // 0. RSS item-level <image><url>...</url></image> (e.g. digiato.com)
  const itemImage = textOf(raw.image?.url);
  if (itemImage) return decodeEntities(itemImage);

  // 1. <media:content medium="image" url="...">
  const media = asArray(raw["media:content"] ?? raw.media?.content ?? raw.mediaContent);
  for (const m of media) {
    const url = nodeUrl(m);
    const medium = String(m?.["@_medium"] ?? "").toLowerCase();
    if (url && (medium === "image" || isImageUrl(url))) return decodeEntities(url);
  }

  // 2. <media:thumbnail url="...">
  const thumbs = asArray(raw["media:thumbnail"] ?? raw.media?.thumbnail ?? raw.mediaThumbnail);
  for (const t of thumbs) {
    const url = nodeUrl(t);
    if (url) return decodeEntities(url);
  }

  // 3. <enclosure url="..." type="image/...">
  for (const e of asArray(raw.enclosure)) {
    const url = nodeUrl(e);
    const type = String(e?.["@_type"] ?? "").toLowerCase();
    if (url && (type.startsWith("image/") || isImageUrl(url))) return decodeEntities(url);
  }

  return null;
}

/** Extract an <img src="..."> from HTML in description/content:encoded. */
export function extractImgFromHtml(html: string): string | null {
  if (!html) return null;
  const m =
    html.match(/<img[^>]+?\bsrc\s*=\s*["']([^"']+)["']/i) ??
    html.match(/<img[^>]+?\bsrc\s*=\s*([^\s"'>]+)/i);
  if (!m) return null;
  const url = decodeEntities(m[1]);
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return "https:" + url;
  return null; // ignore relative URLs (no reliable base)
}

/* ---------- Multi-stage image extraction ---------- */

/** Skip 1x1/transparent/tracking pixels by URL heuristics. */
const TRACKING_PIXEL_RE =
  /(?:1x1|pixel|track(?:ing)?|beacon|blank|spacer|transparent|clear)[^/]*\.(?:gif|png)(?:\?|#|$)/i;

/**
 * Clean an extracted image URL: decode entities, absolutize protocol-relative
 * and relative URLs, drop non-http schemes and obvious tracking pixels.
 * Returns null when the URL can't be made usable.
 */
export function cleanupImageUrl(url: string, baseUrl?: string): string | null {
  if (!url) return null;
  let u = decodeEntities(url.trim());
  if (!u) return null;
  if (u.startsWith("//")) u = "https:" + u;
  if (!/^https?:\/\//i.test(u)) {
    if (!baseUrl) return null;
    try {
      u = new URL(u, baseUrl).toString();
    } catch {
      return null;
    }
  }
  if (!/^https?:\/\//i.test(u)) return null;
  if (TRACKING_PIXEL_RE.test(u)) return null;
  return u;
}

/** Extract a featured image from <head> meta/link tags (og:image etc.). */
export function extractMetaImage(html: string, baseUrl: string): string | null {
  if (!html) return null;
  const patterns: RegExp[] = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+property=["']og:image:url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']image_src["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const url = cleanupImageUrl(m[1], baseUrl);
      if (url) return url;
    }
  }
  return null;
}

/** Stage 2: fetch the article page and read its head for a featured image. */
export async function fetchPageImage(link: string): Promise<string | null> {
  if (!link) return null;
  try {
    const res = await fetch(link, {
      headers: {
        "User-Agent": PAGE_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    const type = res.headers.get("content-type") ?? "";
    const length = Number(res.headers.get("content-length") ?? "0");
    if (!type.includes("text/html") || length > 2_000_000) return null;
    const html = (await res.text()).slice(0, 500_000);
    return extractMetaImage(html, res.url || link);
  } catch {
    return null;
  }
}

/**
 * Resolve the article's featured image across all stages:
 *   1. feed XML (media:content / media:thumbnail / enclosure / <img> in HTML)
 *   2. webpage <head> (og:image / twitter:image / image_src) — unless disabled
 * Every candidate is passed through cleanupImageUrl.
 */
export async function resolveArticleImage(
  env: Env,
  item: ArticleItem,
): Promise<string | null> {
  const link = decodeEntities((item.link || "").trim());

  // Stage 1: straight from the feed — no extra fetch.
  let img = extractImageFromFeed(item.raw);
  if (!img) img = extractImgFromHtml(item.descriptionHtml);
  if (img) return cleanupImageUrl(img, link);

  // Stage 2: webpage head fallback (on by default; FETCH_OG_IMAGE=false disables).
  if (env.FETCH_OG_IMAGE === "false") return null;
  const page = await fetchPageImage(link);
  return page ? cleanupImageUrl(page, link) : null;
}

/* ======================= Text / HTML helpers ======================= */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", copy: "©",
  reg: "®", trade: "™", deg: "°", middot: "·", bull: "•", cent: "¢", pound: "£",
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(Number(d)))
    .replace(/&([a-z][a-z0-9]+);/gi, (m, name) => NAMED_ENTITIES[name] ?? m);
}

function safeFromCodePoint(cp: number): string {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

/** Strip tags/scripts/styles and decode entities -> plain text. */
export function stripHtml(html: string): string {
  if (!html) return "";
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/ *\n */g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/** Escape a plain-text string for Telegram's HTML parse mode. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function truncate(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/\s+\S*$/, "").trimEnd() + "…";
}

/* ---------- Feed watermark / boilerplate removal ---------- */

const BOILERPLATE_PATTERNS: RegExp[] = [
  // WordPress / Yoast SEO English footer
  /\bThe post\b[^\n]*?\b(?:appeared first on|first appeared on)\b[^\n]*/gi,
  /\bThis post\b[^\n]*?\b(?:appeared first on|first appeared on)\b[^\n]*/gi,
  // Persian equivalents (نوشته … اولین بار در … پدیدار شد)
  /نوشته[^\n]*?(?:اولین بار|نخستین بار|برای اولین بار)[^\n]*?پدیدار شد[.۔]?/g,
  /مطلب[^\n]*?(?:اولین بار|نخستین بار)[^\n]*?پدیدار شد[.۔]?/g,
];

/** Remove feed watermarks / WordPress "first appeared on" boilerplate. */
export function stripFeedBoilerplate(text: string): string {
  if (!text) return "";
  let out = text;
  for (const re of BOILERPLATE_PATTERNS) out = out.replace(re, "");
  return out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** Full body pipeline: strip HTML, remove boilerplate, truncate. */
export function cleanBody(html: string): string {
  return truncate(stripFeedBoilerplate(stripHtml(html)), BODY_MAX);
}

/* ========================= URL / ID helpers ========================= */

/** Canonicalize a URL: add scheme if missing, strip hash/tracking/trailing slash. */
export function normalizeUrl(input: string): string {
  let s = (input || "").trim();
  if (!s) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    u.hash = "";
    const toDelete: string[] = [];
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

/** Stable, dedupe-safe identifier for an article. */
export function canonicalId(rawId: string): string {
  // XML/HTML numeric refs (e.g. WordPress `&#038;` = `&`) can leak into GUIDs
  // because fast-xml-parser only decodes a subset in text nodes. Decode them
  // first, otherwise `normalizeUrl` would treat the `#` in `&#038;` as a
  // fragment delimiter and drop the query params (e.g. the post id), collapsing
  // every article in a feed to the same dedupe key.
  const t = decodeEntities(rawId.trim());
  return /^https?:\/\//i.test(t) ? normalizeUrl(t) : t;
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/* ======================== Telegram API helpers ======================== */

async function callApi(
  env: Env,
  method: string,
  payload: Record<string, unknown>,
): Promise<any> {
  const res = await fetch(`${TELEGRAM_API}${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(`Telegram ${method} failed (${res.status}): ${data.description ?? "unknown"}`);
  }
  return data.result;
}

function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  opts: Record<string, unknown> = {},
): Promise<any> {
  return callApi(env, "sendMessage", { chat_id: chatId, text, ...opts });
}

function sendPhoto(
  env: Env,
  chatId: number,
  photo: string,
  caption: string,
  replyMarkup?: Record<string, unknown>,
): Promise<any> {
  return callApi(env, "sendPhoto", {
    chat_id: chatId,
    photo,
    caption,
    parse_mode: "HTML",
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

/* ======================== KV storage helpers ======================== */

function feedKey(url: string): string {
  const u = normalizeUrl(url);
  return u.length <= 450 ? `feed:${u}` : `feed:h:${fnv1a(u)}`;
}

async function listFeeds(env: Env): Promise<FeedInfo[]> {
  const feeds: FeedInfo[] = [];
  let cursor: string | undefined;
  do {
    const res = await env.RSS_FEEDS.list({ prefix: "feed:", cursor, limit: 100 });
    for (const k of res.keys) {
      const raw = await env.RSS_FEEDS.get(k.name);
      if (!raw) continue;
      try {
        feeds.push(JSON.parse(raw) as FeedInfo);
      } catch {
        /* ignore malformed entries */
      }
    }
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  return feeds.sort((a, b) => a.addedAt - b.addedAt);
}

async function isSeen(env: Env, rawId: string): Promise<boolean> {
  const key = `seen:${await sha256Hex(canonicalId(rawId))}`;
  return (await env.RSS_SEEN.get(key)) !== null;
}

async function markSeen(env: Env, rawId: string): Promise<void> {
  const key = `seen:${await sha256Hex(canonicalId(rawId))}`;
  await env.RSS_SEEN.put(key, String(Date.now()), { expirationTtl: SEEN_TTL_SECONDS });
}

async function updateFeedMeta(env: Env, feed: FeedInfo, patch: Partial<FeedInfo>): Promise<void> {
  await env.RSS_FEEDS.put(feedKey(feed.url), JSON.stringify({ ...feed, ...patch }));
}

/* ======================== Feed fetching / polling ======================== */

async function fetchAndParse(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": FEED_UA,
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Feed fetch failed: HTTP ${res.status}`);
  return parseXml(await res.text());
}

function getItemRawId(item: ArticleItem): string {
  return (item.guid || item.link || `${item.title}|${item.pubDate}`).trim();
}

/** Truncate an HTML-escaped string without splitting an entity (&amp; etc.). */
function truncateEscaped(text: string, max: number): string {
  let cut = text.slice(0, max);
  const m = cut.match(/&(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+)?$/);
  if (m && m.index !== undefined) cut = cut.slice(0, m.index);
  return cut.trimEnd();
}

/** Build an HTML caption that always fits Telegram's 1024-char photo limit. */
export function buildCaption(title: string, body: string, feedTitle?: string): string {
  const header = `<b>${escapeHtml(title)}</b>`;
  const footer = feedTitle ? `\n\n<i>${escapeHtml(feedTitle)}</i>` : "";
  const budget = Math.max(0, CAPTION_MAX - header.length - footer.length);

  // Escape first, then truncate, so entity expansion (& -> &amp;) can't overflow.
  let bodyText = escapeHtml(body);
  if (bodyText.length + 4 > budget) {
    const max = budget - 4 - 1; // reserve the "\n\n" separator + "…" ellipsis
    bodyText = max > 0 ? truncateEscaped(bodyText, max) + "…" : "";
  }

  let caption = header;
  if (bodyText) caption += `\n\n${bodyText}`;
  caption += footer;
  // Absolute final clamp (safety net; only hit in pathological title/footer cases).
  return caption.length > CAPTION_MAX ? caption.slice(0, CAPTION_MAX) : caption;
}

/** Build the card (caption + "Read More" button) and send it, with fallback. */
async function sendArticle(
  env: Env,
  chatId: number,
  item: ArticleItem,
  feedTitle?: string,
): Promise<boolean> {
  const title = truncate(stripHtml(item.title), 180) || "(untitled)";
  const body = cleanBody(item.descriptionHtml);
  const link = decodeEntities((item.link || "").trim());

  const caption = buildCaption(title, body, feedTitle);
  const replyMarkup = link
    ? { inline_keyboard: [[{ text: "Read More", url: link }]] }
    : undefined;

  const photoUrl = await resolveArticleImage(env, item);

  if (photoUrl) {
    try {
      await sendPhoto(env, chatId, photoUrl, caption, replyMarkup);
      return true;
    } catch (err) {
      console.error("sendPhoto failed, falling back to sendMessage:", err);
    }
  }
  await sendMessage(env, chatId, caption, {
    parse_mode: "HTML",
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
  return true;
}

/** Process one feed: send new items (up to `budget`) and mark them seen. */
async function processFeed(
  env: Env,
  feed: FeedInfo,
  chatId: number,
  budget: number,
): Promise<{ sent: number }> {
  const parsed = await fetchAndParse(feed.url);
  const items = extractItems(parsed).slice(0, MAX_ITEMS_PER_FEED);
  let sent = 0;

  for (const item of items) {
    const rawId = getItemRawId(item);
    if (!rawId) continue;
    if (await isSeen(env, rawId)) continue; // already posted
    if (sent >= budget) break;
    await sendArticle(env, chatId, item, feed.title);
    await markSeen(env, rawId);
    sent++;
  }

  await updateFeedMeta(env, feed, {
    lastChecked: Date.now(),
    lastError: null,
    itemCount: items.length,
  });
  return { sent };
}

async function checkAllFeeds(env: Env, chatId: number): Promise<CheckSummary> {
  const feeds = await listFeeds(env);
  const summary: CheckSummary = { feeds: feeds.length, sent: 0, errors: 0 };
  let budget = MAX_SEND_PER_RUN;

  for (const feed of feeds) {
    if (budget <= 0) break;
    try {
      const { sent } = await processFeed(env, feed, chatId, budget);
      summary.sent += sent;
      budget -= sent;
    } catch (err) {
      summary.errors++;
      await updateFeedMeta(env, feed, {
        lastChecked: Date.now(),
        lastError: String((err as Error)?.message ?? err).slice(0, 200),
      });
    }
  }
  return summary;
}

/* ====================== Admin authorization ====================== */

function envAdminIds(env: Env): number[] {
  return (env.ADMIN_USER_ID ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

async function getAdmins(env: Env): Promise<number[]> {
  const ids = new Set(envAdminIds(env));
  const raw = await env.RSS_SETTINGS.get("admins");
  if (raw) {
    try {
      for (const id of JSON.parse(raw)) if (typeof id === "number") ids.add(id);
    } catch {
      /* ignore malformed admins */
    }
  }
  return [...ids];
}

async function isAdmin(env: Env, userId: number | undefined): Promise<boolean> {
  if (!userId) return false;
  return (await getAdmins(env)).includes(userId);
}

function getTargetChatId(env: Env, fallbackChatId?: number): number | undefined {
  if (env.DEFAULT_CHAT_ID) {
    const n = Number(env.DEFAULT_CHAT_ID);
    if (Number.isFinite(n)) return n;
  }
  return fallbackChatId ?? envAdminIds(env)[0];
}

/* ======================== Command handlers ======================== */

function parseCommand(text: string): { command: string; args: string } {
  const m = text.match(/^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s+([\s\S]*))?$/);
  if (!m) return { command: "", args: "" };
  return { command: m[1].toLowerCase(), args: (m[2] ?? "").trim() };
}

async function sendUsage(env: Env, chatId: number): Promise<void> {
  await sendMessage(
    env,
    chatId,
    "🤖 <b>RSS Feed Reader Bot</b>\n\n" +
      "<b>Commands:</b>\n" +
      "/add &lt;url&gt; — add an RSS/Atom feed\n" +
      "/remove &lt;url|index&gt; — remove a feed\n" +
      "/list — list active feeds\n" +
      "/check — check feeds now\n\n" +
      "Management commands require admin access.",
    { parse_mode: "HTML" },
  );
}

async function deny(env: Env, chatId: number): Promise<void> {
  await sendMessage(env, chatId, "⛔ You are not authorized to use this command.");
}

async function cmdAdd(env: Env, chatId: number, fromId: number | undefined, args: string) {
  if (!(await isAdmin(env, fromId))) return deny(env, chatId);
  if (!args) return sendMessage(env, chatId, "Usage: /add <url>");

  const url = normalizeUrl(args);
  if (!/^https?:\/\//i.test(url)) return sendMessage(env, chatId, "❌ Invalid URL.");

  const existing = await env.RSS_FEEDS.get(feedKey(url));
  if (existing) return sendMessage(env, chatId, "⚠️ That feed is already added.");

  const parsed = await fetchAndParse(url);
  const items = extractItems(parsed);
  if (items.length === 0) {
    return sendMessage(env, chatId, "❌ No <item>/<entry> elements found — not a valid RSS/Atom feed?");
  }

  const title = stripHtml(extractFeedTitle(parsed)) || url;
  const feed: FeedInfo = {
    url,
    title,
    addedAt: Date.now(),
    lastChecked: Date.now(),
    lastError: null,
    itemCount: items.length,
  };
  await env.RSS_FEEDS.put(feedKey(url), JSON.stringify(feed));

  // Backfill-silence: mark existing items as seen so history isn't spammed.
  for (const item of items.slice(0, MAX_ITEMS_PER_FEED)) {
    const rawId = getItemRawId(item);
    if (rawId) await markSeen(env, rawId);
  }

  await sendMessage(
    env,
    chatId,
    `✅ Feed added: <b>${escapeHtml(title)}</b>\n${url}\n` +
      `${items.length} item(s) found (existing items marked as read).`,
    { parse_mode: "HTML" },
  );

  // Preview the latest item so you can see the card format.
  await sendArticle(env, chatId, items[0], title);
}

async function cmdRemove(env: Env, chatId: number, fromId: number | undefined, args: string) {
  if (!(await isAdmin(env, fromId))) return deny(env, chatId);
  if (!args) return sendMessage(env, chatId, "Usage: /remove <url> or /remove <index>");

  // Allow removing by /list index (1-based) or by URL.
  if (/^\d+$/.test(args)) {
    const feeds = await listFeeds(env);
    const idx = Number(args) - 1;
    const feed = feeds[idx];
    if (!feed) return sendMessage(env, chatId, "❌ No feed at that index.");
    await env.RSS_FEEDS.delete(feedKey(feed.url));
    return sendMessage(env, chatId, `🗑 Removed: ${escapeHtml(feed.title)}`);
  }

  const url = normalizeUrl(args);
  const existing = await env.RSS_FEEDS.get(feedKey(url));
  if (!existing) return sendMessage(env, chatId, "❌ Feed not found. Use /list to see active feeds.");
  await env.RSS_FEEDS.delete(feedKey(url));
  await sendMessage(env, chatId, "🗑 Removed feed.");
}

async function cmdList(env: Env, chatId: number, fromId: number | undefined) {
  if (!(await isAdmin(env, fromId))) return deny(env, chatId);
  const feeds = await listFeeds(env);
  if (feeds.length === 0) return sendMessage(env, chatId, "No feeds added. Use /add <url>.");

  const lines = feeds.map((f, i) => {
    const err = f.lastError ? `\n    ⚠️ ${escapeHtml(f.lastError)}` : "";
    return `${i + 1}. <b>${escapeHtml(f.title)}</b>\n    ${escapeHtml(f.url)}${err}`;
  });
  await sendMessage(
    env,
    chatId,
    `📡 Active feeds (${feeds.length}):\n\n${lines.join("\n")}`,
    { parse_mode: "HTML", disable_web_page_preview: true },
  );
}

async function cmdCheck(env: Env, chatId: number, fromId: number | undefined) {
  if (!(await isAdmin(env, fromId))) return deny(env, chatId);
  await sendMessage(env, chatId, "🔍 Checking all feeds…");
  const target = getTargetChatId(env, chatId);
  if (!target) return sendMessage(env, chatId, "❌ No target chat configured (set ADMIN_USER_ID or DEFAULT_CHAT_ID).");
  const summary = await checkAllFeeds(env, target);
  await sendMessage(
    env,
    chatId,
    `✅ Check complete: ${summary.feeds} feed(s), ${summary.sent} new item(s) sent, ${summary.errors} error(s).`,
  );
}

async function cmdAdmin(
  env: Env,
  chatId: number,
  fromId: number | undefined,
  args: string,
  add: boolean,
) {
  if (!(await isAdmin(env, fromId))) return deny(env, chatId);
  const target = Number(args.trim());
  if (!Number.isInteger(target) || target <= 0) return sendMessage(env, chatId, "Usage: /admin <user_id>");

  const admins = new Set(await getAdmins(env));
  if (add) admins.add(target);
  else admins.delete(target);
  await env.RSS_SETTINGS.put("admins", JSON.stringify([...admins]));

  await sendMessage(
    env,
    chatId,
    add
      ? `✅ Added admin <code>${target}</code>.`
      : `🗑 Removed admin <code>${target}</code>.`,
    { parse_mode: "HTML" },
  );
}

async function handleUpdate(env: Env, update: TelegramUpdate): Promise<void> {
  const msg = update.message ?? update.edited_message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const fromId = msg.from?.id;
  const { command, args } = parseCommand(msg.text);
  if (!command) return;

  try {
    switch (command) {
      case "start":
      case "help":
        return await sendUsage(env, chatId);
      case "add":
        return await cmdAdd(env, chatId, fromId, args);
      case "remove":
        return await cmdRemove(env, chatId, fromId, args);
      case "list":
        return await cmdList(env, chatId, fromId);
      case "check":
        return await cmdCheck(env, chatId, fromId);
      case "admin":
        return await cmdAdmin(env, chatId, fromId, args, true);
      case "unadmin":
        return await cmdAdmin(env, chatId, fromId, args, false);
      default:
        return; // ignore unknown commands
    }
  } catch (err) {
    await sendMessage(
      env,
      chatId,
      `⚠️ ${(err as Error)?.message ?? "Something went wrong."}`,
    ).catch(() => {});
  }
}

/* ========================= HTTP handlers ========================= */

async function handleWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  // Verify the secret token Telegram echoes back in this header.
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (env.WEBHOOK_SECRET && secret !== env.WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  // Respond immediately so Telegram doesn't retry; process in the background.
  ctx.waitUntil(handleUpdate(env, update).catch((err) => console.error("update error:", err)));
  return new Response("OK");
}

async function handleRoot(request: Request, env: Env): Promise<Response> {
  const origin = new URL(request.url).origin;

  // Convenience: visiting /?register=1 registers the webhook against this Worker.
  if (new URL(request.url).searchParams.get("register") === "1") {
    const payload: Record<string, unknown> = {
      url: `${origin}/webhook`,
      allowed_updates: ["message"],
    };
    if (env.WEBHOOK_SECRET) payload.secret_token = env.WEBHOOK_SECRET;
    const info = await callApi(env, "setWebhook", payload);
    return Response.json({ ok: true, webhook: `${origin}/webhook`, info });
  }

  const feedCount = (await listFeeds(env)).length;
  return new Response(
    `RSS Feed Reader Bot is running.\nActive feeds: ${feedCount}\n\n` +
      `Register webhook: ${origin}/?register=1`,
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
}

/* ========================== Worker entry ========================== */

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/webhook") return handleWebhook(request, env, ctx);
    if (url.pathname === "/" && request.method === "GET") return handleRoot(request, env);
    return new Response("Not Found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const target = getTargetChatId(env, undefined);
    if (!target) {
      console.error("Scheduled check skipped: no target chat (set DEFAULT_CHAT_ID or ADMIN_USER_ID).");
      return;
    }
    const summary = await checkAllFeeds(env, target);
    console.log("Scheduled check complete:", summary);
  },
};
