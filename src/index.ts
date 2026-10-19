/**
 * Telegram RSS Feed Reader Bot — Cloudflare Worker (feed engine)
 * ==============================================================
 *
 * The project is split across two runtimes:
 *   - Telegram Serverless (tgcloud/) receives Telegram updates, handles the bot
 *     commands, owns the SQLite state (feeds, seen items, admins), and triggers
 *     polls through the userbot scheduler.
 *   - This Worker is now stateless: it fetches/parses feeds, sends article
 *     cards, and exposes only two authenticated engine calls:
 *       /api/feed/preview  fetch/parse a new feed + send confirmation/card
 *       /api/poll          fetch/parse feeds with a supplied seen set and
 *                          return the new ids + per-feed metadata
 *
 * There is no cron trigger and no Worker-to-Serverless call. The Serverless
 * `/check` handler reads its SQLite state, calls /api/poll, then writes the
 * returned seen ids and feed metadata back to SQLite.
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
  TELEGRAM_BOT_TOKEN: string;
  ADMIN_USER_ID: string;
  DEFAULT_CHAT_ID?: string;
  FETCH_OG_IMAGE?: string;
  // Shared secret for the /api/* routes. The Telegram Serverless handlers send
  // it as `Authorization: Bearer <secret>`; the matching value lives in
  // tgcloud/lib/config.js. Set with `wrangler secret put COMMAND_API_SECRET`.
  COMMAND_API_SECRET?: string;
  // Public URL of this Worker (e.g. https://telegram-rss-bot.<subdomain>.workers.dev).
  // Informational: the Telegram webhook is managed by Telegram Serverless now.
  WORKER_URL?: string;
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

interface CheckSummary {
  feeds: number;
  sent: number;
  errors: number;
}

interface MetaUpdate {
  url: string;
  lastChecked: number;
  lastError: string | null;
  itemCount?: number;
}

interface PollResult {
  summary: CheckSummary;
  seen: string[];
  meta: MetaUpdate[];
}

/* ============================= Constants ============================= */

const TELEGRAM_API = "https://api.telegram.org/bot";
const FEED_UA = "Mozilla/5.0 (compatible; TelegramRSSBot/1.0)";
const PAGE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MAX_ITEMS_PER_FEED = 30; // only inspect the newest N items per feed
const MAX_SEND_PER_RUN = 20; // hard cap on messages per check, protects limits
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
  // We intentionally do NOT let the parser expand XML entities. Large Persian
  // feeds (e.g. zoomit.ir) carry tens of thousands of numeric char references
  // (&#8204; zero-width non-joiner, etc.), and fast-xml-parser's entity
  // expansion is single-threaded, synchronous CPU work. Parsing several such
  // feeds in one /api/poll request repeatedly exhausted the Worker CPU budget
  // and the invocation was killed with outcome `exceededResources` — meaning
  // the news never got sent and there was no retry.
  //
  // Instead, we keep raw literal text (entities un-decoded) and decode only the
  // little bit we actually use (see decodeEntities / canonicalId). This makes
  // parsing effectively O(n) and removes the biggest CPU spike.
  processEntities: false,
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

  // processEntities is disabled in the parser for CPU reasons (see above), so
  // literal `&amp;`-style text is left un-decoded. Decode the fields we consume
  // here so downstream code is unaffected: identity (guid) and display (title),
  // plus descriptionHtml because it is HTML and must be a real document for
  // extractImgFromHtml / stripHtml — which both then also decode as a second,
  // harmless pass.
  for (const item of items) {
    item.title = decodeEntities(item.title);
    item.link = decodeEntities(item.link);
    item.guid = decodeEntities(item.guid);
    item.descriptionHtml = decodeEntities(item.descriptionHtml);
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
 * Candidate URLs to try when downloading an image ourselves. Some CDNs
 * (digiato) stream full-size JPEG originals very slowly but serve fast,
 * pre-generated "-WxH" thumbnails. Which sizes exist varies per image (a small
 * source has no "-800x800"), so we try several, largest first, then the
 * original as a final fallback.
 */
export function imageCandidates(url: string): string[] {
  if (!/static\.digiato\.com/i.test(url)) return [url];
  // Already a sized variant — don't add another suffix.
  if (/-\d+x\d+\.(?:jpe?g|png|gif)(?:\?|#|$)/i.test(url)) return [url];
  const sized = (size: string) =>
    url.replace(/\.(jpe?g|png|gif)(?:\?|#|$)/i, `-${size}.$1`);
  return [
    sized("800x800"),
    sized("480x316"),
    sized("350x350"),
    sized("248x248"),
    sized("150x150"),
    url, // full-size original as the final fallback
  ];
}

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
  // Some sites publish a WebP-optimized copy as "photo.jpg.webp". Telegram's
  // sendPhoto rejects WebP, but the original "photo.jpg" (JPEG/PNG/GIF) is
  // usually served at the same URL without the trailing ".webp".
  u = u.replace(/\.(jpe?g|png|gif|bmp|tiff?)\.webp$/i, ".$1");
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
      signal: AbortSignal.timeout(15_000),
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

/** File extension of an image URL (for the multipart filename). */
export function imageExtension(url: string): string {
  const m = url.match(/\.(jpe?g|png|gif|webp|bmp)(?:\?|#|$)/i);
  return m ? m[1].toLowerCase() : "jpg";
}

/** Fetch a single image URL (browser UA) and return its bytes, or null. */
async function fetchImageOnce(url: string): Promise<ArrayBuffer | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": PAGE_UA,
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!type.startsWith("image/")) return null;
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > 5_000_000) return null; // Telegram photo cap is 10 MB; keep margin
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

/**
 * Download an image ourselves (browser UA), trying thumbnail candidates first.
 * Needed when a host's image CDN throttles or blocks Telegram's own fetcher
 * (e.g. digiato's static CDN). Returns the raw bytes, or null on total failure.
 */
export async function fetchImageBytes(url: string): Promise<ArrayBuffer | null> {
  for (const candidate of imageCandidates(url)) {
    const bytes = await fetchImageOnce(candidate);
    if (bytes) return bytes;
  }
  return null;
}

/** Upload raw image bytes to Telegram as a photo (multipart/form-data). */
export async function sendPhotoUpload(
  env: Env,
  chatId: number,
  photoUrl: string,
  imageBytes: ArrayBuffer,
  caption: string,
  replyMarkup?: Record<string, unknown>,
): Promise<any> {
  const ext = imageExtension(photoUrl);
  const mime =
    ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/jpeg";
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", new Blob([imageBytes], { type: mime }), `image.${ext}`);
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  if (replyMarkup) form.append("reply_markup", JSON.stringify(replyMarkup));
  const res = await fetch(`${TELEGRAM_API}${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    body: form,
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(`Telegram sendPhoto failed (${res.status}): ${data.description ?? "unknown"}`);
  }
  return data.result;
}

/* ======================== Feed fetching / polling ======================== */

async function fetchAndParse(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": FEED_UA,
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    },
    redirect: "follow",
    // A stalled feed must not hold the poll open until the platform kills it.
    signal: AbortSignal.timeout(15_000),
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

/**
 * Build an HTML caption that always fits Telegram's 1024-char photo limit.
 * Every component is escaped and truncated before it is wrapped in a tag, so
 * the final string can never end in the middle of an entity or an HTML tag
 * (which Telegram rejects with 400 "can't parse entities").
 */
export function buildCaption(title: string, body: string, feedTitle?: string): string {
  // Reserve room for the wrapping tags plus the ellipsis.
  const escapedTitle = escapeHtml(title);
  const titleText = truncateEscaped(escapedTitle, CAPTION_MAX - 8);
  const header = `<b>${titleText}${titleText.length < escapedTitle.length ? "…" : ""}</b>`;

  // Drop the footer rather than overflow when the title alone is huge.
  const footer = feedTitle ? `\n\n<i>${escapeHtml(feedTitle)}</i>` : "";
  const safeFooter =
    footer && header.length + footer.length <= CAPTION_MAX ? footer : "";

  const budget = Math.max(0, CAPTION_MAX - header.length - safeFooter.length);
  let bodyText = escapeHtml(body);
  if (bodyText.length + 4 > budget) {
    const max = budget - 4 - 1; // reserve the "\n\n" separator + "…" ellipsis
    bodyText = max > 0 ? truncateEscaped(bodyText, max) + "…" : "";
  }

  let caption = header;
  if (bodyText) caption += `\n\n${bodyText}`;
  return caption + safeFooter;
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
    // 1. Let Telegram fetch the image URL directly (fastest; works for most hosts).
    try {
      await sendPhoto(env, chatId, photoUrl, caption, replyMarkup);
      return true;
    } catch (err) {
      console.error("sendPhoto(url) failed, trying proxy upload:", err);
    }
    // 2. Some image CDNs throttle/block Telegram's fetcher. Download the image
    //    ourselves and upload the bytes via multipart/form-data.
    const bytes = await fetchImageBytes(photoUrl);
    if (bytes) {
      try {
        await sendPhotoUpload(env, chatId, photoUrl, bytes, caption, replyMarkup);
        return true;
      } catch (err) {
        console.error("sendPhoto(upload) failed:", err);
      }
    }
  }
  try {
    await sendMessage(env, chatId, caption, {
      parse_mode: "HTML",
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  } catch (err) {
    // A malformed item must not block the feed forever (the item stays unseen
    // and would be retried on every poll). Fall back to unformatted text.
    console.error("sendMessage(HTML) failed, retrying as plain text:", err);
    const plain = truncate(
      [title, body, feedTitle].filter(Boolean).join("\n\n"),
      4_000,
    );
    await sendMessage(env, chatId, plain || title, {
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }
  return true;
}

/**
 * Process one feed: send unseen items (up to `budget`) and collect their ids.
 *
 * The seen set is modified in place and `newSeen` collects this run's ids. An
 * id is added before sending and rolled back if the send throws, so a
 * successfully delivered article is never delivered twice, while a failed send
 * is retried on the next poll.
 */
async function processFeed(
  env: Env,
  feed: FeedInfo,
  chatId: number,
  budget: number,
  seenSet: Set<string>,
  newSeen: string[],
): Promise<{ sent: number; itemCount: number }> {
  const parsed = await fetchAndParse(feed.url);
  const items = extractItems(parsed).slice(0, MAX_ITEMS_PER_FEED);
  let sent = 0;

  for (const item of items) {
    const rawId = getItemRawId(item);
    if (!rawId) continue;
    const itemId = await sha256Hex(canonicalId(rawId));
    if (seenSet.has(itemId)) continue; // already posted
    if (sent >= budget) break;
    seenSet.add(itemId);
    newSeen.push(itemId);
    try {
      await sendArticle(env, chatId, item, feed.title);
      sent++;
    } catch (err) {
      // Keep the item unseen so the next poll retries it.
      seenSet.delete(itemId);
      newSeen.pop();
      throw err;
    }
  }

  return { sent, itemCount: items.length };
}

/**
 * Stateless poll: fetch/parse the supplied feeds, send new article cards, and
 * return the ids that were delivered plus the per-feed metadata. The caller
 * (Telegram Serverless) owns persistence.
 */
async function pollFeeds(
  env: Env,
  feeds: FeedInfo[],
  seen: string[],
  chatId?: number,
): Promise<PollResult> {
  const target = getTargetChatId(env, chatId);
  if (!target) {
    throw new ApiError("No target chat configured (set DEFAULT_CHAT_ID or ADMIN_USER_ID).", 409);
  }

  const seenSet = new Set(seen);
  const newSeen: string[] = [];
  const meta: MetaUpdate[] = [];
  const summary: CheckSummary = { feeds: feeds.length, sent: 0, errors: 0 };
  let budget = MAX_SEND_PER_RUN;

  for (const feed of feeds) {
    if (budget <= 0) break;
    try {
      const { sent, itemCount } = await processFeed(env, feed, target, budget, seenSet, newSeen);
      summary.sent += sent;
      budget -= sent;
      meta.push({ url: feed.url, lastChecked: Date.now(), lastError: null, itemCount });
    } catch (err) {
      summary.errors++;
      meta.push({
        url: feed.url,
        lastChecked: Date.now(),
        lastError: String((err as Error)?.message ?? err).slice(0, 200),
        itemCount: feed.itemCount,
      });
    }
  }

  return { summary, seen: newSeen, meta };
}

/* ====================== Admin authorization ====================== */

function envAdminIds(env: Env): number[] {
  return (env.ADMIN_USER_ID ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * Telegram chat IDs are negative for groups and channels, so never require a
 * positive number here. `0` is not a valid chat ID.
 */
function parseChatId(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isSafeInteger(n) && n !== 0 ? n : undefined;
}

function getTargetChatId(
  env: Env,
  fallbackChatId?: number,
): number | undefined {
  // Prefer an explicit destination. ADMIN_USER_ID is the bootstrap recipient
  // when the Serverless config does not send a chatId.
  return (
    parseChatId(env.DEFAULT_CHAT_ID) ??
    parseChatId(fallbackChatId) ??
    envAdminIds(env)[0]
  );
}

/* =================== Command API (Telegram Serverless) =================== */

/**
 * Bot commands now run on Telegram Serverless (see tgcloud/). Feeds, seen items
 * and admins live there; the Worker exposes only the feed engine calls below.
 *
 * Every route requires the shared COMMAND_API_SECRET (Workers secret + the
 * matching constant in tgcloud/lib/config.js).
 */

class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function apiJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function apiError(message: string, status = 400): Response {
  return apiJson({ ok: false, error: message }, status);
}

async function readJson(request: Request): Promise<Record<string, any>> {
  try {
    const value = await request.json();
    return value && typeof value === "object" ? (value as Record<string, any>) : {};
  } catch {
    return {};
  }
}

/**
 * Fetch/parse a new feed, send the add confirmation + first article card, and
 * return the hashes of its current items. The Serverless store inserts the
 * feed and marks those hashes seen, so history is never replayed.
 */
async function previewFeed(env: Env, rawUrl: string, chatId?: number) {
  if (!rawUrl) throw new ApiError("Usage: /add <url>", 400);

  const url = normalizeUrl(rawUrl);
  if (!/^https?:\/\//i.test(url)) throw new ApiError("❌ Invalid URL.", 400);

  let parsed: any;
  try {
    parsed = await fetchAndParse(url);
  } catch (err) {
    throw new ApiError(
      `❌ Could not fetch feed: ${String((err as Error)?.message ?? err)}`,
      502,
    );
  }

  const items = extractItems(parsed);
  if (items.length === 0) {
    throw new ApiError("❌ No <item>/<entry> elements found — not a valid RSS/Atom feed?", 422);
  }

  const title = stripHtml(extractFeedTitle(parsed)) || url;
  const seenIds: string[] = [];
  for (const item of items.slice(0, MAX_ITEMS_PER_FEED)) {
    const rawId = getItemRawId(item);
    if (rawId) seenIds.push(await sha256Hex(canonicalId(rawId)));
  }

  if (chatId) {
    // Confirmation and preview are Telegram messages, so they stay here — the
    // only place that knows how to build an article card.
    try {
      await sendMessage(
        env,
        chatId,
        `✅ Feed added: <b>${escapeHtml(title)}</b>\n${url}\n` +
          `${items.length} item(s) found (existing items marked as read).`,
        { parse_mode: "HTML" },
      );
      await sendArticle(env, chatId, items[0], title);
    } catch (err) {
      console.error("feed added, but confirmation/preview failed:", err);
    }
  }

  return { url, title, itemCount: items.length, seenIds };
}

/** Routes under /api/*, called by the Telegram Serverless command handlers. */
async function handleCommandApi(request: Request, env: Env): Promise<Response> {
  const expected = env.COMMAND_API_SECRET;
  const auth = request.headers.get("Authorization") ?? "";
  if (!expected || auth !== `Bearer ${expected}`) {
    return apiError("Unauthorized", 401);
  }

  const { pathname } = new URL(request.url);
  const route = pathname.replace(/^\/api/, "").replace(/\/+$/, "") || "/";
  const method = request.method;

  try {
    if (route === "/feed/preview" && method === "POST") {
      const body = await readJson(request);
      const feed = await previewFeed(
        env,
        String(body.url ?? ""),
        parseChatId(body.chatId),
      );
      return apiJson({ ok: true, feed });
    }

    if (route === "/poll" && method === "POST") {
      const body = await readJson(request);
      const feeds = Array.isArray(body.feeds)
        ? (body.feeds.filter(
            (feed: any) =>
              feed && typeof feed.url === "string" && feed.url.trim().length > 0,
          ) as FeedInfo[])
        : [];
      const seen = Array.isArray(body.seen)
        ? body.seen.filter((id: unknown) => typeof id === "string")
        : [];

      if (feeds.length === 0) {
        return apiJson({ ok: true, summary: { feeds: 0, sent: 0, errors: 0 }, seen: [], meta: [] });
      }

      const result = await pollFeeds(env, feeds, seen, parseChatId(body.chatId));
      return apiJson({ ok: true, ...result });
    }

    return apiError("Not found", 404);
  } catch (err) {
    if (err instanceof ApiError) return apiError(err.message, err.status);
    console.error("Command API error:", err);
    return apiError("Internal error", 500);
  }
}

async function handleRoot(request: Request, env: Env): Promise<Response> {
  return new Response(
    `RSS Feed Reader Bot feed engine is running.\n\n` +
      `Commands, feeds and seen state live on Telegram Serverless; polls are ` +
      `triggered from there (userbot scheduler) through /api/poll.`,
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
}

/* ========================== Worker entry ========================== */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleCommandApi(request, env);
    if (url.pathname === "/" && request.method === "GET") return handleRoot(request, env);
    return new Response("Not Found", { status: 404 });
  },
};
