import { describe, it, expect } from "vitest";
import {
  parseXml,
  extractItems,
  extractFeedTitle,
  textOf,
  atomLink,
  canonicalId,
  normalizeUrl,
} from "../src/index";

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:media="http://search.yahoo.com/mrss/"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Test Tech News</title>
    <link>https://example.com</link>
    <description>Example feed</description>
    <item>
      <title>First Article &amp; More</title>
      <link>https://example.com/articles/1?utm_source=rss</link>
      <guid isPermaLink="false">guid-001</guid>
      <pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate>
      <description><![CDATA[<p>Hello <strong>world</strong>.</p>]]></description>
      <media:content url="https://cdn.example.com/img1.jpg" medium="image" />
      <enclosure url="https://cdn.example.com/pod.mp3" type="audio/mpeg" />
    </item>
    <item>
      <title>Second Article</title>
      <link>https://example.com/articles/2</link>
      <guid>https://example.com/articles/2</guid>
      <pubDate>Tue, 02 Jan 2024 10:00:00 GMT</pubDate>
      <content:encoded><![CDATA[<div><p>Body two.</p><img src="https://cdn.example.com/inline2.png" /></div>]]></content:encoded>
    </item>
  </channel>
</rss>`;

const ATOM_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <title>Atom Feed</title>
  <entry>
    <title>Atom Entry</title>
    <id>tag:example.com,2024:1</id>
    <updated>2024-03-01T12:00:00Z</updated>
    <link rel="alternate" href="https://example.com/atom/1"/>
    <summary>Summary text</summary>
    <content type="html">&lt;p&gt;Body&lt;/p&gt;</content>
    <media:thumbnail url="https://cdn.example.com/atom-thumb.jpg"/>
  </entry>
</feed>`;

describe("parseXml", () => {
  it("parses RSS channel/item structure", () => {
    const parsed = parseXml(RSS_FIXTURE);
    expect(parsed.rss.channel.title).toBe("Test Tech News");
    expect(parsed.rss.channel.item).toHaveLength(2);
  });

  it("parses Atom feed/entry structure", () => {
    const parsed = parseXml(ATOM_FIXTURE);
    expect(parsed.feed.title).toBe("Atom Feed");
    expect(parsed.feed.entry).toBeDefined();
  });
});

describe("extractItems (RSS 2.0)", () => {
  const items = extractItems(parseXml(RSS_FIXTURE));

  it("returns one entry per <item>", () => {
    expect(items).toHaveLength(2);
  });

  it("sorts newest-first by pubDate", () => {
    expect(items[0].title).toBe("Second Article");
    expect(items[1].title).toBe("First Article & More");
  });

  it("decodes XML entities in titles", () => {
    expect(items[1].title).toBe("First Article & More");
  });

  it("extracts link (kept raw, tracking params intact)", () => {
    expect(items[0].link).toBe("https://example.com/articles/2");
    expect(items[1].link).toBe("https://example.com/articles/1?utm_source=rss");
  });

  it("unwraps guid values, including attributed GUIDs", () => {
    expect(items[0].guid).toBe("https://example.com/articles/2");
    expect(items[1].guid).toBe("guid-001");
  });

  it("prefers content:encoded over description", () => {
    expect(items[0].descriptionHtml).toContain("Body two.");
    expect(items[0].descriptionHtml).toContain("<img");
  });

  it("falls back to description when no content:encoded", () => {
    expect(items[1].descriptionHtml).toBe("<p>Hello <strong>world</strong>.</p>");
  });
});

describe("extractItems (Atom)", () => {
  const items = extractItems(parseXml(ATOM_FIXTURE));

  it("normalizes <entry> into the common shape", () => {
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Atom Entry");
    expect(items[0].guid).toBe("tag:example.com,2024:1");
    expect(items[0].pubDate).toBe("2024-03-01T12:00:00Z");
  });

  it("resolves <link rel=alternate> to a URL string", () => {
    expect(items[0].link).toBe("https://example.com/atom/1");
  });

  it("reads <content> body text", () => {
    expect(items[0].descriptionHtml).toBe("<p>Body</p>");
  });
});

describe("atomLink", () => {
  it("handles a string link", () => {
    expect(atomLink({ link: "https://example.com/a" })).toBe("https://example.com/a");
  });

  it("handles an object link with @_href", () => {
    expect(atomLink({ link: { "@_href": "https://example.com/b", "@_rel": "alternate" } }))
      .toBe("https://example.com/b");
  });

  it("prefers rel=alternate when multiple links exist", () => {
    expect(
      atomLink({
        link: [
          { "@_href": "https://example.com/self", "@_rel": "self" },
          { "@_href": "https://example.com/alt", "@_rel": "alternate" },
        ],
      }),
    ).toBe("https://example.com/alt");
  });

  it("returns empty string when no link present", () => {
    expect(atomLink({})).toBe("");
  });
});

describe("extractFeedTitle", () => {
  it("reads RSS channel title", () => {
    expect(extractFeedTitle(parseXml(RSS_FIXTURE))).toBe("Test Tech News");
  });

  it("reads Atom feed title", () => {
    expect(extractFeedTitle(parseXml(ATOM_FIXTURE))).toBe("Atom Feed");
  });
});

describe("textOf", () => {
  it("returns strings as-is", () => {
    expect(textOf("hello")).toBe("hello");
  });

  it("unwraps #text from attributed nodes", () => {
    expect(textOf({ "#text": "value", "@_type": "html" })).toBe("value");
  });

  it("returns empty string for null/objects without text", () => {
    expect(textOf(null)).toBe("");
    expect(textOf({})).toBe("");
  });
});

describe("normalizeUrl / canonicalId", () => {
  it("adds https scheme when missing", () => {
    expect(normalizeUrl("example.com/feed")).toBe("https://example.com/feed");
  });

  it("strips trailing slash from path", () => {
    expect(normalizeUrl("https://example.com/feed/")).toBe("https://example.com/feed");
  });

  it("strips hash and tracking params, keeps other params", () => {
    expect(normalizeUrl("https://example.com/a?utm_source=x&keep=1#frag"))
      .toBe("https://example.com/a?keep=1");
  });

  it("canonicalId normalizes URL ids but leaves opaque GUIDs untouched", () => {
    expect(canonicalId("https://example.com/a?utm_source=x")).toBe("https://example.com/a");
    expect(canonicalId("guid-123")).toBe("guid-123");
  });
});
