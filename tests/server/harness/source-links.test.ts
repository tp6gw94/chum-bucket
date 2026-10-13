import assert from "node:assert/strict";
import { test } from "node:test";
import {
  figmaLinks,
  withIssueFields,
  withPageMetadata,
  withRemoteLinks,
} from "../../../server/harness/source-links";

const link = (url: string, title?: string) => ({
  id: 1,
  object: { url, ...(title === undefined ? {} : { title }) },
});

const issue = (remoteLinks: unknown) => ({
  key: "FETM-78",
  description: "see https://www.figma.com/design/IGNORED?node-id=9-9",
  remote_links: remoteLinks,
});

const wrapped = (value: unknown) => ({ result: JSON.stringify(value) });

test("Jira result envelopes yield distinct Figma file and node links with labels", () => {
  const links = figmaLinks(
    wrapped(
      issue([
        link("https://www.figma.com/design/DiPISvcpFmaPsK9QonpeDf", "整份設計稿"),
        link("https://www.figma.com/design/DiPISvcpFmaPsK9QonpeDf?node-id=1-81", "商品頁 桌面"),
        link("https://www.figma.com/design/DiPISvcpFmaPsK9QonpeDf?node-id=1-82", "購物車 桌面"),
        link("https://www.figma.com/design/DiPISvcpFmaPsK9QonpeDf?node-id=1-86"),
      ]),
    ),
  );
  assert.deepEqual(links, [
    {
      url: "https://www.figma.com/design/DiPISvcpFmaPsK9QonpeDf",
      label: "整份設計稿",
      fileKey: "DiPISvcpFmaPsK9QonpeDf",
    },
    {
      url: "https://www.figma.com/design/DiPISvcpFmaPsK9QonpeDf?node-id=1-81",
      label: "商品頁 桌面",
      fileKey: "DiPISvcpFmaPsK9QonpeDf",
      nodeId: "1:81",
    },
    {
      url: "https://www.figma.com/design/DiPISvcpFmaPsK9QonpeDf?node-id=1-82",
      label: "購物車 桌面",
      fileKey: "DiPISvcpFmaPsK9QonpeDf",
      nodeId: "1:82",
    },
    {
      url: "https://www.figma.com/design/DiPISvcpFmaPsK9QonpeDf?node-id=1-86",
      fileKey: "DiPISvcpFmaPsK9QonpeDf",
      nodeId: "1:86",
    },
  ]);
});

test("plain issue objects work and non-Figma, malformed or duplicate links are dropped", () => {
  const links = figmaLinks(
    issue([
      link("https://example.com/design/abc?node-id=1-1", "not figma"),
      link("not a url"),
      link("https://www.figma.com/board/abc"),
      { id: 2 },
      { object: { url: 42 } },
      link("https://www.figma.com/file/AbC123?node-id=2-3", "kept"),
      link("https://www.figma.com/file/AbC123?node-id=2-3", "duplicate"),
      link("https://www.figma.com/design/AbC123?node-id=bad", "bad node"),
    ]),
  );
  assert.deepEqual(links, [
    {
      url: "https://www.figma.com/file/AbC123?node-id=2-3",
      label: "kept",
      fileKey: "AbC123",
      nodeId: "2:3",
    },
    {
      url: "https://www.figma.com/design/AbC123?node-id=bad",
      label: "bad node",
      fileKey: "AbC123",
    },
  ]);
});

test("issues without a usable remote link list produce no links", () => {
  assert.deepEqual(figmaLinks(wrapped(issue(undefined))), []);
  assert.deepEqual(figmaLinks(wrapped(issue("nope"))), []);
  assert.deepEqual(figmaLinks({ result: "{not json" }), []);
  assert.deepEqual(figmaLinks({ result: JSON.stringify({ summary: "no key" }) }), []);
  assert.deepEqual(figmaLinks("text"), []);
  assert.deepEqual(figmaLinks(null), []);
});

test("link extraction is bounded", () => {
  const many = Array.from({ length: 40 }, (_, index) =>
    link(`https://www.figma.com/design/File${index}?node-id=1-${index}`, "x".repeat(400)),
  );
  const links = figmaLinks(wrapped(issue(many)));
  assert.equal(links.length, 20);
  assert.ok(links.every((item) => (item.label?.length ?? 0) <= 256));
  assert.ok(links.every((item) => item.url.length <= 2_048));
});

test("jira_get_issue is always asked for the summary and description fields", () => {
  assert.deepEqual(withIssueFields({ issue_key: "FETM-78" }), {
    issue_key: "FETM-78",
    fields: "summary,description",
  });
  assert.deepEqual(withIssueFields({ issue_key: "A-1", fields: "summary,status" }), {
    issue_key: "A-1",
    fields: "summary,status,description",
  });
  assert.deepEqual(withIssueFields({ issue_key: "A-1", fields: "status,customfield_10009" }), {
    issue_key: "A-1",
    fields: "status,customfield_10009,summary,description",
  });
  assert.deepEqual(withIssueFields({ issue_key: "A-1", fields: "description,summary" }), {
    issue_key: "A-1",
    fields: "description,summary",
  });
  assert.deepEqual(withIssueFields({ issue_key: "A-1", fields: "*all" }), {
    issue_key: "A-1",
    fields: "*all",
  });
  assert.deepEqual(withIssueFields({ issue_key: "A-1", fields: "summary, *all" }), {
    issue_key: "A-1",
    fields: "summary, *all",
  });
  assert.equal(withIssueFields("not a record"), "not a record");
});

test("jira_get_issue is always asked for remote links without losing other enrichments", () => {
  assert.deepEqual(withRemoteLinks({ issue_key: "FETM-78" }), {
    issue_key: "FETM-78",
    include: "remote_links",
  });
  assert.deepEqual(withRemoteLinks({ issue_key: "A-1", include: "" }), {
    issue_key: "A-1",
    include: "remote_links",
  });
  assert.deepEqual(withRemoteLinks({ issue_key: "A-1", include: "comments,changelog" }), {
    issue_key: "A-1",
    include: "comments,changelog,remote_links",
  });
  assert.deepEqual(withRemoteLinks({ issue_key: "A-1", include: "all" }), {
    issue_key: "A-1",
    include: "all",
  });
  assert.deepEqual(withRemoteLinks({ issue_key: "A-1", include: "watchers, remote_links" }), {
    issue_key: "A-1",
    include: "watchers, remote_links",
  });
  assert.equal(withRemoteLinks("not a record"), "not a record");
});

test("confluence_get_page is always asked for page metadata so the title is returned", () => {
  assert.deepEqual(withPageMetadata({ page_id: "123" }), {
    page_id: "123",
    include_metadata: true,
  });
  assert.deepEqual(withPageMetadata({ page_id: "123", include_metadata: false }), {
    page_id: "123",
    include_metadata: true,
  });
  assert.equal(withPageMetadata("not a record"), "not a record");
});
