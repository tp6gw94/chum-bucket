import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActionEvent } from "@openuidev/react-lang";

import { formatActionMessage } from "../../../src/components/message-list";

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
