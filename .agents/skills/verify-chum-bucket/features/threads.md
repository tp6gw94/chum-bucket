# Threads

Users create a blank conversation, choose an existing one, and share or reopen its fixed URL without accidentally starting model work.

## Sub-features

- `threads-empty-entry`: root chooser has no composer and creates nothing on arrival.
- `threads-create-entry`: chooser creation saves one blank thread.
- `threads-sidebar-entry` / `threads-mobile-entry`: desktop and mobile `新 thread` return to the chooser without insertion.
- `threads-create-sidebar` / `threads-mobile-new`: choosing `建立新對話` after either sidebar entry creates a distinct blank thread.
- `threads-choose-existing` / `threads-select-sidebar`: reopen the selected existing thread without creating another.
- `threads-direct-reload`: fixed URL hydrates persisted state.
- `threads-invalid-url`: malformed thread ID shows a user-visible error.

## How to get to it (user POV)

- Open the root URL; choose `建立新對話` or an existing `新對話` button.
- From a hydrated conversation, use sidebar `新 thread`, then chooser `建立新對話`; or select a thread row.
- Open or reload `/?threadId=<the created UUID>`.
- On a narrow screen, use `展開 thread 清單` if collapsed, then `新 thread` or a thread row.
- Open `/?threadId=invalid` to exercise malformed-link feedback.

## Driving it with Ego Browser

Preconditions:

- Fresh isolated database, Doctor pass, no external credentials required.
- The skill's Drive heredoc invokes `verifyThreads`; it covers every branch above and captures each step.

- **Chooser creation.** `await page.click("loc=role:button[name='建立新對話']")`. Wait for `section[aria-label="主對話"] [role="textbox"][contenteditable="true"]` and a UUID in the URL. Read `/api/thread/<UUID>`: messages `[]`, revision `0`.
- **Choose existing.** Return to root with `await page.goto(origin)`; with one thread, `await page.click("loc=role:button[name='新對話']")`. The URL uses that same UUID.
- **Sidebar creation.** `await page.click("loc=role:button[name='新 thread']")`; wait for `建立新對話` on the root chooser and confirm no insertion. Then `await page.click("loc=role:button[name='建立新對話']")`. The new UUID differs, and the collection count increases once.
- **Sidebar selection.** Determine the target row index from read-only `/api/thread`. `await page.click("loc=css:#thread-sidebar [role='list'] button >> nth=" + index)`. The URL matches the chosen ID and collection count stays unchanged.
- **Persistence.** `await page.goto(origin + "/?threadId=" + id)`; wait for the editable composer. Reload does not insert another row.
- **Mobile access.** `await page.cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })`. Click `收合 thread 清單`, then `展開 thread 清單`, then `新 thread`, then chooser `建立新對話`. Hidden sidebar has `aria-hidden="true"` and `inert`; expanded sidebar exposes controls.
- **Invalid URL.** `await page.goto(origin + "/?threadId=invalid")`; wait for `text=對話網址無效，請確認 threadId。`. No composer appears.
- **Proof.** Run `control.mjs inspect` as shown in the skill. Smoke produces exactly three empty rows and zero runs/events; proof artifacts remain after cleanup.

## Gotchas

- All new threads share their initial title. Global text selectors become ambiguous as soon as a second thread exists.
- Hydration is asynchronous; wait for `contenteditable="true"`, not a timer or merely the URL.
- Creating a thread does not send a prompt. Any run/event row during this smoke invalidates its no-model-work claim.
- A syntactically valid but absent UUID is different from a malformed URL; record absent-thread/error recovery separately when relevant.
