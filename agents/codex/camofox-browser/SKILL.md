---
name: camofox-browser
description: Browser automation with the camofox CLI for rendered webpages, JavaScript-heavy sites, interactive browsing, login/cookies, screenshots, downloads, Cloudflare challenge clicks, and extracting content from pages that are not simple API/JSON endpoints. Use when Codex needs to open, inspect, search, click, type, scroll, evaluate page JavaScript, capture screenshots, import browser cookies, or use the local Camofox server/CLI. Prefer direct HTTP, built-in web search, curl, gh, or local file reads for simple facts, REST APIs, JSON endpoints, raw downloads, GitHub source inspection, and local files.
---

# Camofox Browser

## Overview

Camofox is a local browser automation server with a CLI named `camofox`. Use it when the task needs a real rendered browser: JavaScript execution, page interaction, login state, screenshots, downloads, or content extraction from pages that are not simple APIs.

For ordinary current facts, public documentation, JSON APIs, raw downloads, GitHub source inspection, or local files, use the simpler direct tool first.

## Server Check

Before browser work, verify the CLI/server:

```bash
camofox health
```

If the command cannot connect, start the server:

```bash
camofox serve -d
```

The default server is `http://127.0.0.1:9377`. The CLI reads `CAMOFOX_URL`, `CAMOFOX_USER`, `CAMOFOX_SESSION`, `CAMOFOX_API_KEY`, and `CAMOFOX_ADMIN_KEY` when set. `camofox serve` auto-manages an API key at `~/.camofox/api-key`.

## Core Workflow

1. Open a tab:

```bash
camofox open https://example.com
```

The command prints a tab index such as `0`.

2. Read the page with the accessibility snapshot:

```bash
camofox snapshot 0
```

Snapshots show element refs like `e1`, `e2`, and `e3`.

3. Interact using refs:

```bash
camofox click 0 e1
camofox type 0 e3 "search text"
camofox press 0 Enter
camofox scroll 0 down 1000
```

4. Re-snapshot after navigation or major DOM changes because refs reset:

```bash
camofox wait 0
camofox snapshot 0
```

5. Close tabs when done:

```bash
camofox close 0
```

## Command Reference

Session commands:

```bash
camofox open <url>
camofox tabs
camofox health
camofox start
camofox stop
camofox close-session
camofox cookies
camofox transcript <youtube-url>
camofox markdown <url>
camofox serve [-d|status|stop|build]
```

Tab commands use `camofox <command> <tab> [args...]`, where `<tab>` can be a numeric index, domain substring, or UUID prefix:

```bash
camofox snapshot <tab>
camofox screenshot <tab> [file]
camofox goto <tab> <url>
camofox click <tab> <ref>
camofox type <tab> <ref> <text>
camofox press <tab> <key>
camofox scroll <tab> [up|down] [px]
camofox back <tab>
camofox forward <tab>
camofox refresh <tab>
camofox wait <tab>
camofox links <tab>
camofox images <tab>
camofox downloads <tab> [directory]
camofox eval <tab> <js-expression>
camofox solve <tab> [expected-css-selector]
camofox stats <tab>
camofox close <tab>
```

## Rules

Use `snapshot` as the primary page-reading tool. Use `screenshot` only for visual/layout questions or explicit screenshot requests.

Always snapshot before clicking or typing. Re-snapshot after clicks, form submits, navigation, reloads, or anything likely to change refs.

Prefer `links`, `images`, or `eval` when extracting structured data. For multi-statement JavaScript, wrap it in an IIFE:

```bash
camofox eval 0 '(() => { const rows = [...document.querySelectorAll("tr")]; return JSON.stringify(rows.map(r => r.textContent.trim())); })()'
```

Keep shell quoting simple: single quotes around JavaScript and double quotes inside JavaScript. Do not rely on top-level `await` in `eval`.

Use `camofox solve <tab>` only for passable Cloudflare interaction challenges. If a site requires an authenticated browser session, ask the user for cookies or use `camofox cookies` with a Chrome DevTools "Copy as cURL" request.

Use `camofox downloads <tab>` after clicking something that triggers a download. Add a directory argument to save captured files.

Use `camofox markdown <url>` when `CAMOFOX_MARKDOWN_URL` is configured and the task needs a full rendered Markdown artifact. It prints Markdown to stdout on success; errors go to stderr and exit non-zero. Treat failure, empty content, bot-challenge errors, or missing expected text as a signal to fall back to tab-based Camofox browsing.

Close tabs or run `camofox close-session` after large tasks to free resources.

## Sub-Agent Use

If the user explicitly asks Codex to delegate browser work to a sub-agent, spawn a bounded worker or explorer and attach this skill. Give the sub-agent a concrete target URL, extraction goal, and cleanup expectation. Do not spawn a sub-agent just because Camofox is useful.
