import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const enabled = process.env.SIDE_CHAT_TEST_DATABASE_URL;

function runProcess(source: string) {
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", source],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: enabled,
        MODEL_API_KEY: "offline",
        JIRA_BASE_URL: "",
        JIRA_EMAIL: "",
        JIRA_API_TOKEN: "",
        ATLASSIAN_MCP_URL: "",
      },
      encoding: "utf8",
      timeout: 20_000,
    },
  );
  const line = output.split("\n").find((line) => line.startsWith("EVIDENCE "));
  assert.ok(line, output);
  return JSON.parse(line.slice(9)) as Record<string, unknown>;
}

const imports = `
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { eq } from 'drizzle-orm';
import { threadsTable, chatRunsTable, sideChatsTable } from './server/db/schema.ts';
import { database, BUILD, PREVIOUS_BUILD, persistRun, openSideChat, hydrateThread } from './server/harness/run-store.ts';
import { ensureStarted, launchChatRuntime, shutdownChatRuntime } from './server/harness/run.ts';
const db = await database();
`;

const slowProvider = `
let called = false;
globalThis.fetch = async () => {
 called = true;
 return new Response(new ReadableStream({start(controller) {
  controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({id:'slow', choices:[{index:0,delta:{role:'assistant',content:'partial'},finish_reason:null}]})+'\\n\\n'));
 }}), {headers:{'Content-Type':'text/event-stream'}});
};
`;

test(
  "a prior process child is cancelled before SDK recovery, while a legacy main run still completes",
  { skip: !enabled, timeout: 60_000 },
  () => {
    const child = runProcess(
      imports +
        slowProvider +
        `
DBOS.setConfig({name:'chum-bucket-chat', applicationVersion:PREVIOUS_BUILD, systemDatabaseUrl:process.env.DATABASE_URL});
await DBOS.launch();
const parentId = randomUUID();
await db.insert(threadsTable).values({id:parentId,title:'Startup parent',messages:[]});
const side = await openSideChat(parentId, randomUUID(), {scope:randomUUID()});
const accepted = await persistRun({threadId:side.id,runId:'abandoned-'+randomUUID(),baseRevision:0,message:{id:'abandoned-user',text:'STARTUP CHILD'}},{scope:(await db.select().from(sideChatsTable).where(eq(sideChatsTable.id,side.id)))[0].page_scope});
await ensureStarted(accepted.run);
while (!called) await delay(10);
const childId = side.id;
const childRunId = accepted.run.runId;
const id = randomUUID();
await db.insert(threadsTable).values({id,title:'Legacy main',messages:[]});
const mainAccepted = await persistRun({threadId:id,runId:'legacy-'+randomUUID(),baseRevision:0,message:{id:'legacy-user',text:'LEGACY MAIN '+id}});
const run = {...mainAccepted.run,build:PREVIOUS_BUILD};
await db.update(chatRunsTable).set({accepted:run}).where(eq(chatRunsTable.id,run.runId));
await ensureStarted(run);
while (!called) await delay(10);
console.log('EVIDENCE '+JSON.stringify({childId,runId:childRunId,parentId,threadId:id,mainRunId:run.runId}));
process.exit(0);
`,
    );
    const result = runProcess(
      imports +
        `
let childCalls = 0;
let mainCalls = 0;
globalThis.fetch = async (_url, init) => {
 const body = String(init?.body);
 if (body.includes('STARTUP CHILD')) childCalls++;
 if (body.includes(${JSON.stringify(child.threadId)})) mainCalls++;
 const chunks = [{id:'answer',choices:[{index:0,delta:{role:'assistant',content:'Recovered main'},finish_reason:null}]},{id:'answer',choices:[{index:0,delta:{},finish_reason:'stop'}]}];
 return new Response(chunks.map(chunk=>'data: '+JSON.stringify(chunk)+'\\n\\n').join('')+'data: [DONE]\\n\\n',{headers:{'Content-Type':'text/event-stream'}});
};
await launchChatRuntime();
for(let attempt=0;attempt<200 && (await hydrateThread(${JSON.stringify(child.threadId)})).activeRun;attempt++) await delay(20);
const side = (await db.select().from(sideChatsTable).where(eq(sideChatsTable.id,${JSON.stringify(child.childId)})))[0];
const state = await hydrateThread(${JSON.stringify(child.threadId)});
const status = await DBOS.getWorkflowStatus(${JSON.stringify(child.runId)});
console.log('EVIDENCE '+JSON.stringify({childCalls,mainCalls,state:side.state,seed:side.seed,draft:side.draft,status,mainRoles:state.messages.map(message=>message.role),mainActive:state.activeRun}));
await shutdownChatRuntime();
`,
    );
    assert.deepEqual(result, {
      childCalls: 0,
      mainCalls: 1,
      state: "closed",
      seed: null,
      draft: null,
      status: null,
      mainRoles: ["user", "assistant"],
      mainActive: null,
    });
  },
);
