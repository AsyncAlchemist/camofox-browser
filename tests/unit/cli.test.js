/**
 * Unit tests for cli.js argument parsing and tab resolution logic.
 *
 * These tests import internal helpers by spawning the CLI as a child process
 * or by testing the logic inline. Since cli.js is a single-file script with
 * no exported functions, we test via process execution and mock servers.
 */
import { execFile } from 'child_process';
import { createServer } from 'http';
import { promisify } from 'util';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const execFileAsync = promisify(execFile);
const CLI = new URL('../../cli.js', import.meta.url).pathname;

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockServer(handlers) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost`);
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const handler = handlers[`${req.method} ${url.pathname}`];
      if (handler) {
        const result = handler(url, body ? JSON.parse(body) : null);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });
  });
  return server;
}

function startServer(handlers) {
  return new Promise((resolve) => {
    const server = mockServer(handlers);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function run(baseUrl, ...args) {
  return runWithEnv(baseUrl, {}, ...args);
}

async function runWithEnv(baseUrl, extraEnv, ...args) {
  try {
    const { stdout, stderr } = await execFileAsync('node', [CLI, ...args], {
      env: { ...process.env, CAMOFOX_URL: baseUrl, CAMOFOX_USER: 'testuser', CAMOFOX_SESSION: 'default', ...extraEnv },
      timeout: 5000,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), code: 0 };
  } catch (err) {
    return { stdout: (err.stdout || '').trim(), stderr: (err.stderr || '').trim(), code: err.code || 1 };
  }
}

// ── Mock tab data ────────────────────────────────────────────────────────────

const MOCK_TABS = [
  { tabId: 'aaaa-1111-0000-0000', url: 'https://www.example.com/page1', title: 'Example' },
  { tabId: 'bbbb-2222-0000-0000', url: 'https://httpbin.org/html', title: 'Httpbin' },
  { tabId: 'cccc-3333-0000-0000', url: 'https://www.example.com/page2', title: 'Example 2' },
];

function defaultHandlers() {
  return {
    'GET /tabs': () => ({ running: true, tabs: MOCK_TABS }),
    'GET /health': () => ({ ok: true, engine: 'camoufox', browserConnected: true }),
    'POST /tabs': (url, body) => ({ tabId: 'dddd-4444-0000-0000', url: body?.url || '' }),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CLI', () => {
  let srv;
  const tempHomes = [];

  afterEach(() => {
    if (srv?.server) srv.server.close();
    for (const home of tempHomes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  describe('help', () => {
    test('prints help with no args', async () => {
      srv = await startServer(defaultHandlers());
      const r = await run(srv.url);
      expect(r.stdout).toContain('Usage: camofox');
      expect(r.stdout).toContain('open <url>');
    });

    test('prints help with --help', async () => {
      srv = await startServer(defaultHandlers());
      const r = await run(srv.url, '--help');
      expect(r.stdout).toContain('Usage: camofox');
    });
  });

  describe('session commands', () => {
    test('health returns server status', async () => {
      srv = await startServer(defaultHandlers());
      const r = await run(srv.url, 'health');
      const data = JSON.parse(r.stdout);
      expect(data.ok).toBe(true);
      expect(data.engine).toBe('camoufox');
    });

    test('tabs lists open tabs', async () => {
      srv = await startServer(defaultHandlers());
      const r = await run(srv.url, 'tabs');
      expect(r.stdout).toContain('example.com');
      expect(r.stdout).toContain('httpbin.org');
    });

    test('open creates tab and prints index', async () => {
      const handlers = {
        ...defaultHandlers(),
        'POST /tabs': (url, body) => ({ tabId: 'dddd-4444-0000-0000', url: body?.url }),
        'GET /tabs': () => ({
          running: true,
          tabs: [...MOCK_TABS, { tabId: 'dddd-4444-0000-0000', url: 'https://test.dev/' }],
        }),
      };
      srv = await startServer(handlers);
      const r = await run(srv.url, 'open', 'https://test.dev/');
      expect(r.stdout).toBe('3');
    });

    test('open without URL shows error', async () => {
      srv = await startServer(defaultHandlers());
      const r = await run(srv.url, 'open');
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('Usage');
    });

    test('start warms the browser', async () => {
      const handlers = {
        ...defaultHandlers(),
        'POST /start': () => ({ ok: true, profile: 'camoufox' }),
      };
      srv = await startServer(handlers);
      const r = await run(srv.url, 'start');
      expect(r.stdout).toContain('Browser started');
    });

    test('stop requires admin key', async () => {
      srv = await startServer(defaultHandlers());
      const r = await run(srv.url, 'stop');
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('CAMOFOX_ADMIN_KEY');
    });

    test('stop sends admin key header', async () => {
      let capturedHeaders;
      const handlers = {
        ...defaultHandlers(),
      };
      const server = createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (req.method === 'POST' && url.pathname === '/stop') {
          capturedHeaders = req.headers;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, stopped: true }));
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;
      srv = { server, port, url: `http://127.0.0.1:${port}` };

      const r = await runWithEnv(srv.url, { CAMOFOX_ADMIN_KEY: 'secret123' }, 'stop');
      expect(r.stdout).toContain('Browser stopped');
      expect(capturedHeaders['x-admin-key']).toBe('secret123');
    });

    test('markdown posts URL and writes markdown to stdout', async () => {
      let capturedHeaders;
      let capturedBody;
      const server = createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/markdown') {
          capturedHeaders = req.headers;
          let body = '';
          req.on('data', c => body += c);
          req.on('end', () => {
            capturedBody = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
            res.end('# Captured\n\nHello');
          });
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;
      srv = { server, port, url: `http://127.0.0.1:${port}` };

      const r = await runWithEnv(srv.url, {
        CAMOFOX_MARKDOWN_URL: `${srv.url}/markdown`,
        CAMOFOX_MARKDOWN_TOKEN: 'tok',
      }, 'markdown', 'https://example.com/path');

      expect(r.code).toBe(0);
      expect(r.stdout).toBe('# Captured\n\nHello');
      expect(r.stderr).toBe('');
      expect(capturedHeaders.authorization).toBe('Bearer tok');
      expect(capturedBody).toEqual({ url: 'https://example.com/path' });
    });

    test('markdown endpoint errors go to stderr and exit non-zero', async () => {
      const server = createServer((req, res) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'blocked by bot challenge' }));
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;
      srv = { server, port, url: `http://127.0.0.1:${port}` };

      const r = await runWithEnv(srv.url, {
        CAMOFOX_MARKDOWN_URL: `${srv.url}/markdown`,
      }, 'markdown', 'https://example.com/');

      expect(r.code).not.toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('blocked by bot challenge');
    });

    test('markdown requires endpoint configuration', async () => {
      srv = await startServer(defaultHandlers());
      const home = mkdtempSync(join(tmpdir(), 'camofox-cli-home-'));
      tempHomes.push(home);

      const r = await runWithEnv(srv.url, {
        HOME: home,
        CAMOFOX_MARKDOWN_URL: '',
        CAMOFOX_MARKDOWN_TOKEN: '',
      }, 'markdown', 'https://example.com/');

      expect(r.code).not.toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('CAMOFOX_MARKDOWN_URL is required');
    });
  });

  describe('tab resolution', () => {
    test('resolves by numeric index', async () => {
      const handlers = {
        ...defaultHandlers(),
        'GET /tabs/bbbb-2222-0000-0000/snapshot': () => ({
          url: 'https://httpbin.org/html', snapshot: 'hello', refsCount: 0,
        }),
      };
      srv = await startServer(handlers);
      const r = await run(srv.url, 'snapshot', '1');
      expect(r.stdout).toBe('hello');
    });

    test('resolves by domain (unique)', async () => {
      const handlers = {
        ...defaultHandlers(),
        'GET /tabs/bbbb-2222-0000-0000/snapshot': () => ({
          url: 'https://httpbin.org/html', snapshot: 'httpbin-page', refsCount: 0,
        }),
      };
      srv = await startServer(handlers);
      const r = await run(srv.url, 'snapshot', 'httpbin.org');
      expect(r.stdout).toBe('httpbin-page');
    });

    test('errors on ambiguous domain', async () => {
      srv = await startServer(defaultHandlers());
      // example.com matches 2 tabs (index 0 and 2)
      const r = await run(srv.url, 'snapshot', 'example.com');
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('Ambiguous');
    });

    test('resolves by UUID prefix', async () => {
      const handlers = {
        ...defaultHandlers(),
        'GET /tabs/aaaa-1111-0000-0000/snapshot': () => ({
          url: 'https://www.example.com/page1', snapshot: 'prefix-match', refsCount: 0,
        }),
      };
      srv = await startServer(handlers);
      const r = await run(srv.url, 'snapshot', 'aaaa');
      expect(r.stdout).toBe('prefix-match');
    });

    test('errors on out-of-range index', async () => {
      srv = await startServer(defaultHandlers());
      const r = await run(srv.url, 'snapshot', '99');
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('out of range');
    });

    test('errors on no matching tab', async () => {
      srv = await startServer(defaultHandlers());
      const r = await run(srv.url, 'snapshot', 'nosuch.dev');
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('No tab matching');
    });
  });

  describe('tab commands', () => {
    test('click sends ref', async () => {
      let captured;
      const handlers = {
        ...defaultHandlers(),
        'POST /tabs/aaaa-1111-0000-0000/click': (url, body) => {
          captured = body;
          return { ok: true };
        },
      };
      srv = await startServer(handlers);
      await run(srv.url, 'click', '0', 'e5');
      expect(captured.ref).toBe('e5');
    });

    test('type sends ref and text', async () => {
      let captured;
      const handlers = {
        ...defaultHandlers(),
        'POST /tabs/aaaa-1111-0000-0000/type': (url, body) => {
          captured = body;
          return { ok: true };
        },
      };
      srv = await startServer(handlers);
      await run(srv.url, 'type', '0', 'e3', 'hello', 'world');
      expect(captured.ref).toBe('e3');
      expect(captured.text).toBe('hello world');
    });

    test('press sends key', async () => {
      let captured;
      const handlers = {
        ...defaultHandlers(),
        'POST /tabs/aaaa-1111-0000-0000/press': (url, body) => {
          captured = body;
          return { ok: true };
        },
      };
      srv = await startServer(handlers);
      await run(srv.url, 'press', '0', 'Enter');
      expect(captured.key).toBe('Enter');
    });

    test('goto sends url', async () => {
      let captured;
      const handlers = {
        ...defaultHandlers(),
        'POST /tabs/aaaa-1111-0000-0000/navigate': (url, body) => {
          captured = body;
          return { ok: true, url: body.url };
        },
      };
      srv = await startServer(handlers);
      const r = await run(srv.url, 'goto', '0', 'https://new.site/');
      expect(captured.url).toBe('https://new.site/');
      expect(r.stdout).toBe('https://new.site/');
    });

    test('scroll defaults to down 500', async () => {
      let captured;
      const handlers = {
        ...defaultHandlers(),
        'POST /tabs/aaaa-1111-0000-0000/scroll': (url, body) => {
          captured = body;
          return { ok: true };
        },
      };
      srv = await startServer(handlers);
      await run(srv.url, 'scroll', '0');
      expect(captured.direction).toBe('down');
      expect(captured.amount).toBe(500);
    });

    test('unknown command shows error', async () => {
      srv = await startServer(defaultHandlers());
      const r = await run(srv.url, 'badcommand');
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('Unknown command');
    });
  });

  // Multi-agent / shared-host CLI ergonomics (P2–P5). All behavior lives in
  // cli.js; nothing here touches the upstream server.
  describe('multi-agent auth & serve', () => {
    // A server that records the Authorization header of the last request.
    function startHeaderCapture() {
      return new Promise((resolve) => {
        let captured = null;
        const server = createServer((req, res) => {
          captured = req.headers;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, engine: 'camoufox' }));
        });
        server.listen(0, '127.0.0.1', () => {
          resolve({ server, url: `http://127.0.0.1:${server.address().port}`, auth: () => captured?.authorization });
        });
      });
    }

    // A temp HOME seeded with ~/.camofox key files.
    function makeHome(files = {}) {
      const home = mkdtempSync(join(tmpdir(), 'camofox-cli-home-'));
      tempHomes.push(home);
      mkdirSync(join(home, '.camofox'), { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(home, '.camofox', name), content);
      }
      return home;
    }

    // A stub `docker` on PATH that appends its `run` argv to a log and no-ops
    // everything else (ps => not running, image inspect => exists).
    function makeDockerStub() {
      const dir = mkdtempSync(join(tmpdir(), 'camofox-cli-serve-'));
      tempHomes.push(dir);
      const home = join(dir, 'home');
      mkdirSync(join(home, '.camofox'), { recursive: true });
      const bin = join(dir, 'bin');
      mkdirSync(bin, { recursive: true });
      const log = join(dir, 'docker.log');
      writeFileSync(join(bin, 'docker'),
        `#!/bin/sh\ncase "$1" in\n  ps) exit 0;;\n  image) exit 0;;\n  run) shift; printf '%s\\n' "$*" >> "${log}"; exit 0;;\n  *) exit 0;;\nesac\n`,
        { mode: 0o755 });
      return { home, bin, readLog: () => { try { return readFileSync(log, 'utf8'); } catch { return ''; } } };
    }

    test('prefers the access key over the api key as bearer', async () => {
      srv = await startHeaderCapture();
      const home = makeHome({ 'api-key': 'APIKEY\n', 'access-key': 'ACCESSKEY\n' });
      await runWithEnv(srv.url, { HOME: home, CAMOFOX_API_KEY: '', CAMOFOX_ACCESS_KEY: '' }, 'health');
      expect(srv.auth()).toBe('Bearer ACCESSKEY');
    });

    test('falls back to the api key when no access key is configured', async () => {
      srv = await startHeaderCapture();
      const home = makeHome({ 'api-key': 'APIKEY\n' });
      await runWithEnv(srv.url, { HOME: home, CAMOFOX_API_KEY: '', CAMOFOX_ACCESS_KEY: '' }, 'health');
      expect(srv.auth()).toBe('Bearer APIKEY');
    });

    test('CAMOFOX_ACCESS_KEY env overrides the access-key file', async () => {
      srv = await startHeaderCapture();
      const home = makeHome({ 'access-key': 'FILEACCESS\n' });
      await runWithEnv(srv.url, { HOME: home, CAMOFOX_API_KEY: '', CAMOFOX_ACCESS_KEY: 'ENVACCESS' }, 'health');
      expect(srv.auth()).toBe('Bearer ENVACCESS');
    });

    test('non-loopback CAMOFOX_URL gives a remote-aware connection error (no serve hint)', async () => {
      const home = makeHome();
      const r = await runWithEnv('http://0.0.0.0:1', { HOME: home }, 'health');
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('remote server');
      expect(r.stderr).not.toContain('camofox serve -d');
    });

    test('serve --publish off-loopback --durable assembles a gated, durable docker run', async () => {
      const { home, bin, readLog } = makeDockerStub();
      await runWithEnv('http://127.0.0.1:9377',
        { HOME: home, PATH: `${bin}:${process.env.PATH}`, CAMOFOX_API_KEY: '', CAMOFOX_ACCESS_KEY: '' },
        'serve', '--publish', '0.0.0.0', '--durable');
      const logged = readLog();
      expect(logged).toContain('-p 0.0.0.0:9377:9377');
      expect(logged).toContain('--restart unless-stopped');
      expect(logged).toContain('-v camofox-state:/root/.camofox');
      expect(logged).toContain('CAMOFOX_ACCESS_KEY=');
      expect(logged).not.toContain('--rm');
    });

    test('serve -d stays on loopback with --rm and no access key', async () => {
      const { home, bin, readLog } = makeDockerStub();
      await runWithEnv('http://127.0.0.1:9377',
        { HOME: home, PATH: `${bin}:${process.env.PATH}`, CAMOFOX_API_KEY: '', CAMOFOX_ACCESS_KEY: '' },
        'serve', '-d');
      const logged = readLog();
      expect(logged).toContain('--rm');
      expect(logged).toContain('-p 127.0.0.1:9377:9377');
      expect(logged).not.toContain('CAMOFOX_ACCESS_KEY=');
      expect(logged).not.toContain('--restart');
    });
  });
});
