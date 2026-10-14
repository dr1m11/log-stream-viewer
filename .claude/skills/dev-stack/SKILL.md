---
name: dev-stack
description: Start the mock server and the web app together, open the app in Chrome through the chrome-devtools MCP server and check that the live stream works (connection status, growing counter, clean console). Use to run the app, to see a change working in the browser, or before a performance trace.
argument-hint: '[rate events/s, default 200] [scenario: steady | error-burst | traffic-spike]'
allowed-tools: Read, Bash(pnpm dev*), Bash(pnpm ports:free*), Bash(curl -s*), mcp__chrome-devtools
---

# Run the dev stack and check it in the browser

Arguments: `$ARGUMENTS` — optional rate and scenario. Requires `apps/web` and `apps/mock-server` (stage B1, PR3–PR4).

1. `pnpm ports:free` — stops leftover servers of this repo on 5173/4173/8787 (another project's server on the same port is reported and left alone; then ask the user before going on).
2. Start `pnpm dev` with `run_in_background: true` (the `guard-bash` hook blocks it in the foreground). It runs the mock server on :8787 and Vite on :5173.
3. Wait for both without `sleep`:
   - `curl -s --retry 30 --retry-delay 1 --retry-connrefused http://localhost:8787/healthz` → JSON with `"status":"ok"`;
   - `curl -s -o /dev/null -w "%{http_code}" --retry 30 --retry-delay 1 --retry-connrefused http://localhost:5173/` → `200`.
   If either fails, read the background task output and report the error instead of retrying blindly.
4. With the chrome-devtools MCP server: open `http://localhost:5173/?rate=<rate>&scenario=<scenario>` in a new page, wait for the text "Connected", take a snapshot.
5. Check the stream: take a second snapshot ~2 s later and confirm the received-events counter grew; list console messages (expect none at error level) and network requests (one WebSocket to `ws://localhost:8787/ws`).
6. If the task is about performance, record a trace (`performance_start_trace` / `performance_stop_trace`) while the stream runs and summarize the insights (long tasks, INP, layout shifts) with numbers.
7. Report: status, counters, console/network findings, screenshots for UI changes.
8. Clean up unless the user wants the stack to keep running: close the page, stop the background task, run `pnpm ports:free` again (on Windows child processes can survive their parent).
