# Chum Bucket verification map

Read this maintained index before driving. Each feature file lists the user entry points and observable outcomes that constitute its coverage.

## Baseline preconditions

- Use the isolated instance and Doctor from [../SKILL.md](../SKILL.md).
- Thread smoke starts with no threads. Other features start with a thread created through the UI.
- Use one owned Ego Browser TaskSpace and its recorded page. Recipes assume `page` and the actual `origin` from `instance.json`.
- Default launch isolates credentials but does not block network. Successful chat, compaction with sufficient history, and external tools need explicit `VERIFY_EXTERNAL=1` and approval for real charges/resources.
- No browser login exists. Missing credentials, empty histories, and unconnected panes are distinct preconditions, not passing implementations.

## Driving conventions

Prefer accessible names and scoped CSS; preserve the literal Chinese UI labels. Thread titles are all initially `新對話`: use the read-only `/api/thread` response order to select a specific sidebar row, or a known thread URL. Scope main-pane controls so placeholder panes do not create ambiguous matches.

Record each action before dispatch, wait for its observable result, and capture snapshots/screenshots plus stored state. Change browser size through CDP `Emulation.setDeviceMetricsOverride`; return with `Emulation.clearDeviceMetricsOverride`. Use width 390 for mobile and at least 1024 for desktop resizing.

## Proof and skip reporting

Only threads are covered by the generated automated smoke. Record every remaining feature/branch as not-run unless separately exercised. An API fixture, direct state setter, or unit-test result is supplementary evidence, not user-path proof.

Each mutation needs a reload/reopen and read-only database or external-resource confirmation. Capture failures with attempted actions and unmet preconditions; do not silently replace an entry point with an easier one. Evidence location and cleanup contract live in the skill.

## Features

- [Threads](threads.md): chooser, sidebar, direct URLs, invalid URLs, persistence, desktop/mobile access.
- [Composer and chat](composer-chat.md): submit button, Enter, Shift+Enter, empty input, pending/error states, streamed/reloaded replies.
- [Context compaction](compaction.md): literal command, suggestion click, suggestion keyboard selection, skipped/completed/failed outcomes.
- [Pane layout](pane-layout.md): sidebar toggle, placeholder panes, close, keyboard/pointer sizing, mobile scrolling.
- [Transcript and tool results](transcript-tools.md): OpenUI replies/fallbacks, tool result expansion, summary/original retention, jump-to-latest.
