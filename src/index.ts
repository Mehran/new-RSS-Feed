/**
 * Telegram RSS Feed Reader Bot — Cloudflare Worker (engine)
 * ========================================================
 *
 * The project is split across two runtimes:
 *   - Telegram Serverless (tgcloud/) receives Telegram updates and handles the
 *     bot commands. It is stateless and calls the /api/* routes below.
 *   - This Worker owns state, polling and message delivery:
 *       /api/*            authenticated JSON API used by the Serverless layer
 *       /internal/check   a full polling run (the cron relay target)
 *       scheduled         cron trigger -> dispatcher -> /internal/check
 *
 * Telegram Serverless has no cron and no public HTTP endpoint, which is why
 * polling stays here.
 *
 * State lives in Cloudflare KV:
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
  // Legacy fallback for INTERNAL_POLL_SECRET; no longer set by deploy.sh.
  WEBHOOK_SECRET?: string;
  DEFAULT_CHAT_ID?: string;
  FETCH_OG_IMAGE?: string;
  // Shared secret for the /api/* routes. The Telegram Serverless handlers send
  // it as `Authorization: Bearer <secret>`; the matching value lives in
  // tgcloud/lib/config.js. Set with `wrangler secret put COMMAND_API_SECRET`.
  COMMAND_API_SECRET?: string;
  // Public URL of this Worker (e.g. https://telegram-rss-bot.<subdomain>.workers.dev).
  // Informational: the Telegram webhook is managed by Telegram Serverless now.
  WORKER_URL?: string;
  // Dedicated secret for the /internal/check endpoint. The cron trigger cannot
  // fetch this Worker's own URL (Cloudflare error 1042: a Worker may not invoke
  // itself), so the scheduled handler instead pings a separate "dispatcher"
  // Worker, which calls back into /internal/check. INTERNAL_POLL_SECRET is
  // shared between this Worker and the dispatcher. Falls back to WEBHOOK_SECRET
  // for backwards compatibility.
  INTERNAL_POLL_SECRET?: string;
  // URL of the dispatcher Worker (https://rss-dispatcher.<subdomain>.workers.dev).
  // The cron trigger POSTs to its /trigger endpoint, which relays the request
  // back here as a normal HTTP fetch (NOT bound by the 10ms Cron CPU cap on the
  // free plan). If unset, scheduled polling is skipped.
  DISPATCHER_URL?: string;
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
  // We intentionally do NOT let the parser expand XML entities. Large Persian
  // feeds (e.g. zoomit.ir) carry tens of thousands of numeric char references
  // (&#8204; zero-width non-joiner, etc.), and fast-xml-parser's entity
  // expansion is single-threaded, synchronous CPU work that runs inside the
  // `scheduled` handler. On the Workers free plan a Cron Trigger is capped at
  // 10 ms of CPU, so that expansion alone repeatedly exhausted the budget and
  // the invocation was killed with outcome `exceededResources` — meaning the
  // news never got sent and there was no retry.
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

/**
 * Telegram chat IDs are negative for groups and channels, so never require a
 * positive number here. `0` is not a valid chat ID.
 */
function parseChatId(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isSafeInteger(n) && n !== 0 ? n : undefined;
}

async function getTargetChatId(
  env: Env,
  fallbackChatId?: number,
): Promise<number | undefined> {
  const configured = parseChatId(env.DEFAULT_CHAT_ID);
  if (configured) return configured;

  const fallback = parseChatId(fallbackChatId);
  if (fallback) return fallback;

  // ADMIN_USER_ID may only cover the bootstrap admin; also consult KV so the
  // cron still has a recipient after admins are managed with /admin.
  return (await getAdmins(env))[0];
}

/* =================== Command API (Telegram Serverless) =================== */

/**
 * Bot commands now run on Telegram Serverless (see tgcloud/). Those handlers
 * are stateless: they authorize the Telegram user, then call these JSON
 * endpoints to read/write KV and trigger a poll.
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Add a feed, mark its current items as seen, and optionally send a preview. */
async function addFeed(env: Env, rawUrl: string, chatId?: number) {
  if (!rawUrl) throw new ApiError("Usage: /add <url>", 400);

  const url = normalizeUrl(rawUrl);
  if (!/^https?:\/\//i.test(url)) throw new ApiError("❌ Invalid URL.", 400);

  if (await env.RSS_FEEDS.get(feedKey(url))) {
    throw new ApiError("⚠️ That feed is already added.", 409);
  }

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
  const feed: FeedInfo = {
    url,
    title,
    addedAt: Date.now(),
    lastChecked: Date.now(),
    lastError: null,
    itemCount: items.length,
  };
  await env.RSS_FEEDS.put(feedKey(url), JSON.stringify(feed));

  // Backfill-silence: existing items are marked as read so history isn't spammed.
  for (const item of items.slice(0, MAX_ITEMS_PER_FEED)) {
    const rawId = getItemRawId(item);
    if (rawId) await markSeen(env, rawId);
  }

  if (chatId) {
    // Confirmation and preview are Telegram messages, so they stay in the
    // Worker — the only place that knows how to build an article card.
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

  return { url, title, itemCount: items.length };
}

/** Remove a feed by 1-based /list index or by URL. */
async function removeFeed(env: Env, arg: string) {
  if (!arg) throw new ApiError("Usage: /remove <url> or /remove <index>", 400);

  if (/^\d+$/.test(arg)) {
    const feeds = await listFeeds(env);
    const feed = feeds[Number(arg) - 1];
    if (!feed) throw new ApiError("❌ No feed at that index.", 404);
    await env.RSS_FEEDS.delete(feedKey(feed.url));
    return { url: feed.url, title: feed.title };
  }

  const url = normalizeUrl(arg);
  const existing = await env.RSS_FEEDS.get(feedKey(url));
  if (!existing) {
    throw new ApiError("❌ Feed not found. Use /list to see active feeds.", 404);
  }
  let title = url;
  try {
    title = (JSON.parse(existing) as FeedInfo).title || url;
  } catch {
    /* keep the URL as the title */
  }
  await env.RSS_FEEDS.delete(feedKey(url));
  return { url, title };
}

/** Update the admin list in KV and return the new list. */
async function setAdmin(env: Env, userId: number, add: boolean): Promise<number[]> {
  const admins = new Set(await getAdmins(env));
  if (add) admins.add(userId);
  else admins.delete(userId);
  const list = [...admins];
  await env.RSS_SETTINGS.put("admins", JSON.stringify(list));
  return list;
}

/** Routes under /api/*, called by the Telegram Serverless command handlers. */
async function handleCommandApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const expected = env.COMMAND_API_SECRET;
  const auth = request.headers.get("Authorization") ?? "";
  if (!expected || auth !== `Bearer ${expected}`) {
    return apiError("Unauthorized", 401);
  }

  const { pathname } = new URL(request.url);
  const route = pathname.replace(/^\/api/, "").replace(/\/+$/, "") || "/";
  const method = request.method;

  try {
    if (route === "/admins" && method === "GET") {
      return apiJson({ ok: true, admins: await getAdmins(env) });
    }

    if (route === "/admins" && method === "POST") {
      const body = await readJson(request);
      const userId = Number(body.userId);
      if (!Number.isInteger(userId) || userId <= 0) {
        return apiError("Usage: /admin <user_id>", 400);
      }
      const add = body.add !== false;
      const admins = await setAdmin(env, userId, add);
      return apiJson({ ok: true, admins, added: add });
    }

    if (route === "/feeds" && method === "GET") {
      return apiJson({ ok: true, feeds: await listFeeds(env) });
    }

    if (route === "/feeds" && method === "POST") {
      const body = await readJson(request);
      const feed = await addFeed(
        env,
        String(body.url ?? ""),
        parseChatId(body.chatId),
      );
      return apiJson({ ok: true, feed });
    }

    if (route === "/feeds/remove" && method === "POST") {
      const body = await readJson(request);
      const removed = await removeFeed(env, String(body.arg ?? ""));
      return apiJson({ ok: true, removed });
    }

    if (route === "/check" && method === "POST") {
      const body = await readJson(request);
      const target = await getTargetChatId(env, parseChatId(body.chatId));
      if (!target) {
        return apiError(
          "❌ No target chat configured (set DEFAULT_CHAT_ID or ADMIN_USER_ID).",
          409,
        );
      }

      // A full poll can outlive the Serverless handler's budget. Keep it alive
      // with waitUntil, but wait only ~20s for a summary; otherwise report that
      // it is still running (the article cards arrive on their own).
      const run = checkAllFeeds(env, target);
      ctx.waitUntil(run.catch((err) => console.error("API check failed:", err)));
      const summary = await Promise.race([run, sleep(20_000).then(() => null)]);
      if (!summary) return apiJson({ ok: true, pending: true });
      return apiJson({ ok: true, ...summary });
    }

    return apiError("Not found", 404);
  } catch (err) {
    if (err instanceof ApiError) return apiError(err.message, err.status);
    console.error("Command API error:", err);
    return apiError("Internal error", 500);
  }
}

async function handleRoot(request: Request, env: Env): Promise<Response> {
  const feedCount = (await listFeeds(env)).length;
  return new Response(
    `RSS Feed Reader Bot is running.\nActive feeds: ${feedCount}\n\n` +
      `Commands are handled by Telegram Serverless; polling runs on the cron trigger.`,
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
}

/* ========================== Worker entry ========================== */

const INTERNAL_POLL_SECRET_HEADER = "X-Internal-Poll-Secret";

/**
 * A Cron Trigger on the Workers free plan is capped at 10ms of CPU per run.
 * Polling 14 RSS feeds (parsing large Persian feeds, leafing og:image pages,
 * uploading photos) needs hundreds of ms of CPU, so a cron that does that work
 * directly is always killed with outcome `exceededResources` and never sends
 * news. A normal HTTP invocation (including the Serverless `/check`) is not
 * bound by the same 10ms cap.
 *
 * Workaround: the `scheduled` handler does almost no work — it POSTs to a
 * separate dispatcher Worker (`rss-dispatcher`), which relays the request back
 * to this Worker's `/internal/check` endpoint as a normal HTTP fetch with the
 * full CPU budget, so the heavy polling actually completes. Fetching a Worker
 * on the same workers.dev zone requires the `global_fetch_strictly_public`
 * compatibility flag (set in wrangler.toml) — without it Cloudflare rejects
 * the cross-worker fetch with error 1042. See `scheduled` below.
 */
async function handleInternalCheck(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get(INTERNAL_POLL_SECRET_HEADER);
  const expected = env.INTERNAL_POLL_SECRET || env.WEBHOOK_SECRET;
  if (!expected || secret !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }
  const target = await getTargetChatId(env);
  if (!target) {
    const summary: CheckSummary = { feeds: 0, sent: 0, errors: 1 };
    console.error("Internal check skipped: no target chat (set DEFAULT_CHAT_ID or ADMIN_USER_ID).");
    return Response.json(summary);
  }
  const summary = await checkAllFeeds(env, target);
  console.log("Internal check complete:", summary);
  return Response.json(summary);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleCommandApi(request, env, ctx);
    if (url.pathname === "/internal/check" && request.method === "POST") {
      return handleInternalCheck(request, env);
    }
    if (url.pathname === "/" && request.method === "GET") return handleRoot(request, env);
    return new Response("Not Found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // The cron slot only has 10ms of CPU on the free plan (see comment above),
    // so we must not poll the feeds in here, and cross-worker fetches on the
    // same zone need the global_fetch_strictly_public compatibility flag
    // (set in wrangler.toml). We ping the dispatcher Worker, which relays the
    // request to our /internal/check endpoint as a normal HTTP fetch with the
    // full CPU budget. Errors are reported to the logs.
    const dispatcherUrl = env.DISPATCHER_URL;
    if (!dispatcherUrl) {
      console.error(
        "Scheduled check skipped: DISPATCHER_URL is not set. Polling can't be relayed.",
      );
      return;
    }

    ctx.waitUntil(
      (async () => {
        try {
          const res = await fetch(new URL("/trigger", dispatcherUrl).toString(), {
            method: "POST",
            headers: {
              [INTERNAL_POLL_SECRET_HEADER]: env.INTERNAL_POLL_SECRET ?? "",
              "Content-Type": "application/json",
            },
          });
          if (!res.ok) {
            console.error("Dispatch returned", res.status, await res.text().catch(() => ""));
          }
        } catch (err) {
          console.error("Dispatch fetch failed:", (err as Error)?.message ?? err);
        }
      })(),
    );
  },
};
