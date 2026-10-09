---
name: verify-chum-bucket
description: Verify Chum Bucket's real chat web UI and PostgreSQL side effects after thread, composer, compaction, transcript, or pane changes; launch isolated instances, drive Ego Browser, and retain evidence.
---

# Verify Chum Bucket

Read [features/README.md](features/README.md), then the matching feature file. Full feature proof covers every listed entry point; report individual branches as pass, fail, or not-run. The executable smoke recipe covers threads only, not chat or compaction.

The primary surface is the React/Vite web app. Hono exposes `/api/thread`, `/api/chat`, and `/api/compact`; PostgreSQL holds threads, runs, events, and DBOS checkpoints. `scripts/mcp-atlassian.ts` is a supporting service, not the app's primary user entry.

## Launch

Run from the checkout root. Require Node, pnpm, Docker, `lsof`, and connected `ego-browser`. Install dependencies with `pnpm install --frozen-lockfile` when missing. Run `pnpm typecheck` and `pnpm build`; resolve failures before driving. Build regenerates `src/generated/spec.json`; inspect any resulting diff without overwriting existing user edits.

The ordinary development command is `pnpm dev`, with Vite proxying to port 3000. Verification uses the same `vite.config.js` and `server/index.ts`, with separate ports and a disposable PostgreSQL 17 container instead of the user's `.env` database. No seeded data or browser authentication is needed for thread creation.

```bash
export VERIFY_SKILL="$PWD/.agents/skills/verify-chum-bucket"
export EVIDENCE="/tmp/chum-bucket-verification/$(date +%Y%m%d-%H%M%S)-$RANDOM"
docker image inspect postgres:17-alpine >/dev/null
node "$VERIFY_SKILL/scripts/control.mjs" launch "$EVIDENCE"
```

If the image is missing, run `docker pull postgres:17-alpine`, then retry. Launch never pulls implicitly. Success prints `status: pass` and the actual loopback `origin`; `launch.log` contains `READY <origin>`. The controller automatically runs Doctor after both HTTP servers and the schema are ready. Use a new evidence directory for each attempt.

The helper launches its own detached supervisor, direct Node/tsx backend, Vite server, and uniquely labeled container. PostgreSQL data lives in container tmpfs; frontend optimization uses this run's `vite-cache`. Application, controller, and database ports are allocated dynamically. Parallel runs require separate evidence directories and TaskSpaces; never attach to a pre-existing app or share its database. Launch errors attempt teardown and retain logs. Read `instance.json` before any recovery; it names only this run's resources.

Default launch empties model/Jira/Figma credentials in the backend environment. This is credential isolation, **not** a dry-run or network sandbox: submitting chat still attempts provider access. For chat, successful compaction, or tool verification, explicitly launch with `VERIFY_EXTERNAL=1 node "$VERIFY_SKILL/scripts/control.mjs" launch "$EVIDENCE"`. This enables `.env` credentials and real model charges; only use approved external resources. `DATABASE_URL` is always replaced with the disposable database. Avoid exposing credential values in evidence.

Teardown: `node "$VERIFY_SKILL/scripts/control.mjs" cleanup "$EVIDENCE"` after closing the browser TaskSpace, including after failed attempts.

## Doctor

```bash
node "$VERIFY_SKILL/scripts/control.mjs" doctor "$EVIDENCE"
```

This read-only check requires authenticated supervisor identity, the launch-time source fingerprint, exact listener PID ownership, the labeled running container, database `verify`, a working Vite entry, and HTTP 200 with an array from the real `/api/thread` proxy. A changed runtime source tree requires a fresh launch. External credentials are not validated by Doctor: a real successful chat/tool action is required for that claim. Run Doctor first whenever an instance looks wrong; `launch.log` distinguishes schema, DBOS, port, and provider failures.

The initial real-browser proof observed an `Invalid hook call` rejection from the TanStack AI devtools' Solid shell in Vite development mode. Thread UI and persistence still passed. Retain and report this separately; a passing thread recipe does not certify devtools or an error-free browser console.

## Drive

Use the repo's real UI through Ego Browser. Read the installed `ego-browser` skill before manual browser operation; its selector API is not Playwright. Give `nodejs` a heredoc reaching EOF, or redirect `-e` stdin from `/dev/null`.

For the complete thread smoke on a fresh empty database:

```bash
ego-browser nodejs <<EOF
const { verifyThreads } = await import("$VERIFY_SKILL/scripts/thread-proof.mjs");
await verifyThreads({ taskSpace, evidenceDir: "$EVIDENCE" });
EOF
node "$VERIFY_SKILL/scripts/control.mjs" inspect "$EVIDENCE"
```

The helper prints the TaskSpace ID immediately, saves it in `browser.json`, drives chooser creation directly and after returning from the desktop/mobile sidebar, reopens a stored thread through chooser/sidebar/direct URL, checks invalid URLs, and finishes its TaskSpace on success. It uses actual button clicks and read-only API observations, never API mutations or internal setters. Require `threads-result.json` with `status: pass`, and `database.json` with exactly three empty threads, zero runs, and zero events.

When already operating a TaskSpace for this verification goal, pass `existingSpaceId` with its recorded ID to `verifyThreads`; reuse page `p1`. On helper failure, read `browser.json` and `threads-failure.txt`, recover within that same space, and keep artifacts. User control or browser permission prompts require handoff rather than bypass. Finish the owned space after successful recovery; never claim or clear the user's unrelated tabs/profile.

For manual features, create one TaskSpace, print its ID, obtain `page = task.page("p1")`, and navigate to `instance.json`'s origin. Reuse that TaskSpace in every later invocation. The feature recipes assume these variables. Stable handles include `建立新對話`, `新 thread`, `收合 thread 清單`, and `section[aria-label="主對話"] [role="textbox"]`. Save the action before dispatch, wait for its specified result, then save the snapshot and screenshot.

Existing `pnpm check:thread-browser` requires externally supplied `PLAYWRIGHT_MODULE` and optionally `CHROMIUM_EXECUTABLE`; its companion server is `pnpm dev:thread-browser`. It mocks the entire API and sometimes installs `window.api`; it is useful regression coverage but does not prove the real app, persistence, or provider integration. `pnpm check:compaction-offline` is likewise supplementary, not a substitute for browser proof.

## Evidence

All proof stays in `$EVIDENCE`, outside the checkout. Save:

- `instance.json`, `launch.log`, and Doctor output for build/resource identity.
- `actions.jsonl`: feature ID, entry point, literal action, timestamp, and resulting URL/status. Write the action before running it so failed attempts remain visible.
- Before/after `*.aria.txt` snapshots and `*.png` screenshots; thread proof captures each action plus persisted `thread-*.json` and `threads-after.json`.
- `database.json` from `control.mjs inspect`, using read-only queries against only the labeled disposable container. For chat/compaction also capture matching run/event state and the reloaded transcript. Persist relevant responses or SSE observations with the run ID.
- A result report listing every mapped branch as pass/fail/not-run. One convenient entry point does not stand in for other listed entries.

Proof means the real user path, action plus resulting state, and the corresponding stored or external side effect. A successful HTTP status or final screenshot alone is insufficient. Reload/reopen user-visible state and check stored rows/files/messages as applicable. Mocks belong only at already isolated production boundaries, must be disclosed, and cannot support a claim about the real external service. Never seed the expected result through setters, direct DB writes, or test-only endpoints.

The thread recipe intentionally sends no chat or compaction request. Observe zero `chat_runs` and `chat_events` alongside the three new empty thread rows; this proves thread creation did not schedule model work, not that all network egress is blocked. There is no app-wide dry-run mode. Any proposed safe-mode proof must observe the files/network/DB/external resources it actually changes rather than infer safety from its name.

## Cleanup

For a successful browser run, the helper already called `task.finish({ keep: [] })`. For manual success, await that call once. On browser errors/user takeover, follow the browser skill's recovery/handoff rules; retain the space ID and report any remaining space rather than closing user-owned tabs.

```bash
node "$VERIFY_SKILL/scripts/control.mjs" cleanup "$EVIDENCE"
find "$EVIDENCE" -maxdepth 1 -type f -print
```

Cleanup authenticates the run's controller, terminates its exact backend child, closes its Vite/controller listeners, removes only its token-labeled container and tmpfs data, and deletes only `vite-cache`. It checks the recorded ports and container are gone; `instance.json` gains `cleanedAt`. It never kills by process name or removes evidence. A failed teardown is a failed run: inspect the recorded identities and report blockers instead of broadly killing Node/Docker processes.

Confirm `threads-result.json`, `actions.jsonl`, screenshots, snapshots, and `database.json` still exist after teardown. `/tmp` survives this cleanup but can be removed by the operating system; copy evidence elsewhere if longer retention is needed.

## Helpers

- `node "$VERIFY_SKILL/scripts/control.mjs" launch "$EVIDENCE"`: isolated app/schema startup and Doctor.
- `node "$VERIFY_SKILL/scripts/control.mjs" doctor "$EVIDENCE"`: read-only identity/readiness check.
- `node "$VERIFY_SKILL/scripts/control.mjs" inspect "$EVIDENCE"`: Doctor plus saved read-only DB proof.
- `node "$VERIFY_SKILL/scripts/control.mjs" cleanup "$EVIDENCE"`: owned-resource teardown, evidence retained.
- `thread-proof.mjs`: import and call through the Ego Browser heredoc in Drive; it requires `taskSpace` from that runtime, not plain Node.

Both helper files are executable; invoke them as shown above. The canonical skill is `.agents/skills/verify-chum-bucket`; `.pi/skills/verify-chum-bucket` links to it. Use `/maintain-verification-skill` when user paths, selectors, launch requirements, or proof standards change.
