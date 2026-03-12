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
  try {
    const { stdout, stderr } = await execFileAsync('node', [CLI, ...args], {
      env: { ...process.env, CAMOFOX_URL: baseUrl, CAMOFOX_USER: 'testuser', CAMOFOX_SESSION: 'default' },
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

  afterEach(() => {
    if (srv?.server) srv.server.close();
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
      const r = await run(srv.url, '1', 'snapshot');
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
      const r = await run(srv.url, 'httpbin.org', 'snapshot');
      expect(r.stdout).toBe('httpbin-page');
    });

    test('errors on ambiguous domain', async () => {
      srv = await startServer(defaultHandlers());
      // example.com matches 2 tabs (index 0 and 2)
      const r = await run(srv.url, 'example.com', 'snapshot');
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
      const r = await run(srv.url, 'aaaa', 'snapshot');
      expect(r.stdout).toBe('prefix-match');
    });

    test('errors on out-of-range index', async () => {
      srv = await startServer(defaultHandlers());
      const r = await run(srv.url, '99', 'snapshot');
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('out of range');
    });

    test('errors on no matching tab', async () => {
      srv = await startServer(defaultHandlers());
      const r = await run(srv.url, 'nosuch.dev', 'snapshot');
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
      await run(srv.url, '0', 'click', 'e5');
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
      await run(srv.url, '0', 'type', 'e3', 'hello', 'world');
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
      await run(srv.url, '0', 'press', 'Enter');
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
      const r = await run(srv.url, '0', 'goto', 'https://new.site/');
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
      await run(srv.url, '0', 'scroll');
      expect(captured.direction).toBe('down');
      expect(captured.amount).toBe(500);
    });

    test('unknown command shows error', async () => {
      srv = await startServer(defaultHandlers());
      const r = await run(srv.url, '0', 'badcommand');
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('Unknown tab command');
    });
  });
});
