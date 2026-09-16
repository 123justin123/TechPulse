import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpError } from "../src/http.js";
import { createRssSource } from "../src/sources/rss.js";
import { daysBefore } from "../src/sources/source.js";
import { fakeHttp, NOW, recordingLog } from "./helpers.js";

const SINCE = daysBefore(NOW, 7);

const RSS_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Test blog</title>
  <item>
    <title>Recent article</title><link>https://blog.test/recent</link>
    <pubDate>Sat, 12 Sep 2026 08:00:00 GMT</pubDate><description>A useful excerpt.</description>
  </item>
  <item>
    <title>Old article</title><link>https://blog.test/old</link>
    <pubDate>Mon, 01 Jun 2026 08:00:00 GMT</pubDate>
  </item>
  <item><title>No link</title><pubDate>Sat, 12 Sep 2026 08:00:00 GMT</pubDate></item>
</channel></rss>`;

describe("RSS source", () => {
  it("keeps recent and complete entries", async () => {
    const { http, requests } = fakeHttp(() => RSS_FEED);
    const items = await createRssSource([{ name: "My blog", url: "https://blog.test/feed" }], http).collect({
      log: recordingLog().log,
      now: NOW,
      since: SINCE,
    });

    assert.equal(items.length, 1);
    assert.deepEqual(items[0], {
      sourceRef: "My blog",
      title: "Recent article",
      url: "https://blog.test/recent",
      content: "A useful excerpt.",
      publishedAt: "2026-09-12T08:00:00.000Z",
    });
    assert.match(requests[0]?.options?.accept ?? "", /application\/rss\+xml/);
  });

  it("keeps the longest text among the feed fields, including Atom summaries and content:encoded", async () => {
    const atomFeed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom blog</title>
  <entry>
    <title>Atom entry</title><link href="https://atom.test/entry"/>
    <updated>2026-09-12T08:00:00Z</updated>
    <summary type="html">&lt;p&gt;Summary &amp;amp; details&lt;/p&gt;</summary>
  </entry>
</feed>`;
    const encodedFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>News</title>
  <item>
    <title>Encoded</title><link>https://news.test/encoded</link>
    <pubDate>Sat, 12 Sep 2026 08:00:00 GMT</pubDate>
    <description>Short standfirst.</description>
    <content:encoded><![CDATA[<p>Short standfirst.</p><p>The full article body.</p>]]></content:encoded>
  </item>
</channel></rss>`;
    const { http } = fakeHttp((url) => (url.includes("atom") ? atomFeed : encodedFeed));
    const items = await createRssSource(
      [{ url: "https://atom.test/feed" }, { url: "https://news.test/feed" }],
      http,
    ).collect({ log: recordingLog().log, now: NOW, since: SINCE });

    assert.match(items[0]?.content ?? "", /^Summary & details/);
    assert.match(items[1]?.content ?? "", /Short standfirst\.[\s\S]*The full article body\./);
  });

  it("falls back to the feed title when unnamed and survives a dead feed", async () => {
    const { http } = fakeHttp((url) => {
      if (url.includes("dead")) throw new HttpError(403, url);
      return RSS_FEED;
    });
    const { log, lines } = recordingLog();
    const items = await createRssSource(
      [{ url: "https://dead.test/feed" }, { url: "https://blog.test/feed" }],
      http,
    ).collect({ log, now: NOW, since: SINCE });

    assert.equal(items.length, 1);
    assert.equal(items[0]?.sourceRef, "Test blog");
    assert.ok(lines.some((line) => line.includes("Feed skipped (https://dead.test/feed): HTTP 403")));
  });
});
