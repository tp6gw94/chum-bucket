import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const { SystemDatabase } = require(
  path.join(path.dirname(require.resolve("@dbos-inc/dbos-sdk")), "system_database.js"),
);
const originalInit = SystemDatabase.prototype.initWorkflowStatus;
const originalRecord = SystemDatabase.prototype.recordOperationResult;
let injected = false;
let paused = false;
const mode = process.env.DELEGATION_SDK_FAULT;

function rejectQuery(args, error) {
  const callback = args.at(-1);
  if (typeof callback === "function") {
    queueMicrotask(() => callback(error));
    return;
  }
  return Promise.reject(error);
}
if (mode === "projection") {
  const { default: pg } = await import("pg");
  const originalQuery = pg.Client.prototype.query;
  let publications = 0;
  pg.Client.prototype.query = function (...args) {
    const query = typeof args[0] === "string" ? args[0] : args[0]?.text;
    if (
      typeof query === "string" &&
      /insert into "testing_publications"/.test(query) &&
      ++publications === 2
    ) {
      console.log("FAULT_INJECTED projection");
      return rejectQuery(args, new Error("Transient projection write failure"));
    }
    return originalQuery.apply(this, args);
  };
}

if (mode === "parent-drain") {
  const { default: pg } = await import("pg");
  const originalQuery = pg.Client.prototype.query;
  let failures = 0;
  pg.Client.prototype.query = function (...args) {
    const query = typeof args[0] === "string" ? args[0] : args[0]?.text;
    if (
      typeof query === "string" &&
      query.startsWith('update "testing_deliveries"') &&
      failures < 20
    ) {
      failures += 1;
      console.log("FAULT_INJECTED parent-drain");
      return rejectQuery(args, new Error("Transient delivery acknowledgement write failure"));
    }
    return originalQuery.apply(this, args);
  };
}

if (mode === "child-drain") {
  const { default: pg } = await import("pg");
  const { DBOS } = require("@dbos-inc/dbos-sdk");
  const { testingTransportState } = await import("../../server/harness/testing-child.ts");
  const originalQuery = pg.Client.prototype.query;
  pg.Client.prototype.query = function (...args) {
    const query = typeof args[0] === "string" ? args[0] : args[0]?.text;
    if (
      !injected &&
      typeof query === "string" &&
      query.includes('"testing_deliveries"') &&
      DBOS.isInWorkflow() &&
      DBOS.workflowID.startsWith("testing-atlassian-") &&
      testingTransportState(DBOS.workflowID) === "absent"
    ) {
      injected = true;
      console.log("FAULT_INJECTED child-drain");
      return rejectQuery(args, new Error("Transient delivery read failure after physical drain"));
    }
    return originalQuery.apply(this, args);
  };
}

SystemDatabase.prototype.initWorkflowStatus = async function (status, ...args) {
  if (
    status.workflowName === "testing-child-v1" &&
    ((!injected && mode === "no-status") || mode === "no-status-exhausted")
  ) {
    injected = true;
    console.log("FAULT_INJECTED no-status");
    throw new Error("Transient SDK start failure before status");
  }
  const result = await originalInit.call(this, status, ...args);
  if (!injected && status.workflowName === "testing-child-v1" && mode === "after-enqueue") {
    injected = true;
    paused = true;
    console.log("FAULT_CRASH_READY");
    await delay(60_000);
  }
  if (
    !injected &&
    status.workflowName === "testing-child-v1" &&
    status.status === "ENQUEUED" &&
    mode === "status-created"
  ) {
    injected = true;
    console.log("FAULT_INJECTED status-created");
    throw new Error("Transient SDK start failure after status");
  }
  return result;
};

SystemDatabase.prototype.recordOperationResult = async function (...args) {
  const name = args[2];
  if (!injected && mode === "status-created" && args[6]?.childWorkflowID) {
    injected = true;
    console.log("FAULT_INJECTED journal-failed");
    throw new Error("Transient parent-child journal write failure");
  }
  if (
    injected &&
    ["no-status", "status-created", "no-status-exhausted"].includes(mode) &&
    !paused &&
    typeof name === "string" &&
    (/^testing-[a-f0-9]{32}:settle$/.test(name) ||
      (mode !== "no-status-exhausted" && name.endsWith(":start-join")))
  ) {
    paused = true;
    console.log("FAULT_CRASH_READY");
    await delay(60_000);
  }
  return originalRecord.apply(this, args);
};
