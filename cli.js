#!/usr/bin/env node

import { execFileSync, spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { randomBytes as cryptoRandomBytes } from 'crypto';
import { homedir } from 'os';
import {
  parseProxyLine,
  readStoredProxy,
  writeStoredProxy,
  clearStoredProxy,
  storedProxyEnv,
  PROXY_STORE_PATH,
} from './lib/proxy-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Autoload .env (next to the CLI) so configured vars "just work" without the
// caller having to source it. Real environment variables win — .env only fills
// in keys that aren't already set. Runs before the env-derived constants below.
loadEnvFile(join(__dirname, '.env'));

const BASE = process.env.CAMOFOX_URL || 'http://127.0.0.1:9377';
const USER = process.env.CAMOFOX_USER || 'cli';
const SESSION = process.env.CAMOFOX_SESSION || 'default';
const ADMIN_KEY = process.env.CAMOFOX_ADMIN_KEY || '';
const MARKDOWN_TIMEOUT_MS = parseInt(process.env.CAMOFOX_MARKDOWN_TIMEOUT_MS || '45000', 10);
const CONTAINER_NAME = 'camofox';
const CONTAINER_PORT = parseInt(new URL(BASE).port || '9377', 10);
const KEY_FILE = join(homedir(), '.camofox', 'api-key');
const MARKDOWN_URL_FILE = join(homedir(), '.camofox', 'markdown-url');
const MARKDOWN_TOKEN_FILE = join(homedir(), '.camofox', 'markdown-token');

// Apply a .env file to process.env without overriding already-set vars.
// Uses parseDotenv (defined below; function declarations are hoisted).
function loadEnvFile(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return; }
  for (const [key, value] of Object.entries(parseDotenv(text))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function readConfigFile(path) {
  try { return readFileSync(path, 'utf8').trim(); } catch { return ''; }
}

// Markdown config: env > host config file > running container env (sandbox fallback).
// The container fallback is resolved lazily (see readContainerEnv) so it only runs
// when the first two sources came up empty.
const MARKDOWN_URL = process.env.CAMOFOX_MARKDOWN_URL || readConfigFile(MARKDOWN_URL_FILE);
const MARKDOWN_TOKEN = process.env.CAMOFOX_MARKDOWN_TOKEN || readConfigFile(MARKDOWN_TOKEN_FILE);
function resolveMarkdownUrl() { return MARKDOWN_URL || readContainerEnv('CAMOFOX_MARKDOWN_URL'); }
function resolveMarkdownToken() { return MARKDOWN_TOKEN || readContainerEnv('CAMOFOX_MARKDOWN_TOKEN'); }

// Recover a config value straight from the running container's env. Used when the
// host config files can't be read — e.g. an agent sandbox that blocks ~/.camofox
// but still allows `docker` (the same access `camofox serve` needs). Keeps the CLI
// transparent: any agent on this machine can run `camofox eval/cookies/markdown/...`
// without manually wiring up keys. Reads all env once and caches it.
let _containerEnvCache;
function readContainerEnv(name) {
  if (_containerEnvCache === undefined) {
    try {
      const out = execFileSync(
        'docker',
        ['inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', CONTAINER_NAME],
        { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
      ).toString();
      _containerEnvCache = {};
      for (const line of out.split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) _containerEnvCache[line.slice(0, eq)] = line.slice(eq + 1);
      }
    } catch { _containerEnvCache = {}; }
  }
  return (_containerEnvCache[name] || '').trim();
}

let _apiKeyCache;
function readApiKey() {
  if (_apiKeyCache !== undefined) return _apiKeyCache;
  if (process.env.CAMOFOX_API_KEY) return (_apiKeyCache = process.env.CAMOFOX_API_KEY);
  try {
    const fromFile = readFileSync(KEY_FILE, 'utf8').trim();
    if (fromFile) return (_apiKeyCache = fromFile);
  } catch { /* file missing or unreadable (e.g. sandbox) — try the container */ }
  return (_apiKeyCache = readContainerEnv('CAMOFOX_API_KEY'));
}

function ensureApiKey() {
  const existing = readApiKey();
  if (existing) return existing;
  const key = cryptoRandomBytes(32).toString('hex');
  mkdirSync(dirname(KEY_FILE), { recursive: true });
  writeFileSync(KEY_FILE, key + '\n', { mode: 0o600 });
  return key;
}

const TAB_COMMANDS = new Set([
  'snapshot', 'screenshot', 'goto', 'click', 'type', 'press', 'scroll',
  'back', 'forward', 'refresh', 'wait', 'links', 'images', 'downloads',
  'eval', 'solve', 'close', 'stats',
]);

// ── HTTP helper ──────────────────────────────────────────────────────────────

async function api(method, path, body, extraHeaders) {
  // Attach the API key on every request. Read endpoints ignore it; auth-gated
  // endpoints (evaluate, cookies, traces, ...) require it when CAMOFOX_API_KEY
  // is set on the server. extraHeaders can still override.
  const defaultHeaders = {};
  const apiKey = readApiKey();
  if (apiKey) defaultHeaders['Authorization'] = `Bearer ${apiKey}`;
  const opts = { method, headers: { ...defaultHeaders, ...extraHeaders } };
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
  if (!res.ok) {
    if (res.status === 403 && !apiKey) {
      throw new Error(
        `${data.error || 'Forbidden'} — this endpoint requires the API key, but none was found. ` +
        `The CLI reads it from $CAMOFOX_API_KEY or ~/.camofox/api-key; inside a restricted sandbox that ` +
        `file is often unreadable, so the CLI silently sends no key and the server returns 403. ` +
        `Fixes: (a) run the server bound to loopback (CAMOFOX_HOST=127.0.0.1) — auth is then bypassed for all ` +
        `local callers; (b) add ~/.camofox to the sandbox filesystem allowRead; or (c) pass CAMOFOX_API_KEY in the env. ` +
        `(Read-only verbs like snapshot/links/goto need no key and work regardless.)`
      );
    }
    throw new Error(data.error || `HTTP ${res.status}`);
  }
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

function validateHttpUrl(input) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('URL must be a valid http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('URL must use http or https');
  }
  return parsed.toString();
}

async function markdownError(res, bodyText) {
  const prefix = `markdown fetch failed (${res.status})`;
  if (!bodyText) return prefix;
  try {
    const data = JSON.parse(bodyText);
    const msg = data.error || data.message || data.errors;
    if (msg) return `${prefix}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`;
  } catch {
    // fall through to plain text
  }
  return `${prefix}: ${bodyText.slice(0, 500)}`;
}

async function cmdMarkdown(args) {
  const urlArg = args[0];
  if (!urlArg) throw new Error('Usage: camofox markdown <url>');
  const markdownUrl = resolveMarkdownUrl();
  if (!markdownUrl) {
    throw new Error(
      'CAMOFOX_MARKDOWN_URL is required. Point it at a Cloudflare Browser Rendering /markdown Worker endpoint. ' +
      'It is read from $CAMOFOX_MARKDOWN_URL, ~/.camofox/markdown-url, or the running container env; if all are ' +
      'empty (e.g. the container predates markdown support), pass CAMOFOX_MARKDOWN_URL in the env or re-run `camofox serve`.'
    );
  }
  const markdownToken = resolveMarkdownToken();

  const url = validateHttpUrl(urlArg);
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(MARKDOWN_TIMEOUT_MS) && MARKDOWN_TIMEOUT_MS > 0 ? MARKDOWN_TIMEOUT_MS : 45000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'text/markdown, application/json;q=0.9, text/plain;q=0.8',
    };
    if (markdownToken) headers.Authorization = `Bearer ${markdownToken}`;

    const res = await fetch(markdownUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url }),
      signal: controller.signal,
    });
    const contentType = res.headers.get('content-type') || '';
    const bodyText = await res.text();
    if (!res.ok) throw new Error(await markdownError(res, bodyText));

    let markdown = bodyText;
    if (contentType.includes('application/json')) {
      const data = JSON.parse(bodyText);
      if (data.ok === false || data.success === false) {
        throw new Error(data.error || data.message || 'markdown fetch failed');
      }
      markdown = data.markdown ?? data.result ?? data.content;
      if (typeof markdown !== 'string') {
        throw new Error('markdown endpoint returned JSON without markdown/result/content string');
      }
    }
    if (!markdown.trim()) throw new Error('markdown endpoint returned empty content');
    process.stdout.write(markdown);
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`markdown fetch timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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

// ── Cookie import from curl ──────────────────────────────────────────────────

function parseCurlCookies(curlText) {
  // Extract the URL to get the domain
  const urlMatch = curlText.match(/curl\s+'([^']+)'/) || curlText.match(/curl\s+"([^"]+)"/) || curlText.match(/curl\s+(\S+)/);
  if (!urlMatch) throw new Error('Could not find URL in curl command');
  const domain = new URL(urlMatch[1]).hostname;

  // Extract cookie string from -b or --cookie flag (single-quoted, double-quoted, or unquoted)
  const cookieMatch = curlText.match(/(?:-b|--cookie)\s+'([^']*)'/) ||
                      curlText.match(/(?:-b|--cookie)\s+"([^"]*)"/) ||
                      curlText.match(/(?:-b|--cookie)\s+(\S+)/);
  if (!cookieMatch) throw new Error('No -b/--cookie flag found in curl command');

  const cookieStr = cookieMatch[1];
  const cookies = [];
  for (const pair of cookieStr.split(/;\s*/)) {
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    cookies.push({ name, value, domain: `.${domain.replace(/^\./, '')}`, path: '/' });
  }
  return cookies;
}

async function cmdCookies(args) {
  let curlText;
  if (args.length) {
    // Inline argument: camofox cookies curl '...' -b '...'
    curlText = args.join(' ').trim();
  } else if (!process.stdin.isTTY) {
    // Piped: pbpaste | camofox cookies
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    curlText = Buffer.concat(chunks).toString('utf8').trim();
  } else {
    // Interactive: prompt user to paste
    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    console.error('Paste a "Copy as cURL" command, then press Enter twice:');
    const lines = [];
    curlText = await new Promise((resolve) => {
      let blankCount = 0;
      rl.on('line', (line) => {
        if (line.trim() === '') {
          blankCount++;
          if (blankCount >= 1 && lines.length > 0) {
            rl.close();
            resolve(lines.join('\n'));
          }
        } else {
          blankCount = 0;
          lines.push(line);
        }
      });
      rl.on('close', () => resolve(lines.join('\n')));
    });
    curlText = curlText.trim();
  }
  if (!curlText || !curlText.startsWith('curl')) {
    throw new Error('Input does not contain a curl command.\n\nCopy a request as cURL from Chrome DevTools, then run: camofox cookies');
  }

  const cookies = parseCurlCookies(curlText);
  if (!cookies.length) throw new Error('No cookies found in curl command');

  const data = await api('POST', `/sessions/${encodeURIComponent(USER)}/cookies`, { cookies });
  console.log(`${data.count} cookies imported for ${USER}`);
}

// ── Residential proxies (byteful) ────────────────────────────────────────────

const PROXY_LIST_CACHE = join(homedir(), '.camofox', 'proxy-list.json');
const BYTEFUL_ENV_FILE = join(homedir(), '.camofox', 'byteful.env');
// Sibling byteful-sdk checkout; override with BYTEFUL_SDK_DIR.
const BYTEFUL_SDK_DIR = process.env.BYTEFUL_SDK_DIR || join(__dirname, '..', 'byteful-sdk');

// Parse a minimal dotenv (KEY=VALUE, # comments, optional quotes) into an object.
function parseDotenv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

// Resolve byteful API keys from (1) env, (2) ~/.camofox/byteful.env, (3) the
// sibling byteful-sdk/.env. Returns { pub, priv } or throws with guidance.
function resolveBytefulKeys() {
  let pub = process.env.BYTEFUL_API_PUBLIC_KEY || '';
  let priv = process.env.BYTEFUL_API_PRIVATE_KEY || '';
  for (const file of [BYTEFUL_ENV_FILE, join(BYTEFUL_SDK_DIR, '.env')]) {
    if (pub && priv) break;
    try {
      const env = parseDotenv(readFileSync(file, 'utf8'));
      pub = pub || env.BYTEFUL_API_PUBLIC_KEY || '';
      priv = priv || env.BYTEFUL_API_PRIVATE_KEY || '';
    } catch { /* file missing — try the next source */ }
  }
  if (!pub || !priv) {
    throw new Error(
      'byteful API keys not found. Set BYTEFUL_API_PUBLIC_KEY and BYTEFUL_API_PRIVATE_KEY in the env, ' +
      `or put them in ${BYTEFUL_ENV_FILE} (or ${join(BYTEFUL_SDK_DIR, '.env')}). ` +
      'Generate keys at https://dashboard.byteful.com/developer/api-key',
    );
  }
  return { pub, priv };
}

// Resolve the Python interpreter that has the byteful SDK importable. Prefers
// $BYTEFUL_PYTHON, then the sibling repo's venv.
function resolveBytefulPython() {
  if (process.env.BYTEFUL_PYTHON) return process.env.BYTEFUL_PYTHON;
  const venv = join(BYTEFUL_SDK_DIR, '.venv', 'bin', 'python');
  if (existsSync(venv)) return venv;
  throw new Error(
    `Could not find the byteful SDK's Python. Looked for ${venv}. ` +
    'Set BYTEFUL_PYTHON to an interpreter with the byteful package installed, ' +
    'or BYTEFUL_SDK_DIR to the byteful-sdk checkout.',
  );
}

function maskSecret(s) {
  const str = String(s || '');
  if (str.length <= 4) return str ? '****' : '';
  return `${str.slice(0, 2)}****${str.slice(-2)}`;
}

function describeProxy(p) {
  const auth = p.username ? `${p.username}:${maskSecret(p.password)}@` : '';
  const loc = p.country ? ` [${p.country}]` : '';
  return `${p.protocol || 'http'}://${auth}${p.host}:${p.port}${loc}`;
}

async function cmdProxyList(args) {
  const flags = {
    country: argValue(args, '--country'),
    count: argValue(args, '--count'),
    session: argValue(args, '--session') || argValue(args, '--session-type'),
    format: argValue(args, '--format') || 'standard',
    city: argValue(args, '--city'),
    subdivision: argValue(args, '--subdivision'),
    zip: argValue(args, '--zip'),
    mode: argValue(args, '--mode'),
  };

  const { pub, priv } = resolveBytefulKeys();
  const python = resolveBytefulPython();
  const script = join(__dirname, 'scripts', 'byteful_residential.py');

  const pyArgs = [script, '--format', flags.format];
  if (flags.count) pyArgs.push('--count', flags.count);
  if (flags.session) pyArgs.push('--session-type', flags.session);
  if (flags.country) pyArgs.push('--country', flags.country);
  if (flags.city) pyArgs.push('--city', flags.city);
  if (flags.subdivision) pyArgs.push('--subdivision', flags.subdivision);
  if (flags.zip) pyArgs.push('--zip', flags.zip);
  if (flags.mode) pyArgs.push('--mode', flags.mode);

  let stdout;
  try {
    stdout = execFileSync(python, pyArgs, {
      encoding: 'utf8',
      // Capture stderr (don't inherit) so we control the error message shown.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BYTEFUL_API_PUBLIC_KEY: pub, BYTEFUL_API_PRIVATE_KEY: priv },
    });
  } catch (err) {
    // The Python script emits {"error","kind"} on stderr for known failures.
    const stderr = err.stderr ? String(err.stderr).trim() : '';
    try {
      const parsed = JSON.parse(stderr);
      throw new Error(`byteful: ${parsed.error}${parsed.kind ? ` (${parsed.kind})` : ''}`);
    } catch (parseErr) {
      if (parseErr.message.startsWith('byteful:')) throw parseErr;
      throw new Error(stderr || err.message);
    }
  }

  const result = JSON.parse(stdout);
  const lines = Array.isArray(result.data) ? result.data : [];
  if (!lines.length) {
    console.log('No proxies returned.' + (result.message ? ` (${result.message})` : ''));
    return;
  }

  // Cache so `proxy use <N>` can reference these by index.
  mkdirSync(dirname(PROXY_LIST_CACHE), { recursive: true });
  writeFileSync(PROXY_LIST_CACHE, JSON.stringify({ country: flags.country || '', lines }, null, 2) + '\n', { mode: 0o600 });

  const width = String(lines.length).length;
  lines.forEach((line, i) => {
    console.log(`${String(i + 1).padStart(width)}. ${line}`);
  });
  console.log(`\n${lines.length} proxies. Assign one with:  camofox proxy use <number>`);
}

function cmdProxyUse(args) {
  const target = args[0];
  if (!target) throw new Error('Usage: camofox proxy use <number|ip:port:user:pass>');

  let line = target;
  let country = argValue(args, '--country') || '';

  // Numeric arg → index into the last `proxy list` result.
  if (/^\d+$/.test(target)) {
    let cache;
    try { cache = JSON.parse(readFileSync(PROXY_LIST_CACHE, 'utf8')); } catch { cache = null; }
    if (!cache || !Array.isArray(cache.lines) || !cache.lines.length) {
      throw new Error('No cached proxy list. Run "camofox proxy list" first, or pass a full ip:port:user:pass line.');
    }
    const idx = parseInt(target, 10) - 1;
    if (idx < 0 || idx >= cache.lines.length) {
      throw new Error(`Index ${target} out of range (1-${cache.lines.length}).`);
    }
    line = cache.lines[idx];
    if (!country) country = cache.country || '';
  }

  const parsed = parseProxyLine(line);
  if (!parsed) {
    throw new Error(`Could not parse proxy "${line}". Expected ip:port:user:pass or a proxy URL.`);
  }

  const proxy = {
    ...parsed,
    strategy: 'round_robin',
    country,
    source: 'byteful-residential',
  };
  writeStoredProxy(proxy);
  console.log(`Assigned proxy: ${describeProxy(proxy)}`);
  console.log(`Saved to ${PROXY_STORE_PATH}`);
  console.log('Restart the browser for it to take effect:  camofox stop && camofox start');
  console.log('(or restart the container:  camofox serve stop && camofox serve -d)');
}

function cmdProxyShow() {
  const p = readStoredProxy();
  if (!p) {
    console.log('No proxy assigned. Use "camofox proxy list" then "camofox proxy use <number>".');
    return;
  }
  console.log(describeProxy(p));
  if (p.source) console.log(`source: ${p.source}`);
  console.log(`stored: ${PROXY_STORE_PATH}`);
}

function cmdProxyClear() {
  if (clearStoredProxy()) {
    console.log('Proxy assignment cleared. Restart the browser to stop using it.');
  } else {
    console.log('No proxy assignment to clear.');
  }
}

async function cmdProxy(args) {
  const sub = args[0];
  switch (sub) {
    case 'list': return cmdProxyList(args.slice(1));
    case 'use': return cmdProxyUse(args.slice(1));
    case 'show': case 'status': return cmdProxyShow();
    case 'clear': case 'unset': return cmdProxyClear();
    default:
      printHelp('proxy');
      if (sub) process.exitCode = 1;
      return;
  }
}

// Read the value following a `--flag` in an argv array (returns undefined if absent).
function argValue(args, flag) {
  const i = args.indexOf(flag);
  if (i === -1 || i === args.length - 1) return undefined;
  return args[i + 1];
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
  // Delegate to the Makefile: it downloads the arch-correct Camoufox binary and
  // yt-dlp into dist/ (required by the Dockerfile's bind mount) and runs the
  // docker build with the right build-args. Then tag the arch-specific image as
  // `camofox` so the run/inspect logic below can find it by a stable name.
  console.log('Building camofox image via Makefile (downloads Camoufox binary on first run)...');
  execFileSync('make', ['build'], { cwd: __dirname, stdio: 'inherit' });
  const id = execFileSync('docker', ['images', '-q', 'camofox-browser'], { encoding: 'utf8' })
    .split('\n')[0].trim();
  if (id) execFileSync('docker', ['tag', id, CONTAINER_NAME], { stdio: 'ignore' });
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

  // Pass through relevant env vars (auto-generate API key if none set)
  const apiKey = ensureApiKey();
  const envFlags = ['-e', 'NODE_ENV=production'];
  if (ADMIN_KEY) envFlags.push('-e', `CAMOFOX_ADMIN_KEY=${ADMIN_KEY}`);
  envFlags.push('-e', `CAMOFOX_API_KEY=${apiKey}`);
  // Stash markdown config in the container env too, so a sandboxed CLI that can't
  // read ~/.camofox can still recover it via `docker inspect` (see readContainerEnv).
  const mdUrl = process.env.CAMOFOX_MARKDOWN_URL || readConfigFile(MARKDOWN_URL_FILE);
  const mdToken = process.env.CAMOFOX_MARKDOWN_TOKEN || readConfigFile(MARKDOWN_TOKEN_FILE);
  if (mdUrl) envFlags.push('-e', `CAMOFOX_MARKDOWN_URL=${mdUrl}`);
  if (mdToken) envFlags.push('-e', `CAMOFOX_MARKDOWN_TOKEN=${mdToken}`);
  // Forward locale/timezone spoofing so it survives container restarts.
  if (process.env.CAMOFOX_LOCALE) envFlags.push('-e', `CAMOFOX_LOCALE=${process.env.CAMOFOX_LOCALE}`);
  if (process.env.TZ) envFlags.push('-e', `TZ=${process.env.TZ}`);
  // Proxy: an assignment from `camofox proxy use` (stored in ~/.camofox) is
  // forwarded here since the container can't read the host's home dir. Explicit
  // PROXY_* env vars override the stored values.
  const proxyEnv = { ...storedProxyEnv() };
  for (const k of ['PROXY_STRATEGY', 'PROXY_HOST', 'PROXY_PORT', 'PROXY_USERNAME', 'PROXY_PASSWORD', 'PROXY_COUNTRY']) {
    if (process.env[k]) proxyEnv[k] = process.env[k];
  }
  if (proxyEnv.PROXY_HOST) {
    for (const [k, v] of Object.entries(proxyEnv)) envFlags.push('-e', `${k}=${v}`);
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

async function cmdDownloads(tabId, args) {
  const dest = args[0]; // optional directory to save files to
  const includeData = dest ? 'true' : 'false';
  const data = await api('GET', `/tabs/${tabId}/downloads?userId=${encodeURIComponent(USER)}&includeData=${includeData}&consume=false`);
  const downloads = data.downloads || [];

  if (!dest) {
    // List mode: just print metadata
    console.log(JSON.stringify(downloads, null, 2));
    return;
  }

  // Save mode: write files to destination directory
  mkdirSync(dest, { recursive: true });
  let saved = 0;
  for (const dl of downloads) {
    if (dl.failure || !dl.dataBase64) {
      if (dl.failure) console.error(`Skipped ${dl.suggestedFilename}: ${dl.failure}`);
      continue;
    }
    const filePath = join(dest, dl.suggestedFilename);
    writeFileSync(filePath, Buffer.from(dl.dataBase64, 'base64'));
    console.log(filePath);
    saved++;
  }
  if (!saved) console.error('No downloads to save');
}

async function cmdEval(tabId, args) {
  const expression = args.join(' ');
  if (!expression) throw new Error('Usage: camofox eval <tab> <js-expression>');
  const data = await api('POST', `/tabs/${tabId}/evaluate`, { userId: USER, expression });
  const result = data.result;
  if (typeof result === 'string') console.log(result);
  else if (result !== undefined) console.log(JSON.stringify(result, null, 2));
}

async function cmdSolve(tabId, args) {
  const expectedSelector = args[0]; // optional CSS selector to confirm real content
  const body = { userId: USER };
  if (expectedSelector) body.expectedSelector = expectedSelector;
  const data = await api('POST', `/tabs/${tabId}/solve-cloudflare`, body);
  if (!data.detected) { console.log('No Cloudflare challenge detected'); return; }
  console.log(`${data.type} challenge: ${data.solved ? 'SOLVED' : 'NOT solved'}${data.reason ? ' (' + data.reason + ')' : ''}`);
  if (data.url) console.log(data.url);
  if (!data.solved) process.exitCode = 2;
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
  cookies        Import cookies from a "Copy as cURL" command
  markdown       Capture a URL as Markdown via Cloudflare Browser Rendering
  proxy          Fetch & assign byteful residential proxies

  snapshot       Page accessibility tree
  screenshot     Save screenshot
  goto           Navigate to URL
  click          Click an element
  type           Type into an element
  press          Press a key
  scroll         Scroll the page
  eval           Execute JavaScript
  solve          Solve a Cloudflare challenge (click)
  close          Close a tab

  Run "camofox help <command>" for details.

Environment:
  CAMOFOX_URL       Server URL (default: http://127.0.0.1:9377)
  CAMOFOX_USER      User ID (default: cli)
  CAMOFOX_SESSION   Session key (default: default)
  CAMOFOX_ADMIN_KEY Admin key (required for stop)
  CAMOFOX_MARKDOWN_URL   Markdown Worker endpoint (or ~/.camofox/markdown-url)
  CAMOFOX_MARKDOWN_TOKEN Markdown Worker bearer token (or ~/.camofox/markdown-token)`,
  markdown: `Usage: camofox markdown <url>

Capture a rendered URL as Markdown through a configured Cloudflare Browser
Rendering Worker endpoint. Prints Markdown to stdout exactly as returned.
Errors are written to stderr and exit non-zero.

Environment:
  CAMOFOX_MARKDOWN_URL         Full Worker endpoint URL, e.g. https://.../markdown
                                Falls back to ~/.camofox/markdown-url
  CAMOFOX_MARKDOWN_TOKEN       Optional bearer token for the Worker
                                Falls back to ~/.camofox/markdown-token
  CAMOFOX_MARKDOWN_TIMEOUT_MS  Request timeout in ms (default: 45000)

Example:
  camofox markdown https://example.com > page.md`,

  serve: `Usage: camofox serve [subcommand]

  camofox serve          Start server in foreground (ctrl-c to stop)
  camofox serve -d       Start detached (background)
  camofox serve stop     Stop the container
  camofox serve status   Check if running
  camofox serve build    Rebuild the Docker image

Builds the Docker image automatically on first run.
Passes CAMOFOX_ADMIN_KEY, CAMOFOX_API_KEY, and PROXY_* env vars to the container.
A proxy assigned via "camofox proxy use" is forwarded to the container too.`,

  proxy: `Usage: camofox proxy <subcommand>

  camofox proxy list [filters]   Fetch residential proxies from byteful
  camofox proxy use <n|line>     Assign a proxy (by list number or ip:port:user:pass)
  camofox proxy show             Show the currently assigned proxy
  camofox proxy clear            Remove the assignment

Filters for "list":
  --country <cc>      Country, e.g. us, ar
  --count <n>         How many proxies to fetch
  --session <type>    sticky | rotating
  --format <fmt>      standard (ip:port:user:pass), http, https, socks5, socks5h
  --city <alias>      City alias
  --subdivision <id>  Subdivision id
  --zip <id>          ZIP code id
  --mode <mode>       general | size | speed

Assignment persists to ~/.camofox/proxy.json and applies on the next browser
start (camofox stop && camofox start, or restart the container). Explicit
PROXY_* env vars always override the stored assignment.

Auth: set BYTEFUL_API_PUBLIC_KEY / BYTEFUL_API_PRIVATE_KEY in the env, or in
~/.camofox/byteful.env, or in the sibling byteful-sdk/.env. The byteful SDK is
invoked via its Python venv (override with BYTEFUL_PYTHON / BYTEFUL_SDK_DIR).

Examples:
  camofox proxy list --country us --count 20 --session sticky
  camofox proxy use 3
  camofox proxy use 1.2.3.4:8080:user:pass --country us`,

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

  cookies: `Usage: camofox cookies [curl command...]

Import cookies from a Chrome "Copy as cURL" command.

Three ways to provide input:
  camofox cookies                  Reads from clipboard (pbpaste)
  pbpaste | camofox cookies        Reads from stdin
  camofox cookies curl '...' ...   Inline argument

Steps:
  1. Open Chrome DevTools → Network tab
  2. Right-click any request to the target site → Copy → Copy as cURL
  3. Run: camofox cookies

The domain is extracted from the curl URL automatically.`,

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

  downloads: `Usage: camofox downloads <tab> [directory]

List or save captured downloads for a tab.

Without a directory, prints download metadata as JSON.
With a directory, saves all downloaded files there.

Examples:
  camofox downloads 0              List downloads as JSON
  camofox downloads 0 ./pdfs       Save files to ./pdfs/

Downloads are captured automatically when the browser triggers a file
download (e.g., clicking a PDF link). Use "camofox click" to trigger
the download first, then "camofox downloads" to retrieve it.`,

  eval: `Usage: camofox eval <tab> <js-expression>

Execute JavaScript in the page context and print the result.

Examples:
  camofox eval 0 document.title
  camofox eval 0 "document.querySelectorAll('a').length"`,

  solve: `Usage: camofox solve <tab> [expected-css-selector]

Attempt to solve a Cloudflare challenge (Turnstile or interstitial) on the tab
by clicking the verification checkbox. Auto-detects the challenge type.

Optionally pass a CSS selector that should appear once the real page loads, to
confirm success. Exit code is non-zero if the challenge was not solved.

Works when the challenge is passable by interaction; it cannot get past a
fingerprint Cloudflare has already hard-rejected (use cookie import for those).

Examples:
  camofox solve 0
  camofox solve 0 "#main-content"`,

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
    case 'cookies': return cmdCookies(args.slice(1));
    case 'transcript': return cmdTranscript(args.slice(1));
    case 'markdown': return cmdMarkdown(args.slice(1));
    case 'start': return cmdStart();
    case 'stop': return cmdStop();
    case 'serve': return cmdServe(args.slice(1));
    case 'proxy': return cmdProxy(args.slice(1));
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
      case 'downloads': return cmdDownloads(tabId, rest);
      case 'eval': return cmdEval(tabId, rest);
      case 'solve': return cmdSolve(tabId, rest);
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
