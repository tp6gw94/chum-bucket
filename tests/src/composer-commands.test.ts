import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commandSuggestions,
  composerKeyAction,
  parseComposerCommand,
} from "../../src/composer-commands";

test("only an exact /compact is a command", () => {
  assert.equal(parseComposerCommand("/compact"), "compact");
  assert.equal(parseComposerCommand("  /compact \n"), "compact");
  assert.equal(parseComposerCommand("/compact 保留決策"), null);
  assert.equal(parseComposerCommand("/compac"), null);
  assert.equal(parseComposerCommand("compact"), null);
});

test("suggestions appear for a focused slash prefix outside IME composition", () => {
  const names = (text: string, focused = true, composing = false) =>
    commandSuggestions({ text, focused, composing }).map((command) => command.name);
  assert.deepEqual(names("/"), ["compact"]);
  assert.deepEqual(names("/comp"), ["compact"]);
  assert.deepEqual(names("/x"), []);
  assert.deepEqual(names("/comp", false), []);
  assert.deepEqual(names("/comp", true, true), []);
  assert.deepEqual(names("hi /comp"), []);
  assert.deepEqual(names("/compact now"), []);
});

test("menu keys move, select and close while composition keys are ignored", () => {
  const key = (name: string, extra: Partial<Parameters<typeof composerKeyAction>[0]> = {}) =>
    composerKeyAction({
      key: name,
      isComposing: false,
      keyCode: 0,
      open: true,
      active: 0,
      count: 2,
      ...extra,
    });
  assert.deepEqual(key("ArrowDown"), { type: "move", active: 1 });
  assert.deepEqual(key("ArrowDown", { active: 1 }), { type: "move", active: 0 });
  assert.deepEqual(key("ArrowUp"), { type: "move", active: 1 });
  assert.deepEqual(key("Enter", { active: 1 }), { type: "select", index: 1 });
  assert.deepEqual(key("Escape"), { type: "close" });
  assert.deepEqual(key("Enter", { isComposing: true }), { type: "none" });
  assert.deepEqual(key("Enter", { keyCode: 229 }), { type: "none" });
  assert.deepEqual(key("Enter", { open: false }), { type: "submit" });
  assert.deepEqual(key("Enter", { open: false, shiftKey: true }), { type: "none" });
  assert.deepEqual(key("Enter", { open: false, keyCode: 229 }), { type: "none" });
  assert.deepEqual(key("ArrowDown", { open: false }), { type: "none" });
  assert.deepEqual(key("a"), { type: "none" });
});
