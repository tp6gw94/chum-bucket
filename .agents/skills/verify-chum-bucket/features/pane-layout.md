# Pane layout

Users show or hide the thread list, open and close placeholder side conversations, resize desktop panes, and scroll across panes on mobile.

## Sub-features

- `layout-sidebar`: toggle visibility and keyboard accessibility.
- `layout-open-main` / `layout-open-agent`: open a placeholder from either pane header.
- `layout-close`: close only the selected side pane.
- `layout-keyboard-size`: arrows, Shift+arrows, Home/End adjust desktop width.
- `layout-pointer-size`: drag the visible desktop separator.
- `layout-mobile-scroll`: navigate horizontally without a page-wide vertical overflow.

## How to get to it (user POV)

- Use the top bar `收合 thread 清單` / `展開 thread 清單`.
- Use `開啟附屬對話` in the main or an existing side pane.
- Use `關閉` in a side pane header.
- Focus or drag the right-edge width separator on desktop.
- On mobile, swipe the region `對話窗格，可左右捲動` to another pane.

## Driving it with Ego Browser

Preconditions:

- Ready thread; no model key needed. Desktop viewport at least 1024px for visible resize controls.
- Save before thread rows and run/event counts. These layout actions should not create durable agent work.

- **Sidebar.** `await page.click("loc=role:button[name='收合 thread 清單']")`; verify `#thread-sidebar` has `aria-hidden="true"` and `inert`. `await page.click("loc=role:button[name='展開 thread 清單']")`; verify visible controls and `aria-expanded="true"`.
- **Main entry.** `await page.click('loc=css:section[aria-label="主對話"] button:has-text("開啟附屬對話")')`. Section `附屬對話：附屬對話 1` appears with `尚未連接` and a noneditable composer.
- **Agent entry.** `await page.click('loc=css:section[aria-label="附屬對話：附屬對話 1"] button:has-text("開啟附屬對話")')`. A second placeholder appears; no run or new thread row is stored.
- **Close.** `await page.click('loc=css:section[aria-label="附屬對話：附屬對話 1"] button:has-text("關閉")')`. Only that section disappears; the main thread and second placeholder remain.
- **Keyboard width.** `const handle = 'loc=role:separator[name="調整「主對話」寬度"]'`; `await page.press(handle, "ArrowRight")` increases `aria-valuenow` by 24. `Shift+ArrowLeft` decreases it by 64. `Home` clamps to 320; `End` clamps to 960. Check actual rendered width on desktop alongside ARIA values.
- **Pointer width.** Read the separator's bounding rectangle with read-only `page.evaluate`, then use `page.mouse.move(x,y)`, `page.mouse.down()`, `page.mouse.move(x+80,y)`, `page.mouse.up()`. Observe rendered width and `aria-valuenow` increase, respecting bounds; capture the initial drag target.
- **Mobile.** Set width 390 with CDP as in threads. Take a screenshot, move the pointer into the pane region, and `await page.mouse.wheel(440, 0)`. Capture the visible placeholder after scrolling and verify its composer remains disabled.
- **Proof.** Compare read-only thread/run state before and after; reload confirms placeholders are session-only, not persisted conversations.

## Gotchas

- Side panes are deliberately UI placeholders. Their appearance is not agent execution or subagent routing proof.
- Resize separators are hidden below the lg breakpoint; ARIA width alone does not prove mobile sizing.
- Closing then reopening can reuse a numeric title. Use section scope and a fresh snapshot before selecting.
- Layout state resets on reload. Do not file its lack of persistence as a bug.
