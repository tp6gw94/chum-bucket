import assert from "node:assert/strict";
import { test } from "node:test";
import {
  causeMessage,
  commandMenu,
  commandSuggestions,
  composerKeyAction,
  menuAttributes,
  parseComposerCommand,
  resultError,
} from "../../src/composer-commands";

test("only an exact /compact is a command", () => {
  assert.equal(parseComposerCommand("/compact"), "compact");
  assert.equal(parseComposerCommand("  /compact \n"), "compact");
  assert.equal(parseComposerCommand("/compact 保留決策"), null);
  assert.equal(parseComposerCommand("/compac"), null);
  assert.equal(parseComposerCommand("compact"), null);
});

test("suggestions open only for a focused, settled slash prefix", () => {
  const names = (text: string, focused = true, composing = false) =>
    commandSuggestions({ text, focused, composing }).map((command) => command.name);

  assert.deepEqual(names("/"), ["compact"]);
  assert.deepEqual(names("/comp"), ["compact"]);
  assert.deepEqual(names("/x"), []);
  assert.deepEqual(names("/compact now"), []);
  assert.deepEqual(names("hello"), []);
  assert.deepEqual(names("/comp", false), []);
  assert.deepEqual(names("/comp", true, true), []);
});

test("menu keys move, select, and dismiss while composition Enter is left alone", () => {
  const key = (name: string, extra: Partial<Parameters<typeof composerKeyAction>[0]> = {}) =>
    composerKeyAction({
      key: name,
      shiftKey: false,
      isComposing: false,
      keyCode: 0,
      menuSize: 2,
      active: 0,
      ...extra,
    });

  assert.deepEqual(key("ArrowDown"), { type: "move", index: 1 });
  assert.deepEqual(key("ArrowUp"), { type: "move", index: 1 });
  assert.deepEqual(key("ArrowDown", { active: 1 }), { type: "move", index: 0 });
  assert.deepEqual(key("Enter", { active: 1 }), { type: "select", index: 1 });
  assert.deepEqual(key("Escape"), { type: "dismiss" });
  assert.deepEqual(key("Enter", { isComposing: true }), { type: "default" });
  assert.deepEqual(key("Enter", { keyCode: 229 }), { type: "default" });
  assert.deepEqual(key("Enter", { menuSize: 0 }), { type: "submit" });
  assert.deepEqual(key("Enter", { menuSize: 0, shiftKey: true }), { type: "default" });
  assert.deepEqual(key("ArrowDown", { menuSize: 0 }), { type: "default" });
});

test("the menu stays closed when disabled, unavailable, or dismissed for the same text", () => {
  const base = {
    text: "/c",
    focused: true,
    composing: false,
    enabled: true,
    available: true,
    dismissed: null,
    active: 5,
  };

  assert.deepEqual(commandMenu(base).highlighted, 0);
  assert.equal(commandMenu(base).suggestions.length, 1);
  assert.equal(commandMenu({ ...base, enabled: false }).suggestions.length, 0);
  assert.equal(commandMenu({ ...base, available: false }).suggestions.length, 0);
  assert.equal(commandMenu({ ...base, dismissed: "/c" }).suggestions.length, 0);
  assert.equal(commandMenu({ ...base, dismissed: "/" }).suggestions.length, 1);
  assert.deepEqual(menuAttributes("list", commandMenu(base)), {
    "aria-controls": "list",
    "aria-activedescendant": "list-0",
  });
  assert.deepEqual(menuAttributes("list", commandMenu({ ...base, enabled: false })), {});
});

test("send results and causes map to composer feedback", () => {
  assert.equal(resultError("succeeded"), null);
  assert.match(resultError("failed")!, /執行失敗/);
  assert.match(resultError("uncertain")!, /尚未確認/);
  assert.equal(causeMessage(new Error("boom")), "boom");
  assert.match(causeMessage("boom"), /送出失敗/);
});
