import { describe, expect, it } from 'vitest';

import { parseRedditRss } from './reddit';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>How do you invoice clients without a spreadsheet?</title>
    <link href="https://www.reddit.com/r/smallbusiness/comments/abc/how_do_you_invoice/" />
    <updated>2026-10-20T10:00:00+00:00</updated>
    <content type="html">&lt;p&gt;We chase invoices by hand every month and it is killing me.&lt;/p&gt;</content>
  </entry>
  <entry>
    <title></title>
    <link href="https://www.reddit.com/r/x/comments/def/empty/" />
    <updated>2026-10-21T10:00:00+00:00</updated>
  </entry>
  <entry>
    <title>Looking for a scheduling tool for my studio</title>
    <link href="https://www.reddit.com/r/fitness/comments/ghi/scheduling/" />
    <content type="html">&lt;p&gt;I would pay for something that handles cancellations.&lt;/p&gt;</content>
  </entry>
</feed>`;

describe('parseRedditRss', () => {
  it('reads Atom entries into hits, stripping embedded HTML', () => {
    const hits = parseRedditRss(FEED, 10);

    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      url: 'https://www.reddit.com/r/smallbusiness/comments/abc/how_do_you_invoice/',
      title: 'How do you invoice clients without a spreadsheet?',
      platform: 'reddit',
      publishedAt: '2026-10-20T10:00:00+00:00',
    });
    expect(hits[0]?.snippet).toContain('chase invoices by hand');
    expect(hits[1]?.title).toContain('scheduling');
  });

  it('caps the hits and tolerates junk', () => {
    expect(parseRedditRss(FEED, 1)).toHaveLength(1);
    expect(parseRedditRss('<html>not a feed</html>', 5)).toEqual([]);
    expect(parseRedditRss('', 5)).toEqual([]);
  });
});
