import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActionEvent } from "@openuidev/react-lang";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageScroller } from "@shadcn/react/message-scroller";

import { formatActionMessage, MessageList } from "../../../src/components/message-list";

const action = (overrides: Partial<ActionEvent> = {}): ActionEvent => ({
  type: "continue_conversation",
  params: {},
  humanFriendlyMessage: "繼續查看",
  ...overrides,
});

test("continue conversation text preserves raw form groups and component wrappers", () => {
  assert.equal(
    formatActionMessage(
      action({
        formName: "trip",
        formState: {
          trip: {
            destination: { value: "", componentType: "Input" },
            dates: { value: ["2026-06-01", "2026-06-08"], componentType: "DateRangePicker" },
          },
        },
        params: { context: "plan the trip" },
      }),
    ),
    `繼續查看

{
  "formState": {
    "trip": {
      "destination": {
        "value": "",
        "componentType": "Input"
      },
      "dates": {
        "value": [
          "2026-06-01",
          "2026-06-08"
        ],
        "componentType": "DateRangePicker"
      }
    }
  },
  "formName": "trip",
  "context": "plan the trip"
}`,
  );
});

for (const [context, expected] of [
  [null, `繼續查看\n\n{\n  "context": null\n}`],
  [false, `繼續查看\n\n{\n  "context": false\n}`],
  [0, `繼續查看\n\n{\n  "context": 0\n}`],
  ["", `繼續查看\n\n{\n  "context": ""\n}`],
] as const) {
  test(`continue conversation text preserves context ${JSON.stringify(context)}`, () => {
    assert.equal(formatActionMessage(action({ params: { context } })), expected);
  });
}

test("a plain continue conversation does not append an empty JSON object", () => {
  assert.equal(formatActionMessage(action()), "繼續查看");
});

test("other action types do not produce a user message", () => {
  assert.equal(formatActionMessage(action({ type: "open_url" })), null);
});

test("streaming partial definition identifiers retain UI and the message action lock", () => {
  for (const tail of ["d", "detail", "detail "]) {
    const content = `root = Stack([title, detail])\ntitle = TextContent("Stable UI")\n${tail}`;
    const html = renderToStaticMarkup(
      <MessageScroller.Provider>
        <MessageList
          messages={[
            { id: "partial-definition", role: "assistant", parts: [{ type: "text", content }] },
          ]}
          agent="main"
          isStreaming
          onSend={async () => "succeeded"}
        />
      </MessageScroller.Provider>,
    );
    assert.ok(html.includes("Stable UI"), html);
    assert.equal(html.includes("root = Stack"), false);
    assert.equal(html.includes("無法完整解析 UI"), false);
    assert.equal(html.includes('<fieldset disabled="" inert=""'), true);
  }
});

for (const marker of ["//", "#"]) {
  for (const isStreaming of [false, true]) {
    test(`${marker} comments render UI and trailing prose while streaming=${isStreaming}`, () => {
      const content = [
        `${marker} heading`,
        `root = Stack([title]) ${marker} don't open a quote`,
        `${marker} don't close the frame`,
        'title = TextContent("Commented UI")',
        "Trailing prose stays visible.",
      ].join("\n");
      const html = renderToStaticMarkup(
        <MessageScroller.Provider>
          <MessageList
            messages={[{ id: "comments", role: "assistant", parts: [{ type: "text", content }] }]}
            agent="main"
            isStreaming={isStreaming}
            onSend={async () => "succeeded"}
          />
        </MessageScroller.Provider>,
      );
      assert.ok(html.includes("Commented UI"), html);
      assert.ok(html.indexOf("Trailing prose stays visible.") > html.indexOf("Commented UI"), html);
      assert.equal(html.includes("root = Stack"), false);
      assert.equal(html.includes("無法完整解析 UI"), false);
      assert.equal(html.includes('<fieldset disabled="" inert=""'), isStreaming);
    });

    test(`${marker} inline apostrophes do not hide trailing prose while streaming=${isStreaming}`, () => {
      const content = `root = Stack([TextContent("Inline UI")]) ${marker} don't\nTrailing prose stays visible.`;
      const html = renderToStaticMarkup(
        <MessageScroller.Provider>
          <MessageList
            messages={[
              { id: "inline-comment", role: "assistant", parts: [{ type: "text", content }] },
            ]}
            agent="main"
            isStreaming={isStreaming}
            onSend={async () => "succeeded"}
          />
        </MessageScroller.Provider>,
      );
      assert.ok(html.includes("Inline UI"), html);
      assert.ok(html.indexOf("Trailing prose stays visible.") > html.indexOf("Inline UI"), html);
      assert.equal(html.includes("root = Stack"), false);
      assert.equal(html.includes('<fieldset disabled="" inert=""'), isStreaming);
    });
  }
}

for (const isStreaming of [false, true]) {
  test(`mixed replies preserve ordered prose and multiple UI blocks while streaming=${isStreaming}`, () => {
    const content = [
      "The planner rejects references in this thread. Here's the current status.",
      "",
      "root = Stack([title])",
      'title = TextContent("First UI")',
      "Middle prose.",
      'root = Stack([TextContent("Second UI")])',
      "Trailing prose.",
    ].join("\n");
    const html = renderToStaticMarkup(
      <MessageScroller.Provider>
        <MessageList
          messages={[{ id: "mixed", role: "assistant", parts: [{ type: "text", content }] }]}
          agent="main"
          isStreaming={isStreaming}
          onSend={async () => "succeeded"}
        />
      </MessageScroller.Provider>,
    );
    const markers = [
      "Here&#x27;s the current status.",
      "First UI",
      "Middle prose.",
      "Second UI",
      "Trailing prose.",
    ];
    let previous = -1;
    for (const marker of markers) {
      const offset = html.indexOf(marker);
      assert.ok(offset > previous, `Missing or reordered ${marker}: ${html}`);
      previous = offset;
    }
    assert.equal(html.includes("root = Stack"), false);
    if (isStreaming) {
      assert.equal((html.match(/<fieldset disabled="" inert=""/g) ?? []).length, 2);
    }
  });
}
