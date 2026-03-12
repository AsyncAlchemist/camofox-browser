#!/usr/bin/env node

import { execFileSync, spawn } from 'child_process';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.CAMOFOX_URL || 'http://127.0.0.1:9377';
const USER = process.env.CAMOFOX_USER || 'cli';
const SESSION = process.env.CAMOFOX_SESSION || 'default';
const ADMIN_KEY = process.env.CAMOFOX_ADMIN_KEY || '';
const CONTAINER_NAME = 'camofox';
const CONTAINER_PORT = parseInt(new URL(BASE).port || '9377', 10);

const TAB_COMMANDS = new Set([
  'snapshot', 'screenshot', 'goto', 'click', 'type', 'press', 'scroll',
  'back', 'forward', 'refresh', 'wait', 'links', 'images', 'downloads',
  'eval', 'close', 'stats',
]);

// ── HTTP helper ──────────────────────────────────────────────────────────────

async function api(method, path, body, extraHeaders) {
  const opts = { method, headers: { ...extraHeaders } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, opts);
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('image/')) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { _binary: buf, _contentType: contentType };
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Tab resolution ───────────────────────────────────────────────────────────

async function listTabs() {
  const data = await api('GET', `/tabs?userId=${encodeURIComponent(USER)}`);
  return data.tabs || [];
}

async function resolveTabId(input) {
  if (!input) throw new Error('Missing tab identifier. Run "camofox help" for usage.');
  const tabs = await listTabs();
  if (!tabs.length) throw new Error('No open tabs');

  // 1. Numeric index
  if (/^\d+$/.test(input)) {
    const idx = parseInt(input, 10);
    if (idx >= tabs.length) throw new Error(`Tab index ${idx} out of range (0-${tabs.length - 1})`);
    return tabs[idx].tabId;
  }

  // 2. Full UUID exact match
  const exact = tabs.find(t => t.tabId === input);
  if (exact) return exact.tabId;

  // 3. UUID prefix match
  const prefixMatches = tabs.filter(t => t.tabId.startsWith(input));
  if (prefixMatches.length === 1) return prefixMatches[0].tabId;
  if (prefixMatches.length > 1) {
    const list = prefixMatches.map(t => `  ${t.tabId}  ${t.url || ''}`).join('\n');
    throw new Error(`Ambiguous tab prefix "${input}" matches ${prefixMatches.length} tabs:\n${list}`);
  }

  // 4. Domain/hostname match
  const domainMatches = tabs.filter(t => {
    try { return new URL(t.url).hostname.includes(input); } catch { return false; }
  });
  if (domainMatches.length === 1) return domainMatches[0].tabId;
  if (domainMatches.length > 1) {
    const list = domainMatches.map(t => `  ${t.tabId.slice(0, 8)}  ${t.url || ''}`).join('\n');
    throw new Error(`Ambiguous domain "${input}" matches ${domainMatches.length} tabs:\n${list}`);
  }

  throw new Error(`No tab matching "${input}"`);
}

// ── Tab index lookup (for open command output) ───────────────────────────────

async function tabIndex(tabId) {
  const tabs = await listTabs();
  const idx = tabs.findIndex(t => t.tabId === tabId);
  return idx >= 0 ? idx : 0;
}

// ── Session commands ─────────────────────────────────────────────────────────

async function cmdOpen(args) {
  const url = args[0];
  if (!url) throw new Error('Usage: camofox open <url>');
  const data = await api('POST', '/tabs', { userId: USER, sessionKey: SESSION, url });
  const idx = await tabIndex(data.tabId);
  process.stdout.write(`${idx}\n`);
}

async function cmdTabs() {
  const tabs = await listTabs();
  if (!tabs.length) { console.log('No open tabs'); return; }
  const header = `${'#'.padStart(3)}  ${'TAB ID'.padEnd(36)}  URL`;
  console.log(header);
  console.log('-'.repeat(header.length + 40));
  tabs.forEach((t, i) => {
    console.log(`${String(i).padStart(3)}  ${t.tabId.padEnd(36)}  ${t.url || '(blank)'}`);
  });
}

async function cmdHealth() {
  const data = await api('GET', '/health');
  console.log(JSON.stringify(data, null, 2));
}

async function cmdCloseSession() {
  await api('DELETE', `/sessions/${encodeURIComponent(USER)}`);
  console.log('Session closed');
}

async function cmdTranscript(args) {
  const url = args[0];
  if (!url) throw new Error('Usage: camofox transcript <youtube-url>');
  const data = await api('POST', '/youtube/transcript', { url });
  process.stdout.write(data.transcript || '');
  if (data.transcript && !data.transcript.endsWith('\n')) process.stdout.write('\n');
}

async function cmdStart() {
  await api('POST', '/start');
  console.log('Browser started');
}

async function cmdStop() {
  if (!ADMIN_KEY) throw new Error('CAMOFOX_ADMIN_KEY env var required for stop');
  await api('POST', '/stop', undefined, { 'x-admin-key': ADMIN_KEY });
  console.log('Browser stopped');
}

// ── Docker serve ─────────────────────────────────────────────────────────────

function dockerImageExists() {
  try {
    execFileSync('docker', ['image', 'inspect', CONTAINER_NAME], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function dockerContainerRunning() {
  try {
    const out = execFileSync('docker', ['ps', '-q', '-f', `name=^${CONTAINER_NAME}$`], { encoding: 'utf8' }).trim();
    return out.length > 0;
  } catch { return false; }
}

function dockerBuild() {
  console.log('Building camofox image...');
  execFileSync('docker', ['build', '-t', CONTAINER_NAME, __dirname], { stdio: 'inherit' });
  console.log('Build complete');
}

async function cmdServe(args) {
  const subcmd = args[0];

  if (subcmd === 'stop') {
    if (!dockerContainerRunning()) {
      console.log('No camofox container running');
      return;
    }
    execFileSync('docker', ['stop', CONTAINER_NAME], { stdio: 'inherit' });
    console.log('Container stopped');
    return;
  }

  if (subcmd === 'status') {
    if (dockerContainerRunning()) {
      console.log(`Running on port ${CONTAINER_PORT}`);
      try { await cmdHealth(); } catch { /* server may be starting */ }
    } else {
      console.log('Not running');
    }
    return;
  }

  if (subcmd === 'build') {
    dockerBuild();
    return;
  }

  // Default: start the container
  if (dockerContainerRunning()) {
    console.log(`Already running on port ${CONTAINER_PORT}`);
    return;
  }

  if (!dockerImageExists()) {
    dockerBuild();
  }

  // Pass through relevant env vars
  const envFlags = [];
  if (ADMIN_KEY) envFlags.push('-e', `CAMOFOX_ADMIN_KEY=${ADMIN_KEY}`);
  if (process.env.CAMOFOX_API_KEY) envFlags.push('-e', `CAMOFOX_API_KEY=${process.env.CAMOFOX_API_KEY}`);
  if (process.env.PROXY_HOST) {
    envFlags.push('-e', `PROXY_HOST=${process.env.PROXY_HOST}`);
    if (process.env.PROXY_PORT) envFlags.push('-e', `PROXY_PORT=${process.env.PROXY_PORT}`);
    if (process.env.PROXY_USERNAME) envFlags.push('-e', `PROXY_USERNAME=${process.env.PROXY_USERNAME}`);
    if (process.env.PROXY_PASSWORD) envFlags.push('-e', `PROXY_PASSWORD=${process.env.PROXY_PASSWORD}`);
  }

  const detach = args.includes('-d') || args.includes('--detach');
  const dockerArgs = [
    'run', '--rm', '--name', CONTAINER_NAME,
    '-p', `127.0.0.1:${CONTAINER_PORT}:9377`,
    ...envFlags,
    ...(detach ? ['-d'] : []),
    CONTAINER_NAME,
  ];

  if (detach) {
    execFileSync('docker', dockerArgs, { stdio: 'inherit' });
    console.log(`Camofox running on port ${CONTAINER_PORT} (detached)`);
  } else {
    console.log(`Starting camofox on port ${CONTAINER_PORT} (ctrl-c to stop)...`);
    const proc = spawn('docker', dockerArgs, { stdio: 'inherit' });
    proc.on('close', (code) => process.exit(code || 0));
  }
}

// ── Tab commands ─────────────────────────────────────────────────────────────

async function cmdSnapshot(tabId) {
  const data = await api('GET', `/tabs/${tabId}/snapshot?userId=${encodeURIComponent(USER)}`);
  process.stdout.write(data.snapshot || '');
  if (data.snapshot && !data.snapshot.endsWith('\n')) process.stdout.write('\n');
}

async function cmdScreenshot(tabId, args) {
  const file = args[0];
  const data = await api('GET', `/tabs/${tabId}/screenshot?userId=${encodeURIComponent(USER)}`);
  if (file) {
    const fs = await import('fs');
    fs.writeFileSync(file, data._binary);
    console.error(`Screenshot saved to ${file}`);
  } else {
    process.stdout.write(data._binary);
  }
}

async function cmdGoto(tabId, args) {
  const url = args[0];
  if (!url) throw new Error('Usage: camofox goto <tab> <url>');
  const data = await api('POST', `/tabs/${tabId}/navigate`, { userId: USER, url });
  console.log(data.url || 'OK');
}

async function cmdClick(tabId, args) {
  const ref = args[0];
  if (!ref) throw new Error('Usage: camofox click <tab> <ref>');
  const data = await api('POST', `/tabs/${tabId}/click`, { userId: USER, ref });
  if (data.url) console.log(data.url);
}

async function cmdType(tabId, args) {
  const ref = args[0];
  const text = args.slice(1).join(' ');
  if (!ref || !text) throw new Error('Usage: camofox type <tab> <ref> <text>');
  await api('POST', `/tabs/${tabId}/type`, { userId: USER, ref, text });
}

async function cmdPress(tabId, args) {
  const key = args[0];
  if (!key) throw new Error('Usage: camofox press <tab> <key>');
  await api('POST', `/tabs/${tabId}/press`, { userId: USER, key });
}

async function cmdScroll(tabId, args) {
  const direction = args[0] || 'down';
  const amount = parseInt(args[1], 10) || 500;
  await api('POST', `/tabs/${tabId}/scroll`, { userId: USER, direction, amount });
}

async function cmdBack(tabId) {
  const data = await api('POST', `/tabs/${tabId}/back`, { userId: USER });
  if (data.url) console.log(data.url);
}

async function cmdForward(tabId) {
  const data = await api('POST', `/tabs/${tabId}/forward`, { userId: USER });
  if (data.url) console.log(data.url);
}

async function cmdRefresh(tabId) {
  const data = await api('POST', `/tabs/${tabId}/refresh`, { userId: USER });
  if (data.url) console.log(data.url);
}

async function cmdWait(tabId) {
  const data = await api('POST', `/tabs/${tabId}/wait`, { userId: USER });
  console.log(data.ready ? 'ready' : 'timeout');
}

async function cmdLinks(tabId) {
  const data = await api('GET', `/tabs/${tabId}/links?userId=${encodeURIComponent(USER)}`);
  for (const link of (data.links || [])) {
    console.log(`${link.url}  ${link.text || ''}`);
  }
}

async function cmdImages(tabId) {
  const data = await api('GET', `/tabs/${tabId}/images?userId=${encodeURIComponent(USER)}`);
  for (const img of (data.images || [])) {
    console.log(`${img.src}  ${img.alt || ''}`);
  }
}

async function cmdDownloads(tabId) {
  const data = await api('GET', `/tabs/${tabId}/downloads?userId=${encodeURIComponent(USER)}`);
  console.log(JSON.stringify(data.downloads || [], null, 2));
}

async function cmdEval(tabId, args) {
  const expression = args.join(' ');
  if (!expression) throw new Error('Usage: camofox eval <tab> <js-expression>');
  const data = await api('POST', `/tabs/${tabId}/evaluate`, { userId: USER, expression });
  const result = data.result;
  if (typeof result === 'string') console.log(result);
  else if (result !== undefined) console.log(JSON.stringify(result, null, 2));
}

async function cmdClose(tabId) {
  await api('DELETE', `/tabs/${tabId}`, { userId: USER });
  console.log('Tab closed');
}

async function cmdStats(tabId) {
  const data = await api('GET', `/tabs/${tabId}/stats?userId=${encodeURIComponent(USER)}`);
  console.log(JSON.stringify(data, null, 2));
}

// ── Help ─────────────────────────────────────────────────────────────────────

const HELP = {
  main: `Usage: camofox <command> [args...]

Commands:
  serve          Start/stop the server via Docker
  open <url>     Open a new tab
  tabs           List open tabs
  health         Server health check
  close-session  Close all tabs for current user

  snapshot       Page accessibility tree
  screenshot     Save screenshot
  goto           Navigate to URL
  click          Click an element
  type           Type into an element
  press          Press a key
  scroll         Scroll the page
  eval           Execute JavaScript
  close          Close a tab

  Run "camofox help <command>" for details.

Environment:
  CAMOFOX_URL       Server URL (default: http://127.0.0.1:9377)
  CAMOFOX_USER      User ID (default: cli)
  CAMOFOX_SESSION   Session key (default: default)
  CAMOFOX_ADMIN_KEY Admin key (required for stop)`,

  serve: `Usage: camofox serve [subcommand]

  camofox serve          Start server in foreground (ctrl-c to stop)
  camofox serve -d       Start detached (background)
  camofox serve stop     Stop the container
  camofox serve status   Check if running
  camofox serve build    Rebuild the Docker image

Builds the Docker image automatically on first run.
Passes CAMOFOX_ADMIN_KEY, CAMOFOX_API_KEY, and PROXY_* env vars to the container.`,

  open: `Usage: camofox open <url>

Open a new browser tab and navigate to the given URL.
Prints the tab index to stdout for use in subsequent commands.

Example:
  camofox open https://example.com   # → 0`,

  tabs: `Usage: camofox tabs

List all open tabs with their index, ID prefix, and URL.`,

  health: `Usage: camofox health

Check server health. Prints JSON with status and browser info.`,

  start: `Usage: camofox start

Start or warm the browser engine without opening a tab.`,

  stop: `Usage: camofox stop

Stop the browser engine. Requires CAMOFOX_ADMIN_KEY.`,

  transcript: `Usage: camofox transcript <youtube-url>

Extract captions from a YouTube video.
Uses yt-dlp when available, falls back to browser-based extraction.

Example:
  camofox transcript https://www.youtube.com/watch?v=dQw4w9WgXcQ`,

  'close-session': `Usage: camofox close-session

Close all tabs for the current user (CAMOFOX_USER).`,

  snapshot: `Usage: camofox snapshot <tab>

Get the accessibility tree for a tab. Shows element refs (e1, e2, ...)
that can be used with click, type, and other interaction commands.

Example:
  camofox snapshot 0
  camofox snapshot example.com`,

  screenshot: `Usage: camofox screenshot <tab> [file]

Take a PNG screenshot of the tab.
If a file path is given, saves to that file.
Otherwise writes binary PNG to stdout.

Examples:
  camofox screenshot 0 page.png
  camofox screenshot 0 | imgcat`,

  goto: `Usage: camofox goto <tab> <url>

Navigate a tab to a new URL.

Example:
  camofox goto 0 https://github.com`,

  click: `Usage: camofox click <tab> <ref>

Click an element by its ref from the snapshot.

Example:
  camofox click 0 e1`,

  type: `Usage: camofox type <tab> <ref> <text>

Type text into an input element identified by its ref.

Example:
  camofox type 0 e3 "search query"`,

  press: `Usage: camofox press <tab> <key>

Press a keyboard key.

Examples:
  camofox press 0 Enter
  camofox press 0 Tab
  camofox press 0 Escape`,

  scroll: `Usage: camofox scroll <tab> [direction] [pixels]

Scroll the page. Direction: up or down (default: down).
Pixels default to 500.

Examples:
  camofox scroll 0
  camofox scroll 0 up
  camofox scroll 0 down 1000`,

  back: `Usage: camofox back <tab>

Navigate back in browser history.`,

  forward: `Usage: camofox forward <tab>

Navigate forward in browser history.`,

  refresh: `Usage: camofox refresh <tab>

Reload the page.`,

  wait: `Usage: camofox wait <tab>

Wait for the page to be ready. Prints "ready" or "timeout".`,

  links: `Usage: camofox links <tab>

Extract all links on the page. Prints URL and link text.`,

  images: `Usage: camofox images <tab>

Extract all images on the page. Prints src and alt text.`,

  downloads: `Usage: camofox downloads <tab>

List captured downloads for the tab as JSON.`,

  eval: `Usage: camofox eval <tab> <js-expression>

Execute JavaScript in the page context and print the result.

Examples:
  camofox eval 0 document.title
  camofox eval 0 "document.querySelectorAll('a').length"`,

  close: `Usage: camofox close <tab>

Close a tab.`,

  stats: `Usage: camofox stats <tab>

Print tab statistics as JSON (tool calls, visited URLs, etc).`,
};

// Tab identifier help appended to all tab commands
const TAB_ID_HELP = `
Tab identifier formats:
  0, 1, 2        Numeric index (from "camofox tabs")
  example.com    Domain match
  4e9d           UUID prefix`;

function printHelp(topic) {
  if (!topic || topic === 'help') {
    console.log(HELP.main);
    return;
  }
  const text = HELP[topic];
  if (!text) {
    console.error(`Unknown command: ${topic}. Run "camofox help" for usage.`);
    process.exit(1);
  }
  console.log(text);
  if (TAB_COMMANDS.has(topic)) console.log(TAB_ID_HELP);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    return;
  }
  if (args[0] === 'help') {
    printHelp(args[1]);
    return;
  }

  const command = args[0];

  // Any command with --help or -h shows its help
  if (args.includes('--help') || args.includes('-h')) {
    printHelp(command);
    return;
  }

  // Session commands (no tab required)
  switch (command) {
    case 'open': return cmdOpen(args.slice(1));
    case 'tabs': return cmdTabs();
    case 'health': return cmdHealth();
    case 'close-session': return cmdCloseSession();
    case 'transcript': return cmdTranscript(args.slice(1));
    case 'start': return cmdStart();
    case 'stop': return cmdStop();
    case 'serve': return cmdServe(args.slice(1));
  }

  // Tab commands: command first, then tab identifier
  if (TAB_COMMANDS.has(command)) {
    const tabId = await resolveTabId(args[1]);
    const rest = args.slice(2);

    switch (command) {
      case 'snapshot': return cmdSnapshot(tabId);
      case 'screenshot': return cmdScreenshot(tabId, rest);
      case 'goto': return cmdGoto(tabId, rest);
      case 'click': return cmdClick(tabId, rest);
      case 'type': return cmdType(tabId, rest);
      case 'press': return cmdPress(tabId, rest);
      case 'scroll': return cmdScroll(tabId, rest);
      case 'back': return cmdBack(tabId);
      case 'forward': return cmdForward(tabId);
      case 'refresh': return cmdRefresh(tabId);
      case 'wait': return cmdWait(tabId);
      case 'links': return cmdLinks(tabId);
      case 'images': return cmdImages(tabId);
      case 'downloads': return cmdDownloads(tabId);
      case 'eval': return cmdEval(tabId, rest);
      case 'close': return cmdClose(tabId);
      case 'stats': return cmdStats(tabId);
    }
  }

  throw new Error(`Unknown command: ${command}. Run "camofox help" for usage.`);
}

main().catch(err => {
  if (err.cause?.code === 'ECONNREFUSED' || err.message === 'fetch failed') {
    console.error(`Cannot connect to camofox server at ${BASE}`);
    console.error(`\nStart the server with:\n  camofox serve -d\n`);
  } else {
    console.error(err.message);
  }
  process.exit(1);
});
