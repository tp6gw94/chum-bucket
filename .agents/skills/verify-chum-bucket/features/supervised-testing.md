# Supervised testing

Read this branch after changes to `run_tests`, testing workflows, role tools, projections, cancellation, or `TestingPanel`. Unit tests and the empty-thread smoke do not prove this feature.

## Preconditions

Use the isolated launch and owned TaskSpace from [../SKILL.md](../SKILL.md). Start each independent scenario with a UI-created thread. A same-thread reuse scenario continues its original thread.

Successful execution needs external model and source responses. Choose one boundary explicitly:

- Approved live resources and charges: use the skill's external launch instructions. Synthetic Jira/Figma IDs are not approved live resources.
- Disclosed external fixtures: preload a recorded fixture through the existing provider/MCP/Figma boundaries in the isolated backend. Record its path, hash, fake credential setup, unknown-resource rejection, and child-process inheritance. Keep the real app API, PostgreSQL owner, DBOS starts/joins/checkpoints, cancellation transport, and browser UI intact.

Freeze the source before launching. A source change requires a new instance. Record all scenarios as pass, fail, or not-run; the following list is an acceptance map, not a claim that they have passed.

## User paths and evidence

Submit through `section[aria-label="主對話"] [role="textbox"]` and the real send control. Record the literal request before dispatch. Read public responses and SQL afterward; arrange neither successful artifacts nor reports through API mutations, setters, or SQL writes.

| Branch                                                    | Observable result                                                                        | Stored or runtime proof                                                                                        |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Fresh request with functional and style checks            | `測試角色進度` has Atlassian, Planner, AC, UI; progress precedes the ordinary `測試報告` | Real child workflow IDs, private journals, canonical artifacts and linked native receipts                      |
| Same-thread requirements/plan reuse                       | Original provenance retained; only missing AC/UI work starts                             | Pinned references and two new producer workflows, no replacement source/plan model calls                       |
| Plan without style checks                                 | UI is not required, not a simulated completed child                                      | No UI reservation/start/Figma effect                                                                           |
| Explicit invalid or incompatible references               | Visible rejection; no fallback producers                                                 | No new testing rows or standalone root claim                                                                   |
| UI producer failure                                       | Valid AC results remain in the blocked report                                            | AC artifact retained; failed UI decision and root outcome distinguish lifecycle from judgment                  |
| Cancellation during actual work                           | `取消測試` becomes pending, then an authoritative blocked terminal report                | Durable cancel intent/outbox, actual transport abort and physical quiet before claim release                   |
| Reload while cancelling and after finish                  | Same run identity, monotonic version and final report survive                            | Hydration matches the stored published projection; no private child tail                                       |
| Ordinary main chat and a side conversation                | Main streaming remains usable; side cannot delegate tests                                | No test-generated side room; direct/discovery/Code Mode policy rejects forbidden delegation                    |
| Restart between child starts/joins or after Figma capture | Operation resumes without losing accepted partial results                                | Real DBOS recovery, unchanged ordered function IDs, no repeated completed external effects or renewed deadline |

A mock observation is not a real website PASS. Preserve the mock-only disclaimer, independent observed values, structured case/check/action metadata, style capture digest/time, tolerance units, and acceptance reasons in the report.

## Pane and accessibility controls

- Save screenshots and accessibility snapshots of active progress, final report, cancelled/failed partial report, and reload. Scope each panel by its `data-run-id`.
- While reading above the bottom, receive only a testing projection update; retain the reading position. At the bottom, content growth should follow. The existing jump-to-latest control must still work.
- Verify the report's `aria-live="off"` boundary and the concise `測試狀態摘要` polite/atomic status without disabling the chat log. Mark real screen-reader testing not-run unless performed.
- Test desktop and 390px mobile layouts, long references, and multiple operations. Side panes must not receive testing panels.
- Check read-only public event bodies for private prompts, raw source/model output, or child stream events. Report summaries may contain Host-validated structured results.

## Completion

Retain actions, before/after snapshots, screenshots, read-only SQL evidence, external fixture logs, and DBOS recovery/cancellation evidence under the owned evidence directory. A screenshot or HTTP 200 alone is insufficient. Complete the skill's exact-resource cleanup and retain evidence afterward. Report hydration's current latest-operation-only limit separately from same-session multiple-operation support.
