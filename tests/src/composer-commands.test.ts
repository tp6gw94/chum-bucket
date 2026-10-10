import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commandSuggestions,
  composerKeyAction,
  parseComposerCommand,
} from "../../src/composer-commands";

const query = {
  text: "/com",
  cursor: 4,
  selected: false,
  focused: true,
  composing: false,
  dismissed: false,
};
const key = {
  key: "Enter",
  shiftKey: false,
  isComposing: false,
  keyCode: 13,
  composing: false,
  hasSuggestions: true,
};

test("only the exact standalone compact command is recognized", () => {
  assert.equal(parseComposerCommand(" /compact\n"), "compact");
  for (const text of [
    "/com",
    "/compact now",
    "please /compact",
    "/compact\nquestion",
    "/Compact",
  ]) {
    assert.equal(parseComposerCommand(text), null);
  }
});

test("suggestions follow the focused leading slash query at the collapsed cursor", () => {
  assert.deepEqual(
    commandSuggestions(query).map((command) => command.name),
    ["compact"],
  );
  assert.deepEqual(
    commandSuggestions({ ...query, text: "/compact", cursor: 2 }).map((command) => command.name),
    ["compact"],
  );
  for (const change of [
    { focused: false },
    { composing: true },
    { selected: true },
    { dismissed: true },
    { text: "hello /com" },
    { text: "/com text" },
    { text: "/com\n" },
    { cursor: 0 },
    { cursor: 100 },
    { text: "/wrong" },
  ]) {
    assert.deepEqual(commandSuggestions({ ...query, ...change }), []);
  }
});

test("IME never selects or sends while editor navigation retains command control", () => {
  assert.equal(composerKeyAction(key), "select");
  assert.equal(composerKeyAction({ ...key, hasSuggestions: false }), "submit");
  assert.equal(composerKeyAction({ ...key, key: "ArrowDown" }), "next");
  assert.equal(composerKeyAction({ ...key, key: "ArrowUp" }), "previous");
  assert.equal(composerKeyAction({ ...key, key: "Escape" }), "dismiss");
  for (const change of [
    { isComposing: true },
    { composing: true },
    { keyCode: 229 },
    { shiftKey: true },
  ]) {
    assert.equal(composerKeyAction({ ...key, ...change }), "none");
  }
});
