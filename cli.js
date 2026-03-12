#!/usr/bin/env node

const BASE = process.env.CAMOFOX_URL || 'http://127.0.0.1:9377';
const USER = process.env.CAMOFOX_USER || 'cli';
const SESSION = process.env.CAMOFOX_SESSION || 'default';
const ADMIN_KEY = process.env.CAMOFOX_ADMIN_KEY || '';

const SESSION_COMMANDS = new Set([
  'open', 'tabs', 'health', 'close-session', 'transcript', 'start', 'stop', 'help',
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
    const list = prefixMatches.map((t, i) => `  ${t.tabId}  ${t.url || ''}`).join('\n');
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
  const header = `${'#'.padStart(3)}  ${'TAB ID'.padEnd(10)}  URL`;
  console.log(header);
  console.log('-'.repeat(header.length + 40));
  tabs.forEach((t, i) => {
    console.log(`${String(i).padStart(3)}  ${t.tabId.slice(0, 8)}..  ${t.url || '(blank)'}`);
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
  const data = await api('POST', '/start');
  console.log('Browser started');
}

async function cmdStop() {
  if (!ADMIN_KEY) throw new Error('CAMOFOX_ADMIN_KEY env var required for stop');
  const data = await api('POST', '/stop', undefined, { 'x-admin-key': ADMIN_KEY });
  console.log('Browser stopped');
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
  if (!url) throw new Error('Usage: camofox <tab> goto <url>');
  const data = await api('POST', `/tabs/${tabId}/navigate`, { userId: USER, url });
  console.log(data.url || 'OK');
}

async function cmdClick(tabId, args) {
  const ref = args[0];
  if (!ref) throw new Error('Usage: camofox <tab> click <ref>');
  const data = await api('POST', `/tabs/${tabId}/click`, { userId: USER, ref });
  if (data.url) console.log(data.url);
}

async function cmdType(tabId, args) {
  const ref = args[0];
  const text = args.slice(1).join(' ');
  if (!ref || !text) throw new Error('Usage: camofox <tab> type <ref> <text>');
  await api('POST', `/tabs/${tabId}/type`, { userId: USER, ref, text });
}

async function cmdPress(tabId, args) {
  const key = args[0];
  if (!key) throw new Error('Usage: camofox <tab> press <key>');
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
  if (!expression) throw new Error('Usage: camofox <tab> eval <js-expression>');
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

function printHelp() {
  console.log(`Usage: camofox <command> [args...]

Session commands:
  open <url>                 Open new tab, prints tab index
  tabs                       List open tabs
  health                     Server health check
  start                      Start/warm the browser
  stop                       Stop the browser (needs CAMOFOX_ADMIN_KEY)
  transcript <youtube-url>   Extract YouTube transcript
  close-session              Close entire session

Tab commands (use tab index, domain, or UUID prefix):
  <tab> snapshot             Page accessibility tree
  <tab> screenshot [file]    Save screenshot (PNG to file or stdout)
  <tab> goto <url>           Navigate to URL
  <tab> click <ref>          Click element (e.g. e9)
  <tab> type <ref> <text>    Type into element
  <tab> press <key>          Press key (Enter, Tab, Escape, etc.)
  <tab> scroll [dir] [px]    Scroll (down|up, default: down 500)
  <tab> back                 Browser back
  <tab> forward              Browser forward
  <tab> refresh              Reload page
  <tab> wait                 Wait for page ready
  <tab> links                Extract all links
  <tab> images               Extract images
  <tab> downloads            Get captured downloads
  <tab> eval <js>            Execute JavaScript
  <tab> close                Close tab
  <tab> stats                Tab statistics

Tab ID formats:
  0, 1, 2            Numeric index
  example.com         Domain match
  4e9d                UUID prefix

Environment:
  CAMOFOX_URL         Server URL (default: http://127.0.0.1:9377)
  CAMOFOX_USER        User ID (default: cli)
  CAMOFOX_SESSION     Session key (default: default)
  CAMOFOX_ADMIN_KEY   Admin key (required for stop command)`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    return;
  }

  const first = args[0];

  // Session commands (no tab required)
  if (SESSION_COMMANDS.has(first)) {
    const rest = args.slice(1);
    switch (first) {
      case 'open': return cmdOpen(rest);
      case 'tabs': return cmdTabs();
      case 'health': return cmdHealth();
      case 'close-session': return cmdCloseSession();
      case 'transcript': return cmdTranscript(rest);
      case 'start': return cmdStart();
      case 'stop': return cmdStop();
      case 'help': return printHelp();
    }
  }

  // Tab commands: first arg is tab identifier, second is command
  const command = args[1];
  if (!command) throw new Error(`Unknown command: ${first}. Run "camofox help" for usage.`);

  const tabId = await resolveTabId(first);
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
    default: throw new Error(`Unknown tab command: ${command}. Run "camofox help" for usage.`);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
