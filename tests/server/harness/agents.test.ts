import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allowsTool,
  atlassianNamesFor,
  roleSystemPrompt,
  toolNamesFor,
} from "../../../server/harness/agents";
import { discoveryToolName } from "../../../server/harness/tools/atlassian";
import { codeModeToolName } from "../../../server/harness/tools/code-mode";

test("main delegates but cannot read Jira or run browser checks", () => {
  assert.equal(allowsTool("main", "delegate_task", "direct"), true);
  assert.equal(allowsTool("main", "delegate_task", "codemode"), false);
  assert.equal(allowsTool("main", "jira_get_issue", "direct"), false);
  assert.equal(allowsTool("main", "jira_get_issue", "codemode"), false);
  assert.equal(allowsTool("main", discoveryToolName, "direct"), false);
  assert.equal(allowsTool("main", "verify_ac", "direct"), false);
  assert.equal(allowsTool("main", codeModeToolName, "direct"), true);
  assert.equal(allowsTool("main", "read", "codemode"), true);
});

test("side chats cannot delegate", () => {
  assert.equal(allowsTool("side", "delegate_task", "direct"), false);
  assert.equal(allowsTool("side", "get_figma", "direct"), true);
});

test("atlassian role reads only issues and pages", () => {
  assert.deepEqual(atlassianNamesFor("atlassian"), ["jira_get_issue", "confluence_get_page"]);
  assert.equal(allowsTool("atlassian", "jira_get_issue", "direct"), true);
  assert.equal(allowsTool("atlassian", "confluence_get_page", "codemode"), true);
  assert.equal(allowsTool("atlassian", "jira_create_issue", "direct"), false);
  assert.equal(allowsTool("atlassian", discoveryToolName, "direct"), true);
  assert.equal(allowsTool("atlassian", discoveryToolName, "codemode"), false);
  assert.equal(allowsTool("atlassian", "read", "direct"), false);
});

test("planner has no tools beyond code mode", () => {
  assert.deepEqual(toolNamesFor("planner"), []);
  assert.equal(allowsTool("planner", "get_figma", "direct"), false);
  assert.equal(allowsTool("planner", discoveryToolName, "direct"), false);
});

test("browser roles call their verifier directly without code mode", () => {
  assert.equal(allowsTool("ac", "verify_ac", "direct"), true);
  assert.equal(allowsTool("ac", "verify_ac", "codemode"), false);
  assert.equal(allowsTool("ac", "verify_ui", "direct"), false);
  assert.equal(allowsTool("ac", codeModeToolName, "direct"), false);
  assert.equal(allowsTool("ui", "verify_ui", "direct"), true);
  assert.equal(allowsTool("ui", "get_figma", "direct"), true);
  assert.equal(allowsTool("ui", "verify_ac", "direct"), false);
  assert.equal(allowsTool("ui", codeModeToolName, "direct"), false);
});

test("role prompts are pinned to their profile", () => {
  assert.match(roleSystemPrompt("planner", "plan-v1"), /\S/);
  assert.throws(() => roleSystemPrompt("planner", "plan-v0"), /no longer supported/);
});
