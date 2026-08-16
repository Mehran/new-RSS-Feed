import { describe, it, expect } from "vitest";
import {
  parseXml,
  extractItems,
  canonicalId,
  extractImageFromFeed,
  cleanBody,
} from "../src/index";

/**
 * A faithful mirror of https://digiato.com/feed: Persian titles, item-level
 * <image><url> (no media:content/enclosure), WordPress GUIDs using the numeric
 * entity `&#038;` (= `&`), and the English "The post … appeared first on …"
 * footer in <description>. This is the exact feed that exposed the dedupe bug.
 */
const DIGIATO_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>دیجیاتو</title>
    <link>https://digiato.com/</link>
    <description>هر لحظه با اخبار فناوری</description>
    <item>
      <title>سامسونگ روند طراحی تراشه را با Claude Code از یک ماه به چند روز رساند</title>
      <link>https://digiato.com/artificial-intelligence/samsung-claude-code-chip-design-speedup</link>
      <image>
        <url>https://static.digiato.com/digiato/2026/08/Coding.jpg.webp</url>
      </image>
      <pubDate>Sun, 16 Aug 2026 11:43:00 +0000</pubDate>
      <guid isPermaLink="false">https://digiato.com/?post_type=digi_posts&#038;p=1959142</guid>
      <description><![CDATA[<p>با وجود پیشرفت‌ها، سامسونگ به خطاهای مهمی اشاره کرده است.</p>
<p>The post <a href="https://digiato.com/artificial-intelligence/samsung-claude-code-chip-design-speedup">سامسونگ روند طراحی تراشه را با Claude Code از یک ماه به چند روز رساند</a> appeared first on <a href="https://digiato.com">دیجیاتو</a>.</p>
]]></description>
    </item>
    <item>
      <title>شرکت کروشال از تعویض و بازگرداندن رم معیوب به مشتری خودداری کرد</title>
      <link>https://digiato.com/computers-hardware/crucial-refuses-ddr5-ram-replacement-and-return-rma-scandal</link>
      <image>
        <url>https://static.digiato.com/digiato/2026/08/Crucial-DDR5-Memory.jpg.webp</url>
      </image>
      <pubDate>Sun, 16 Aug 2026 11:16:19 +0000</pubDate>
      <guid isPermaLink="false">https://digiato.com/?post_type=digi_posts&#038;p=1958953</guid>
      <description><![CDATA[<p>کروشال ابتدا با تعویض رم معیوب موافقت کرد، اما سپس از بازگرداندن آن امتناع کرد.</p>
<p>The post <a href="https://digiato.com/computers-hardware/crucial-refuses-ddr5-ram-replacement-and-return-rma-scandal">شرکت کروشال از تعویض و بازگرداندن رم معیوب به مشتری خودداری کرد</a> appeared first on <a href="https://digiato.com">دیجیاتو</a>.</p>
]]></description>
    </item>
  </channel>
</rss>`;

describe("digiato.com/feed (end-to-end)", () => {
  const items = extractItems(parseXml(DIGIATO_FIXTURE));

  it("parses every <item> and sorts newest-first", () => {
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe(
      "سامسونگ روند طراحی تراشه را با Claude Code از یک ماه به چند روز رساند",
    );
    expect(items[1].title).toBe(
      "شرکت کروشال از تعویض و بازگرداندن رم معیوب به مشتری خودداری کرد",
    );
  });

  it("produces unique dedupe keys (post id preserved despite &#038;)", () => {
    // Mirrors getItemRawId(): prefer guid, then link.
    const keys = items.map((it) => canonicalId((it.guid || it.link).trim()));
    expect(keys).toEqual([
      "https://digiato.com/?post_type=digi_posts&p=1959142",
      "https://digiato.com/?post_type=digi_posts&p=1958953",
    ]);
    expect(new Set(keys).size).toBe(items.length);
  });

  it("reads the featured image from the item-level <image><url>", () => {
    expect(extractImageFromFeed(items[0].raw)).toBe(
      "https://static.digiato.com/digiato/2026/08/Coding.jpg.webp",
    );
    expect(extractImageFromFeed(items[1].raw)).toBe(
      "https://static.digiato.com/digiato/2026/08/Crucial-DDR5-Memory.jpg.webp",
    );
  });

  it("strips the 'appeared first on' footer from the body", () => {
    const body = cleanBody(items[0].descriptionHtml);
    expect(body).toContain("با وجود پیشرفت‌ها");
    expect(body).not.toContain("appeared first on");
  });
});
