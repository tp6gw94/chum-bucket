# Composer and chat

Users write a message, send it, see the streamed answer, and recover their original draft when sending fails.

## Sub-features

- `composer-empty`: blank or whitespace-only input cannot submit.
- `composer-button` / `composer-enter`: button and Enter submit the typed message.
- `composer-multiline`: Shift+Enter inserts a newline instead of submitting.
- `composer-pending`: hydration/running blocks new input and duplicate submission.
- `composer-success`: successful terminal state clears the draft; transcript persists.
- `composer-error`: error/uncertain state keeps the original text and exposes feedback.

## How to get to it (user POV)

- Create/select a thread, then use the main pane's message input.
- Choose `送出`, or press Enter in that editor.
- Press Shift+Enter while editing multiline text.
- After a failed/uncertain send, inspect the draft and use `重新載入` when offered.

## Driving it with Ego Browser

Preconditions:

- Hydrated thread; scope `const editor = 'loc=css:section[aria-label="主對話"] [role="textbox"]'`.
- Successful chat requires an external-enabled instance with a valid model key and permission for charges. Prompt only for a short response without tools.
- Default credentials-disabled mode is not an offline negative test; it can still contact Deepinfra.

- **Empty input.** `await page.fill(editor, "   ")`; read the scoped `button[type="submit"]` disabled property. `await page.press(editor, "Enter")` must add no run or message.
- **Button entry.** `await page.fill(editor, "Reply with HELLO-VERIFY. Do not use tools.")`, then `await page.click('loc=css:section[aria-label="主對話"] button[type="submit"]')`. Observe the user's exact message and streamed assistant response.
- **Keyboard entry.** On a ready thread, `await page.fill(editor, "Reply with SECOND-VERIFY. Do not use tools.")`, then `await page.press(editor, "Enter")`. Verify one new successful run, not duplicates.
- **Multiline.** `await page.fill(editor, "First line")`; `await page.press(editor, "Shift+Enter")`; `await page.keyboard.insertText("Second line")`. The draft contains both lines and no new run until explicitly sent.
- **Pending.** After dispatch, wait for scoped editor `contenteditable="false"`; capture pending UI if observable. Record not-observed if the actual response is too fast. After completion wait for editable input and an empty draft.
- **Persistence.** Save the thread URL, navigate to it again, and wait for hydration. Both original prompt and assistant response remain; `database.json` shows a matching succeeded run and stored messages.
- **Failure.** If a real approved provider/network failure occurs, capture the alert, preserved draft, failed/uncertain run, and reloaded state. Feedback may be `執行失敗，原文已保留。` or `結果尚未確認，請重新載入對話，原文已保留。`. Do not deliberately revoke the user's key or modify shared services.

## Gotchas

- The editor is contenteditable Tiptap, not a textarea. Its accessible name contains the thread UUID.
- Scope `送出` to the main pane; placeholder panes have their own disabled buttons.
- API acceptance or partial text is not terminal success; require the reloaded transcript and succeeded run.
- IME composition should not trigger Enter submission. Test with actual composition input when changing that behavior; ordinary Enter does not prove it.
