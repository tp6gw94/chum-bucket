import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function verifyQaReport({
  taskSpace,
  existingSpaceId,
  evidenceDir,
  instanceDir = join(evidenceDir, "instance"),
  createThread = true,
}) {
  const instance = JSON.parse(await readFile(join(instanceDir, "instance.json"), "utf8"));
  const task = await taskSpace(existingSpaceId);
  const page = task.page("p1");
  const action = async (entry) =>
    appendFile(
      join(evidenceDir, "actions.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), feature: "qa-text-report", ...entry })}\n`,
    );
  const capture = async (name) => {
    await writeFile(
      join(evidenceDir, `${name}.aria.txt`),
      await page.snapshot({ scope: "full_page" }),
    );
    await page.screenshot({ path: join(evidenceDir, `${name}.png`) });
  };
  assert.equal(new URL(instance.origin).hostname, "127.0.0.1");
  if (createThread) {
    await action({ action: "goto", url: instance.origin });
    await page.goto(instance.origin);
    await page.waitForSelector('loc=role:button[name="建立新對話"]');
    await action({ action: "create-thread", entry: "chooser" });
    await page.click('loc=role:button[name="建立新對話"]');
  }
  await page.waitForSelector('section[aria-label="主對話"] [role="textbox"]');
  const request = `fixture ${JSON.stringify({ goal: "Verify checkout with disclosed synthetic sources and prose findings", sources: [{ kind: "jira", issueKey: "CHUM-42" }], executionRoles: ["ac", "ui"], targetUrl: instance.origin, design: { fileKey: "FILE", nodeId: "12:34" } })}`;
  await capture("before-request");
  await action({ action: "fill-and-send", entry: "main-composer", request, notLiveProvider: true });
  await page.fill('section[aria-label="主對話"] [role="textbox"]', request);
  await page.click('section[aria-label="主對話"] button:has-text("送出")');
  await page.waitForFunction(
    () =>
      document.body.innerText.includes("委派任務已完成") ||
      document.body.innerText.includes("委派任務遭拒"),
    undefined,
    { timeout: 120000 },
  );
  await capture("terminal-desktop");
  const url = await page.url();
  const threadId = new URL(url).searchParams.get("threadId");
  const response = await page.fetch(`/api/thread/${threadId}`);
  await writeFile(join(evidenceDir, "thread-response.json"), JSON.stringify(response, null, 2));
  await action({ action: "reload", url });
  await page.reload();
  await page.waitForSelector('section[aria-label="主對話"] [role="textbox"]');
  await capture("reloaded-desktop");
  await action({ action: "mobile-viewport", width: 390 });
  await page.cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await capture("reloaded-mobile");
  await page.cdp("Emulation.clearDeviceMetricsOverride");
  const result = {
    taskSpaceId: existingSpaceId,
    page: "p1",
    url,
    threadId,
    notLiveProvider: true,
    fixtureLimit:
      "Scripted transport and integration only, not model reasoning or website validation",
    browserReceipts: "INCONCLUSIVE until read-only database receipts are inspected",
    cancellation: "NOT VERIFIED",
    restart: "NOT VERIFIED",
    retainedTaskSpace: true,
  };
  await writeFile(join(evidenceDir, "proof-result.json"), JSON.stringify(result, null, 2));
  console.log(result);
  console.log(await page.snapshot());
}

export function assertQaView(view, { role, findings, missingChecks, outcome = "completed" } = {}) {
  assert.equal(view.task.version, 3);
  if (role) assert.equal(view.task.role, role);
  if (findings !== undefined) assert.equal(view.task.findings, findings);
  if (missingChecks) assert.deepEqual(view.task.missingChecks, missingChecks);
  const progress = view.progress.rows ? view.progress.rows[view.task.role] : view.progress;
  assert.equal(progress.outcome, outcome);
  assert.ok(Array.isArray(view.task.conflictingChecks));
  for (const check of view.task.result?.payload ?? []) {
    assert.ok(check.evidence.length > 0);
    for (const evidence of check.evidence) {
      assert.equal(evidence.checkId, check.checkId);
      assert.equal(evidence.caseId, check.caseId);
      assert.ok(["browser", "mock"].includes(evidence.origin));
    }
  }
  const serialized = JSON.stringify(view);
  for (const privateField of [
    "nativeInput",
    "nativeOutput",
    "systemPrompt",
    "model_steps",
    "conversation",
    "design_capture",
  ]) {
    assert.ok(!serialized.includes(`"${privateField}"`), privateField);
  }
}

export function assertQaRecovery(before, after) {
  assert.deepEqual(after.task, before.task);
  assert.equal(after.state, before.state);
  assert.deepEqual(after.progress.rows, before.progress.rows);
}

export function assertQaCancelled(view) {
  assertQaView(view, { outcome: "cancelled", findings: null });
  assert.ok(
    view.task.result.payload.length > 0,
    "Accepted partial observations survive cancellation",
  );
}

export function assertQaLegacy(view) {
  assert.equal(view.task.version, 2);
  assert.ok(Array.isArray(view.task.result.payload));
}

export async function assertQaFinal(evidenceDir, { scenario = "prose" } = {}) {
  const records = (await readFile(join(evidenceDir, "qa-fixture.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const views = records
    .filter((record) => record.boundary === "main-tool-input")
    .at(-1)
    .outputs.map((output) => JSON.parse(output));
  for (const role of ["ac", "ui"]) {
    const view = views.find((item) => item.task?.role === role);
    const authored = records
      .filter((record) => record.boundary === "qa-prose" && record.role === role)
      .at(-1).text;
    assertQaView(view, { role, findings: authored || null });
    if (scenario === "missing" || scenario === "absent") {
      assert.equal(view.task.result.payload.length, 0);
      assert.ok(view.task.missingChecks.length > 0);
    } else {
      assert.ok(view.task.result.payload.length > 0);
    }
    if (scenario === "partial" && role === "ac")
      assert.ok(view.task.missingChecks.includes("partial-missing-check"));
  }
  const result = {
    publicFindingsAndToolFacts: "VERIFIED",
    scenario,
    notLiveProvider: true,
    reasoning: "NOT VERIFIED",
    cancellation: "NOT VERIFIED",
    restart: "NOT VERIFIED",
  };
  await writeFile(join(evidenceDir, "final-checks.json"), JSON.stringify(result, null, 2));
  return result;
}

export async function assertQaBaseline(evidenceDir) {
  const database = JSON.parse(await readFile(join(evidenceDir, "qa-database.json"), "utf8"));
  const records = (await readFile(join(evidenceDir, "qa-fixture.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const views = records
    .filter((record) => record.boundary === "main-tool-input")
    .at(-1)
    .outputs.map((output) => JSON.parse(output));
  for (const role of ["ac", "ui"]) {
    const view = views.find((item) => item.task?.role === role);
    assert.equal(view.task.result, null);
    assert.equal(view.progress.reasonCode, "proposal_rejected");
    assert.deepEqual(view.progress.issues, ["Role output is not valid JSON"]);
    const receipt = database.receipts.find((item) => item.native_name === `verify_${role}`);
    assert.equal(receipt.output.evidence.origin, "browser");
    assert.equal(receipt.output.evidence.outcome, "blocked");
    assert.equal(receipt.bindings.checkId, receipt.output.checkId);
    assert.ok(receipt.output.evidence.browser.screenshot.digest);
    assert.ok(!JSON.stringify(view).includes(receipt.id));
    assert.ok(
      database.dbos.some(
        (workflow) =>
          workflow.workflow_uuid ===
            database.tasks.find((task) => task.role === role).child_workflow_id &&
          workflow.status === "SUCCESS",
      ),
    );
  }
  assert.ok(database.receipts.some((receipt) => receipt.native_name === "design_capture"));
  const result = {
    baselineJsonRejection: "VERIFIED",
    authenticBlockedBrowserReceipts: "VERIFIED",
    receiptsAbsentFromMain: "VERIFIED",
    successfulBrowserObservation: "INCONCLUSIVE",
    statusOnlyScenario: "NOT VERIFIED",
    cancellation: "NOT VERIFIED",
    restart: "NOT VERIFIED",
    notLiveProvider: true,
  };
  await writeFile(join(evidenceDir, "baseline-checks.json"), JSON.stringify(result, null, 2));
  return result;
}

async function fixtureRecords(evidenceDir) {
  return (await readFile(join(evidenceDir, "qa-fixture.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function acRepairView(records) {
  return records
    .filter((record) => record.boundary === "main-tool-input")
    .at(-1)
    .outputs.map((output) => JSON.parse(output))
    .find((item) => item.task?.role === "ac");
}

async function writeRepairCheck(evidenceDir, name, result) {
  await writeFile(join(evidenceDir, `${name}.json`), JSON.stringify(result, null, 2));
  return result;
}

export async function assertQaOverflowPreFixBug(evidenceDir) {
  const records = await fixtureRecords(evidenceDir);
  const view = acRepairView(records);
  const requests = records.filter((record) => record.boundary === "model" && record.role === "ac");
  const overflows = requests.filter(
    (record) => record.outcome === "run-error-context-length-exceeded",
  );
  assert.ok(
    requests.some((record) => !record.hasObservation && record.tools.includes("verify_ac")),
  );
  assert.ok(overflows.length >= 2);
  assert.ok(overflows.some((record) => !record.designatedFinal));
  assert.ok(overflows.some((record) => record.designatedFinal));
  assert.ok(requests.every((record) => record.outcome !== "prose"));
  assertQaView(view, { role: "ac", findings: null, outcome: "completed" });
  assert.ok(view.task.result.payload.length > 0);
  return writeRepairCheck(evidenceDir, "overflow-prefix-bug-checks", {
    preFixBugReproduced: "completed with null findings after context overflow",
    overflowRequests: overflows.length,
    notLiveProvider: true,
  });
}

export async function assertQaOverflowPostFix(evidenceDir) {
  const records = await fixtureRecords(evidenceDir);
  const view = acRepairView(records);
  assertQaView(view, { role: "ac", findings: null, outcome: "failed" });
  assert.equal(typeof view.progress.reasonCode, "string");
  assert.ok(view.progress.reasonCode.length > 0);
  assert.ok(view.task.result.payload.length > 0);
  assert.ok(
    records.some(
      (record) =>
        record.boundary === "model" &&
        record.role === "ac" &&
        record.outcome === "run-error-context-length-exceeded",
    ),
  );
  return writeRepairCheck(evidenceDir, "overflow-postfix-checks", {
    failedWithPublicReason: view.progress.reasonCode,
    receiptsRetained: view.task.result.payload.length,
    notLiveProvider: true,
  });
}

async function answerOnceFacts(evidenceDir) {
  const records = await fixtureRecords(evidenceDir);
  const prose = records.filter((record) => record.boundary === "qa-prose" && record.role === "ac");
  return { view: acRepairView(records), prose };
}

export async function assertQaAnswerOncePreFixBug(evidenceDir, { secondReply = "" } = {}) {
  const { view, prose } = await answerOnceFacts(evidenceDir);
  assert.equal(prose.length, 2);
  assert.ok(prose[0].text.startsWith("FIRST_FINDINGS:"));
  assert.equal(prose[0].answeredOnce, false);
  assert.equal(prose[1].text, secondReply);
  assert.equal(prose[1].answeredOnce, true);
  assert.equal(prose[1].designatedFinal, true);
  assertQaView(view, { role: "ac", findings: secondReply || null });
  assert.ok(!JSON.stringify(view).includes("FIRST_FINDINGS"));
  return writeRepairCheck(evidenceDir, "answer-once-prefix-bug-checks", {
    preFixBugReproduced: "first findings reply lost to the extra designated turn",
    findingsRequests: prose.length,
    keptFindings: view.task.findings,
    notLiveProvider: true,
  });
}

export async function assertQaAnswerOncePostFix(evidenceDir) {
  const { view, prose } = await answerOnceFacts(evidenceDir);
  assert.equal(prose.length, 1);
  assert.ok(prose[0].text.startsWith("FIRST_FINDINGS:"));
  assertQaView(view, { role: "ac", findings: prose[0].text });
  return writeRepairCheck(evidenceDir, "answer-once-postfix-checks", {
    firstFindingsKept: "VERIFIED",
    findingsRequests: prose.length,
    notLiveProvider: true,
  });
}
