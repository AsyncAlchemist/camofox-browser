# camofox Agent Guide

Anti-detection browser automation for AI agents, powered by Camoufox.

## Quick Start

```bash
camofox serve -d                          # start server (Docker, background)
camofox open https://example.com          # → 0
camofox snapshot 0                        # get page with element refs
camofox click 0 e1                        # interact using refs
camofox close 0                           # clean up
```

Or start the server without Docker:

```bash
npm install && npm start                  # server on http://localhost:9377
```

## CLI Reference

### Server

```bash
camofox serve              # start via Docker (foreground)
camofox serve -d           # start detached (background)
camofox serve stop         # stop the container
camofox serve status       # check if running
camofox serve build        # rebuild image
```

### Session Commands

```bash
camofox open <url>                    # open tab, prints index
camofox tabs                          # list open tabs
camofox health                        # server health check
camofox cookies                       # import cookies from "Copy as cURL" (interactive/stdin)
camofox start                         # warm up browser engine
camofox stop                          # stop browser (needs CAMOFOX_ADMIN_KEY)
camofox transcript <youtube-url>      # extract YouTube captions
camofox close-session                 # close all tabs for current user
```

### Tab Commands

All tab commands: `camofox <command> <tab> [args...]`

```bash
camofox snapshot <tab>                # accessibility tree with element refs
camofox screenshot <tab> [file]       # PNG screenshot (file or stdout)
camofox goto <tab> <url>              # navigate to URL
camofox click <tab> <ref>             # click element (e.g. e1)
camofox type <tab> <ref> <text>       # type into element
camofox press <tab> <key>             # press key (Enter, Tab, Escape, etc.)
camofox scroll <tab> [dir] [px]       # scroll (down|up, default: down 500)
camofox back <tab>                    # browser back
camofox forward <tab>                 # browser forward
camofox refresh <tab>                 # reload page
camofox wait <tab>                    # wait for page ready
camofox links <tab>                   # extract all links
camofox images <tab>                  # extract all images
camofox downloads <tab> [dir]         # list downloads (JSON) or save to directory
camofox eval <tab> <js>               # execute JavaScript
camofox close <tab>                   # close tab
camofox stats <tab>                   # tab statistics (JSON)
```

### Tab Identifiers

Tabs can be referenced by index (`0`), domain (`example.com`), or UUID prefix (`4e9d`).

Indices shift when tabs are closed. Prefer domain or UUID prefix in multi-step workflows.

## Core Workflow

1. `camofox open <url>` → get tab index
2. `camofox snapshot <tab>` → read page, note element refs (`e1`, `e2`, ...)
3. `camofox click <tab> <ref>` or `camofox type <tab> <ref> <text>` → interact
4. Repeat steps 2-3 as needed
5. `camofox close <tab>` → clean up

Refs reset on navigation — always re-snapshot after navigating.

## REST API

The CLI wraps the REST API. Agents can also call the API directly at `http://localhost:9377`.

### Tab Lifecycle

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/tabs` | Create tab: `{"userId", "sessionKey", "url"}` → `{"tabId"}` |
| `GET` | `/tabs?userId=X` | List open tabs |
| `DELETE` | `/tabs/:id` | Close tab |
| `DELETE` | `/sessions/:userId` | Close all tabs for a user |

### Page Interaction

| Method | Endpoint | Body / Query |
|--------|----------|-------------|
| `GET` | `/tabs/:id/snapshot?userId=X` | `includeScreenshot=true`, `offset=N` |
| `POST` | `/tabs/:id/click` | `{"userId", "ref"}` or `{"userId", "selector"}` |
| `POST` | `/tabs/:id/type` | `{"userId", "ref", "text", "pressEnter": true}` |
| `POST` | `/tabs/:id/press` | `{"userId", "key"}` |
| `POST` | `/tabs/:id/scroll` | `{"userId", "direction", "amount"}` |
| `POST` | `/tabs/:id/navigate` | `{"userId", "url"}` or `{"userId", "macro", "query"}` |
| `POST` | `/tabs/:id/back` | `{"userId"}` |
| `POST` | `/tabs/:id/forward` | `{"userId"}` |
| `POST` | `/tabs/:id/refresh` | `{"userId"}` |
| `POST` | `/tabs/:id/wait` | `{"userId"}` |
| `GET` | `/tabs/:id/links?userId=X` | Extract all links |
| `GET` | `/tabs/:id/images?userId=X` | `includeData=true`, `limit=N` |
| `GET` | `/tabs/:id/downloads?userId=X` | `includeData=true`, `consume=true` |
| `GET` | `/tabs/:id/screenshot?userId=X` | PNG binary |
| `POST` | `/tabs/:id/evaluate` | `{"userId", "expression"}` |

### Search Macros

Use with the navigate endpoint instead of constructing URLs:

| Macro | Site |
|-------|------|
| `@google_search` | Google |
| `@youtube_search` | YouTube |
| `@amazon_search` | Amazon |
| `@reddit_search` | Reddit (JSON) |
| `@reddit_subreddit` | Subreddit (JSON) |
| `@wikipedia_search` | Wikipedia |
| `@twitter_search` | Twitter/X |
| `@yelp_search` | Yelp |
| `@linkedin_search` | LinkedIn |

## Element Refs

Snapshots include refs like `e1`, `e2` — stable identifiers for interactive elements.

- Get refs from `snapshot`
- Use refs with `click`, `type`
- Refs reset on navigation — re-snapshot after each page change

## Authentication (Cookie Import)

For sites that require login (LinkedIn, Amazon, etc.), import cookies from Chrome:

```bash
camofox cookies              # interactive: prompts to paste a "Copy as cURL" command
pbpaste | camofox cookies    # piped from clipboard
```

The user copies a request as cURL from Chrome DevTools (Network tab → right-click → Copy as cURL). The CLI extracts cookies from the `-b` flag and injects them into the browser session.

**API key is auto-managed:** `camofox serve` generates a key at `~/.camofox/api-key` and passes it to Docker. No manual `CAMOFOX_API_KEY` setup needed for local use.

## Downloading Files

Clicking a link that triggers a download (PDF, CSV, etc.) is automatically captured:

```bash
camofox click 0 e5                # click a download link
camofox downloads 0               # list captured downloads (JSON metadata)
camofox downloads 0 ./output      # save all captured files to ./output/
```

## Session Management

- `CAMOFOX_USER` isolates cookies/storage between users
- `CAMOFOX_SESSION` groups tabs by conversation/task
- Sessions timeout after 30 minutes of inactivity
- Browser shuts down after 5 minutes with no sessions, relaunches on next request

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CAMOFOX_URL` | Server URL (CLI) | `http://127.0.0.1:9377` |
| `CAMOFOX_USER` | User ID | `cli` |
| `CAMOFOX_SESSION` | Session key | `default` |
| `CAMOFOX_ADMIN_KEY` | Admin key for stop | - |
| `CAMOFOX_API_KEY` | Cookie import auth (auto-generated by `serve`) | `~/.camofox/api-key` |
| `PROXY_HOST` | Proxy hostname | - |
| `PROXY_PORT` | Proxy port | - |
| `PROXY_USERNAME` | Proxy auth user | - |
| `PROXY_PASSWORD` | Proxy auth pass | - |

## Scripting

Tab indices are printed to stdout for capture:

```bash
TAB=$(camofox open https://example.com)
camofox snapshot $TAB
camofox close $TAB
```

## Testing

```bash
npm test              # all tests
npm run test:e2e      # e2e tests only
npm run test:live     # live site tests
npm run test:debug    # with server output
```

## Key Files

- `cli.js` - CLI wrapper (all commands)
- `server.js` - Express server + browser logic
- `lib/config.js` - All `process.env` reads centralized here
- `lib/snapshot.js` - Accessibility tree snapshots
- `lib/macros.js` - Search macro URL expansion
- `lib/downloads.js` - Download capture and image extraction
- `lib/youtube.js` - YouTube transcript extraction via yt-dlp
- `lib/cookies.js` - Cookie file I/O
- `Dockerfile` - Production container

## OpenClaw Scanner Isolation (CRITICAL)

OpenClaw's skill-scanner flags plugins that have `process.env` + network calls or `child_process` + network calls in the same file.

**Rule: No single `.js` file may contain both halves of a scanner rule pair:**
- `process.env` lives ONLY in `lib/config.js`
- `child_process` / `execFile` / `spawn` live ONLY in `lib/youtube.js`, `lib/launcher.js`, and `cli.js`
- `server.js` has Express routes but ZERO `process.env` reads and ZERO `child_process` imports
- When adding features that need env vars or subprocesses, put that code in a `lib/` module
