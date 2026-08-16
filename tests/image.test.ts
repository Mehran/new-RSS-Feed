import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseXml,
  extractItems,
  extractImageFromFeed,
  extractImgFromHtml,
  fetchPageImage,
  extractMetaImage,
  cleanupImageUrl,
  resolveArticleImage,
  stripHtml,
  decodeEntities,
  escapeHtml,
  truncate,
  isImageUrl,
  stripFeedBoilerplate,
  cleanBody,
  buildCaption,
} from "../src/index";

/* Feed with the article images in every supported location. */
const RSS_WITH_IMAGES = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:media="http://search.yahoo.com/mrss/"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Images</title>
    <item>
      <title>Media content</title>
      <link>https://example.com/m</link>
      <media:content url="https://cdn.example.com/media.jpg" medium="image"/>
    </item>
    <item>
      <title>Thumbnail only</title>
      <link>https://example.com/t</link>
      <media:thumbnail url="https://cdn.example.com/thumb.jpg"/>
    </item>
    <item>
      <title>Enclosure image</title>
      <link>https://example.com/e</link>
      <enclosure url="https://cdn.example.com/enclosure.png" type="image/png"/>
    </item>
    <item>
      <title>Inline img</title>
      <link>https://example.com/i</link>
      <content:encoded><![CDATA[<p>Hi</p><img src="https://cdn.example.com/inline.webp"/>]]></content:encoded>
    </item>
    <item>
      <title>No image</title>
      <link>https://example.com/n</link>
      <description><![CDATA[<p>Just text.</p>]]></description>
    </item>
  </channel>
</rss>`;

describe("extractImageFromFeed", () => {
  it("picks RSS item-level <image><url> (digiato format)", () => {
    expect(extractImageFromFeed({ image: { url: "https://cdn.example.com/item.jpg.webp" } }))
      .toBe("https://cdn.example.com/item.jpg.webp");
  });

  it("picks <media:content medium=\"image\">", () => {
    expect(extractImageFromFeed({ "media:content": { "@_url": "https://cdn.example.com/m.jpg", "@_medium": "image" } }))
      .toBe("https://cdn.example.com/m.jpg");
  });

  it("skips non-image media:content and falls through to enclosure", () => {
    expect(
      extractImageFromFeed({
        "media:content": { "@_url": "https://cdn.example.com/v.mp4", "@_medium": "video" },
        enclosure: { "@_url": "https://cdn.example.com/e.jpg", "@_type": "image/jpeg" },
      }),
    ).toBe("https://cdn.example.com/e.jpg");
  });

  it("handles repeated media:content and selects the image entry", () => {
    expect(
      extractImageFromFeed({
        "media:content": [
          { "@_url": "https://cdn.example.com/v.mp4", "@_medium": "video" },
          { "@_url": "https://cdn.example.com/m.jpg", "@_medium": "image" },
        ],
      }),
    ).toBe("https://cdn.example.com/m.jpg");
  });

  it("uses <media:thumbnail> when present", () => {
    expect(extractImageFromFeed({ "media:thumbnail": { "@_url": "https://cdn.example.com/t.jpg" } }))
      .toBe("https://cdn.example.com/t.jpg");
  });

  it("accepts an image enclosure but rejects audio", () => {
    expect(extractImageFromFeed({ enclosure: { "@_url": "https://cdn.example.com/a.mp3", "@_type": "audio/mpeg" } }))
      .toBeNull();
    expect(extractImageFromFeed({ enclosure: { "@_url": "https://cdn.example.com/e.png", "@_type": "image/png" } }))
      .toBe("https://cdn.example.com/e.png");
  });

  it("returns null when the node has no image", () => {
    expect(extractImageFromFeed({})).toBeNull();
    expect(extractImageFromFeed(null)).toBeNull();
  });

  it("works end-to-end against a parsed feed", () => {
    const items = extractItems(parseXml(RSS_WITH_IMAGES));
    expect(extractImageFromFeed(items[0].raw)).toBe("https://cdn.example.com/media.jpg");
    expect(extractImageFromFeed(items[1].raw)).toBe("https://cdn.example.com/thumb.jpg");
    expect(extractImageFromFeed(items[2].raw)).toBe("https://cdn.example.com/enclosure.png");
    expect(extractImageFromFeed(items[3].raw)).toBeNull(); // <img> lives in HTML, not raw node
    expect(extractImageFromFeed(items[4].raw)).toBeNull();
  });
});

describe("extractImgFromHtml", () => {
  it("extracts a double-quoted img src", () => {
    expect(extractImgFromHtml('<p>hi</p><img src="https://cdn.example.com/a.jpg"/>'))
      .toBe("https://cdn.example.com/a.jpg");
  });

  it("extracts a single-quoted img src", () => {
    expect(extractImgFromHtml("<img class='x' src='https://cdn.example.com/b.png'>"))
      .toBe("https://cdn.example.com/b.png");
  });

  it("decodes entities in the src", () => {
    expect(extractImgFromHtml('<img src="https://cdn.example.com/c.jpg?a=1&amp;b=2"/>'))
      .toBe("https://cdn.example.com/c.jpg?a=1&b=2");
  });

  it("upgrades protocol-relative URLs to https", () => {
    expect(extractImgFromHtml('<img src="//cdn.example.com/d.jpg"/>'))
      .toBe("https://cdn.example.com/d.jpg");
  });

  it("ignores relative URLs and missing images", () => {
    expect(extractImgFromHtml('<img src="/images/x.jpg"/>')).toBeNull();
    expect(extractImgFromHtml("<p>no image</p>")).toBeNull();
    expect(extractImgFromHtml("")).toBeNull();
  });
});

describe("fetchPageImage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("extracts og:image from article HTML", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        '<html><head><meta property="og:image" content="https://cdn.example.com/og.jpg"></head></html>',
        { headers: { "content-type": "text/html" } },
      )),
    );
    await expect(fetchPageImage("https://example.com/post")).resolves.toBe(
      "https://cdn.example.com/og.jpg",
    );
  });

  it("resolves a relative og:image against the page URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        '<html><head><meta property="og:image" content="/images/og.jpg"></head></html>',
        { headers: { "content-type": "text/html" } },
      )),
    );
    await expect(fetchPageImage("https://example.com/post")).resolves.toBe(
      "https://example.com/images/og.jpg",
    );
  });

  it("falls back to twitter:image", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        '<html><head><meta name="twitter:image" content="https://cdn.example.com/tw.jpg"></head></html>',
        { headers: { "content-type": "text/html" } },
      )),
    );
    await expect(fetchPageImage("https://example.com/post")).resolves.toBe(
      "https://cdn.example.com/tw.jpg",
    );
  });

  it("returns null on non-HTML responses or fetch errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("binary", { headers: { "content-type": "application/octet-stream" } })),
    );
    await expect(fetchPageImage("https://example.com/post")).resolves.toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    await expect(fetchPageImage("https://example.com/post")).resolves.toBeNull();
  });
});

describe("cleanupImageUrl", () => {
  it("decodes entities and absolutizes protocol-relative URLs", () => {
    expect(cleanupImageUrl("//cdn.example.com/a.jpg")).toBe("https://cdn.example.com/a.jpg");
    expect(cleanupImageUrl("https://cdn.example.com/a.jpg?x=1&amp;y=2"))
      .toBe("https://cdn.example.com/a.jpg?x=1&y=2");
  });

  it("resolves relative URLs against a base", () => {
    expect(cleanupImageUrl("/img/a.jpg", "https://example.com/path/page"))
      .toBe("https://example.com/img/a.jpg");
    expect(cleanupImageUrl("img/a.jpg", "https://example.com/path/page"))
      .toBe("https://example.com/path/img/a.jpg");
  });

  it("returns null for relative URLs without a base", () => {
    expect(cleanupImageUrl("/img/a.jpg")).toBeNull();
  });

  it("drops non-http schemes and tracking pixels", () => {
    expect(cleanupImageUrl("data:image/gif;base64,AAAA")).toBeNull();
    expect(cleanupImageUrl("https://example.com/pixel.gif")).toBeNull();
    expect(cleanupImageUrl("https://example.com/1x1.gif")).toBeNull();
    expect(cleanupImageUrl("https://example.com/tracking.gif")).toBeNull();
    expect(cleanupImageUrl("https://example.com/photo.gif")).toBe("https://example.com/photo.gif");
  });
});

describe("extractMetaImage", () => {
  const base = "https://example.com/post";

  it("extracts og:image", () => {
    expect(extractMetaImage('<meta property="og:image" content="https://cdn.example.com/og.jpg"/>', base))
      .toBe("https://cdn.example.com/og.jpg");
  });

  it("extracts twitter:image", () => {
    expect(extractMetaImage('<meta name="twitter:image" content="https://cdn.example.com/tw.jpg"/>', base))
      .toBe("https://cdn.example.com/tw.jpg");
  });

  it("extracts link rel=image_src", () => {
    expect(extractMetaImage('<link rel="image_src" href="https://cdn.example.com/l.jpg"/>', base))
      .toBe("https://cdn.example.com/l.jpg");
  });

  it("resolves relative og:image against base", () => {
    expect(extractMetaImage('<meta property="og:image" content="/img/og.jpg"/>', base))
      .toBe("https://example.com/img/og.jpg");
  });

  it("returns null when no meta image present", () => {
    expect(extractMetaImage("<html><body>hi</body></html>", base)).toBeNull();
  });
});

describe("resolveArticleImage", () => {
  afterEach(() => vi.unstubAllGlobals());

  const item = (raw: any, descriptionHtml = "", link = "https://example.com/post") =>
    ({ title: "T", link, guid: "g", descriptionHtml, pubDate: "", raw } as any);

  it("returns a feed image without fetching the page", async () => {
    const img = await resolveArticleImage(
      {} as any,
      item({ "media:content": { "@_url": "https://cdn.example.com/m.jpg", "@_medium": "image" } }),
    );
    expect(img).toBe("https://cdn.example.com/m.jpg");
  });

  it("falls back to <img> in content:encoded", async () => {
    const img = await resolveArticleImage(
      {} as any,
      item({}, '<p>hi</p><img src="https://cdn.example.com/i.png"/>'),
    );
    expect(img).toBe("https://cdn.example.com/i.png");
  });

  it("fetches the page when the feed has no image", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        '<meta property="og:image" content="https://cdn.example.com/og.jpg"/>',
        { headers: { "content-type": "text/html" } },
      )),
    );
    const img = await resolveArticleImage({} as any, item({}, ""));
    expect(img).toBe("https://cdn.example.com/og.jpg");
  });

  it("skips the page fetch when FETCH_OG_IMAGE=false", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const img = await resolveArticleImage({ FETCH_OG_IMAGE: "false" } as any, item({}, ""));
    expect(img).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("stripFeedBoilerplate / cleanBody", () => {
  it("removes English 'first appeared on' footer", () => {
    expect(stripFeedBoilerplate("A great article. The post A great article first appeared on Example Site."))
      .toBe("A great article.");
  });

  it("removes the 'appeared first on' variant", () => {
    expect(stripFeedBoilerplate("Body text. The post Something appeared first on Example."))
      .toBe("Body text.");
  });

  it("removes the Persian footer", () => {
    expect(stripFeedBoilerplate("متن مقاله. نوشته متن مقاله اولین بار در سایت نمونه پدیدار شد."))
      .toBe("متن مقاله.");
  });

  it("cleanBody strips HTML, removes boilerplate, and truncates to 300", () => {
    expect(cleanBody("<p>Hello <strong>world</strong></p><p>The post Hello world first appeared on Site.</p>"))
      .toBe("Hello world");
    expect(cleanBody(`<p>${"a".repeat(1000)}</p>`)).toHaveLength(301); // 300 chars + ellipsis
  });
});

describe("buildCaption", () => {
  it("builds title + body + footer", () => {
    expect(buildCaption("My Title", "Some body.", "Feed"))
      .toBe("<b>My Title</b>\n\nSome body.\n\n<i>Feed</i>");
  });

  it("never exceeds the caption limit, even with entity-heavy input", () => {
    const caption = buildCaption("&".repeat(180), "&".repeat(5000), "&".repeat(100));
    expect(caption.length).toBeLessThanOrEqual(950);
  });
});

describe("stripHtml / decodeEntities", () => {
  it("strips tags, scripts and styles", () => {
    expect(stripHtml('<p>Hello <strong>world</strong></p><script>alert(1)</script>'))
      .toBe("Hello world");
    expect(stripHtml("<style>.x{}</style><div>text</div>")).toBe("text");
  });

  it("turns <br> and block endings into newlines", () => {
    expect(stripHtml("<p>line1</p><p>line2</p>")).toBe("line1\nline2");
    expect(stripHtml("a<br>b")).toBe("a\nb");
  });

  it("decodes named and numeric entities", () => {
    expect(stripHtml("Tom &amp; Jerry &mdash; fun")).toBe("Tom & Jerry — fun");
    expect(decodeEntities("&amp;&lt;&gt;&nbsp;&mdash;&#65;&#x42;")).toBe("&<> —AB");
  });

  it("collapses whitespace", () => {
    expect(stripHtml("<p>  a   b  </p>")).toBe("a b");
  });
});

describe("escapeHtml / truncate / isImageUrl", () => {
  it("escapes HTML for Telegram parse mode", () => {
    expect(escapeHtml("<b>&</b>")).toBe("&lt;b&gt;&amp;&lt;/b&gt;");
  });

  it("truncates on word boundaries", () => {
    expect(truncate("hello world foo", 8)).toBe("hello…");
    expect(truncate("abcdefghij", 5)).toBe("abcde…");
    expect(truncate("short", 100)).toBe("short");
  });

  it("detects image URLs by extension", () => {
    expect(isImageUrl("https://x.com/a.jpg")).toBe(true);
    expect(isImageUrl("https://x.com/a.jpg?w=1")).toBe(true);
    expect(isImageUrl("https://x.com/a.mp3")).toBe(false);
    expect(isImageUrl("https://x.com/feed")).toBe(false);
  });
});
