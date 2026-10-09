# Context compaction

Users run /compact to shorten model context while preserving the full original transcript and the resulting summary.

## Sub-features

- `compact-literal`: submit the complete command with the send button.
- `compact-menu-click`: choose the command suggestion.
- `compact-menu-keyboard`: navigate/accept the suggestion with keyboard.
- `compact-dismiss`: Escape dismisses suggestions without submitting.
- `compact-skipped`: insufficient history reports no change.
- `compact-done` / `compact-failed`: completed summary or explicit failure retains original history.

## How to get to it (user POV)

- Type `/compact` in the main message input and choose `送出`.
- Type `/` or `/comp`, then click the `/compact` option in `對話命令`.
- With suggestions open, use ArrowUp/ArrowDown and Enter; Escape dismisses the menu.

## Driving it with Ego Browser

Preconditions:

- Ready main thread and scoped editor as in composer-chat.
- Empty/fresh thread for skipped proof; external-enabled instance plus sufficient real conversation history for completed proof. If the app skips a short history, record skipped rather than successful compaction.
- Preserve a before-transcript and read-only database snapshot.

- **Dismiss.** `await page.fill(editor, "/")`; `await page.press(editor, "End")` if the cursor is not at the end. Wait for `loc=role:listbox[name='對話命令']`. `await page.press(editor, "Escape")`; the menu disappears while draft `/` remains, with no new run.
- **Literal/button.** `await page.fill(editor, "/compact")`; `await page.click('loc=css:section[aria-label="主對話"] button[type="submit"]')`. Wait for the terminal notice and re-enabled editor.
- **Suggestion click.** `await page.fill(editor, "/comp")`; wait for the command menu, then `await page.click("loc=role:option[name*='/compact']")`. This submits the command rather than only completing the draft.
- **Suggestion keyboard.** `await page.fill(editor, "/")`; wait for the menu; `await page.press(editor, "ArrowDown")`, `await page.press(editor, "ArrowUp")`, `await page.press(editor, "Enter")`. Exactly one compaction run appears.
- **Skipped outcome.** Wait for `text=目前沒有足夠的可整理歷史，原文與上下文未變更。`; compare before/after messages. No user `/compact` message or fabricated summary should be added. Store matching run state and compaction events.
- **Completed outcome.** Wait for `text=上下文已整理，完整摘要與原文已保留。`; inspect `壓縮摘要` and original messages, then reload the fixed URL. Read stored messages and compaction events; the full summary and originals remain.
- **Failed outcome.** Capture `text=整理上下文失敗，原文與上下文已保留。` if a real failure occurs; compare originals and draft. Report unexercised failure coverage if no safe production-boundary failure is available.

## Gotchas

- Enter with suggestions open selects and submits immediately.
- Only the exact trimmed `/compact` is the command; `/compact more text` is ordinary chat.
- A success notice without a summary is not proof of completed compaction; skipped is a separate outcome.
- Compaction modifies model context, not the displayed history length. Preserve and compare the original transcript.
- Command dispatch creates durable work even when history is too short. Inspect what was actually stored/contacted rather than assuming skipped means side-effect free.
