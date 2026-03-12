# camofox CLI

Command-line interface for the camofox-browser REST API. Control browser tabs, take snapshots, click elements, and more — all from the terminal.

## Install

```bash
npm install        # installs dependencies + links the CLI
npx camofox ...    # or run directly
```

If installed globally (`npm install -g`), the `camofox` command is available everywhere.

## Configuration

All config is via environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `CAMOFOX_URL` | Server base URL | `http://127.0.0.1:9377` |
| `CAMOFOX_USER` | User ID for session isolation | `cli` |
| `CAMOFOX_SESSION` | Session key for tab grouping | `default` |
| `CAMOFOX_ADMIN_KEY` | Admin key (required for `stop`) | - |

## Server

Start and manage the camofox server via Docker. The image is built automatically on first run.

```bash
camofox serve                   # start in foreground (ctrl-c to stop)
camofox serve -d                # start detached (background)
camofox serve stop              # stop the container
camofox serve status            # check if running
camofox serve build             # rebuild the Docker image
```

The container binds to the port from `CAMOFOX_URL` (default 9377). Environment variables like `CAMOFOX_ADMIN_KEY`, `CAMOFOX_API_KEY`, and `PROXY_*` are passed through to the container automatically.

## Session Commands

These operate on the server or session — no tab needed.

### Open a new tab

```bash
camofox open https://example.com
# → 0                          (prints tab index)
```

### List open tabs

```bash
camofox tabs
#   #  TAB ID      URL
# -------------------------------------------
#   0  4e9d1a2b..  https://example.com
#   1  8f3c7d0e..  https://github.com
```

### Health check

```bash
camofox health
# → { "status": "ok", "browser": "running", ... }
```

### Start / stop the browser

```bash
camofox start                   # warm up the browser engine
camofox stop                    # shut it down (needs CAMOFOX_ADMIN_KEY)
```

### YouTube transcript

```bash
camofox transcript https://www.youtube.com/watch?v=dQw4w9WgXcQ
# → [00:18] ♪ We're no strangers to love ♪ ...
```

### Close session

```bash
camofox close-session           # closes all tabs for the current user
```

## Tab Commands

Tab commands always start with the **command**, then the **tab identifier**, then any arguments.

```
camofox <command> <tab> [args...]
```

### Tab identifiers

You can reference tabs three ways:

| Format | Example | Description |
|--------|---------|-------------|
| Index | `0` | Numeric position from `camofox tabs` |
| Domain | `example.com` | Matches by hostname |
| UUID prefix | `4e9d` | Shortest unique prefix of the tab ID |

> **Note:** Numeric indices shift when tabs are closed — if you close tab 0, tab 1 becomes 0. For scripts or multi-step workflows, prefer domain or UUID prefix identifiers since they stay stable.

### Snapshot (accessibility tree)

```bash
camofox snapshot 0
# → [heading] Example Domain
#   [paragraph] This domain is for use in illustrative examples...
#   [link e1] More information...
```

The snapshot shows element refs like `e1`, `e2` — use these with `click` and `type`.

### Screenshot

```bash
camofox screenshot 0 page.png   # save to file
camofox screenshot 0 > page.png # or pipe to stdout
```

### Navigate

```bash
camofox goto 0 https://github.com
```

### Click

```bash
camofox click 0 e1              # click element ref from snapshot
```

### Type

```bash
camofox type 0 e3 "search query"
```

### Press key

```bash
camofox press 0 Enter
camofox press 0 Tab
camofox press 0 Escape
```

### Scroll

```bash
camofox scroll 0                # default: down 500px
camofox scroll 0 up
camofox scroll 0 down 1000
```

### Navigation history

```bash
camofox back 0
camofox forward 0
camofox refresh 0
```

### Wait for page ready

```bash
camofox wait 0
# → ready
```

### Extract links

```bash
camofox links 0
# → https://example.com/about  About Us
# → https://example.com/docs   Documentation
```

### Extract images

```bash
camofox images 0
# → https://example.com/logo.png  Company Logo
```

### Downloads

```bash
camofox downloads 0
# → [{ "filename": "report.pdf", "url": "..." }]
```

### Evaluate JavaScript

```bash
camofox eval 0 document.title
# → Example Domain

camofox eval 0 "document.querySelectorAll('a').length"
# → 3
```

### Tab stats

```bash
camofox stats 0
# → { "toolCalls": 12, "visitedUrls": ["https://example.com", ...] }
```

### Close a tab

```bash
camofox close 0
```

## Example Workflow

```bash
# Start a browsing session
camofox open https://google.com         # → 0

# Take a snapshot to see the page
camofox snapshot 0                      # shows accessibility tree with refs

# Type a search query and submit
camofox type 0 e7 "camofox browser"
camofox press 0 Enter
camofox wait 0

# Take a screenshot of the results
camofox screenshot 0 results.png

# Click the first result
camofox snapshot 0                      # re-snapshot to get new refs
camofox click 0 e12

# Extract all links from the page
camofox links 0

# Clean up
camofox close 0
```

## Scripting

The CLI is designed for composability. Tab indices are printed to stdout for easy capture:

```bash
TAB=$(camofox open https://example.com)
camofox snapshot $TAB
camofox close $TAB
```

Screenshots write binary PNG to stdout when no filename is given, so you can pipe them:

```bash
camofox screenshot 0 | imgcat          # iTerm2 inline image
camofox screenshot 0 | base64          # base64 encode
```
