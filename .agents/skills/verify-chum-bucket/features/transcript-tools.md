# Transcript and tool results

Users inspect rendered assistant output, expand tool argument disclosures, retain original messages after compaction, and return to the newest message.

## Sub-features

- `transcript-openui`: supported OpenUI Lang renders as components.
- `transcript-fallback`: unparseable text is visible with a raw-response notice.
- `transcript-tools`: inspect tool name, status, and inputs; verify output separately in stored events.
- `transcript-summary`: full summary and original messages survive reload.
- `transcript-latest`: jump to the newest message after scrolling away.

## How to get to it (user POV)

- Open a thread containing a real assistant reply.
- Select the reply's tool-argument disclosure when tools were invoked.
- Run /compact from the composer and inspect `壓縮摘要`.
- Scroll upward in the transcript, then choose `跳到最新` when present.

## Driving it with Ego Browser

Preconditions:

- External-enabled instance and permission for real model/tool access. Generate content by sending actual prompts, not fixture injection.
- Approved read-only Jira/Figma resources for tool proof; do not use unknown issue IDs or files as targets.
- For exact tool-result selectors, read the snapshot of the real reply before choosing a disclosure.

- **Rendered reply.** Submit `Reply with a short OpenUI Lang text component saying UI-VERIFY. Do not use tools.` through the composer recipe. Observe the rendered text/component and absence of parse warnings, then reload and confirm the same stored reply.
- **Fallback.** If a real reply cannot be parsed, observe `text=無法解析為 OpenUI Lang，以下為原始回覆。` with its raw content. A valid rendered reply does not cover fallback. Report not-run when no real fallback occurs.
- **Tool result.** Submit a scoped read-only request for an approved resource. Take a snapshot; use the actual `summary`/button text from it with `page.click`. Expanded input and displayed status must correspond to the requested resource and stored run/events. Tool output is not currently rendered in this disclosure; inspect its real result through stored events and the approved resource. Capture collapsed and expanded states. Observe the external resource with a read-only second view if its value is part of the claim.
- **Summary.** Follow compaction's completed recipe. Wait for `text=壓縮摘要`; inspect the full summary and originals, then revisit the same thread URL. Compare visible and stored text.
- **Latest.** Scroll within the transcript's message viewport using `page.mouse.wheel(0, -600)` after positioning over it from a screenshot. `await page.click("loc=role:button[name='跳到最新']")` when present. The newest actual message becomes visible.
- **Proof.** Save prompt action, streaming/result snapshots, screenshot, run ID, stored messages/events, and any read-only external evidence. Record stochastic or unavailable branches individually.

## Gotchas

- Tool disclosures start open and show arguments/status only. Click the observed summary to collapse, then click again to expand; do not require an output panel the UI does not implement.
- OpenUI responses are model-generated; a prompt is a request, not a guarantee of valid syntax or a particular tool call.
- The custom `src/library.ts` is not a substitute for observing the real rendered assistant reply.
- The latest button appears based on scroll state and can be absent when already at the end.
- Successful tool UI does not prove a side effect happened in Jira/Figma. Verify the actual approved external state, or limit the claim to display/read behavior.
- Never use test-only messages or direct SQL inserts to manufacture these transcript states.
