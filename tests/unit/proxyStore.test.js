import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';

// PROXY_STORE_PATH binds to $HOME at module-eval time, so set a temp HOME and
// dynamically import the module once before any test touches the filesystem.
// This keeps the roundtrip tests from ever writing to the real ~/.camofox.
const realHome = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), 'camofox-proxy-'));
let store;

beforeAll(async () => {
  process.env.HOME = home;
  store = await import('../../lib/proxy-store.js');
});

afterAll(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

describe('parseProxyLine', () => {
  test('parses ip:port:user:pass (standard format)', () => {
    expect(store.parseProxyLine('1.2.3.4:8080:bob:secret')).toEqual({
      host: '1.2.3.4',
      port: '8080',
      username: 'bob',
      password: 'secret',
      protocol: 'http',
      raw: '1.2.3.4:8080:bob:secret',
    });
  });

  test('preserves colons inside the password', () => {
    const p = store.parseProxyLine('1.2.3.4:8080:bob:s3cr:et:more');
    expect(p.username).toBe('bob');
    expect(p.password).toBe('s3cr:et:more');
  });

  test('parses host:port with no credentials', () => {
    expect(store.parseProxyLine('gate.example.com:7000')).toMatchObject({
      host: 'gate.example.com',
      port: '7000',
      username: '',
      password: '',
    });
  });

  test('parses a full http URL', () => {
    expect(store.parseProxyLine('http://bob:secret@1.2.3.4:8080')).toMatchObject({
      host: '1.2.3.4',
      port: '8080',
      username: 'bob',
      password: 'secret',
      protocol: 'http',
    });
  });

  test('parses a socks5 URL and keeps the protocol', () => {
    expect(store.parseProxyLine('socks5://u:p@host.net:1080')).toMatchObject({
      host: 'host.net',
      port: '1080',
      protocol: 'socks5',
    });
  });

  test('decodes percent-encoded URL credentials', () => {
    const p = store.parseProxyLine('http://user:p%40ss%3Aword@1.2.3.4:8080');
    expect(p.password).toBe('p@ss:word');
  });

  test('rejects unparseable input', () => {
    expect(store.parseProxyLine('')).toBeNull();
    expect(store.parseProxyLine('not-a-proxy')).toBeNull();
    expect(store.parseProxyLine('host:notaport:u:p')).toBeNull();
    expect(store.parseProxyLine('http://no-port-here')).toBeNull();
  });
});

describe('store roundtrip', () => {
  afterEach(() => store.clearStoredProxy());

  test('write → read → env → clear', () => {
    expect(store.readStoredProxy()).toBeNull();

    const proxy = {
      ...store.parseProxyLine('1.2.3.4:8080:bob:secret'),
      strategy: 'round_robin',
      country: 'us',
      source: 'byteful-residential',
    };
    store.writeStoredProxy(proxy);

    expect(store.readStoredProxy()).toMatchObject({ host: '1.2.3.4', country: 'us' });
    expect(store.storedProxyEnv()).toEqual({
      PROXY_STRATEGY: 'round_robin',
      PROXY_HOST: '1.2.3.4',
      PROXY_PORT: '8080',
      PROXY_USERNAME: 'bob',
      PROXY_PASSWORD: 'secret',
      PROXY_COUNTRY: 'us',
    });

    expect(store.clearStoredProxy()).toBe(true);
    expect(store.readStoredProxy()).toBeNull();
    expect(store.clearStoredProxy()).toBe(false);
  });

  test('storedProxyEnv is empty with no assignment', () => {
    expect(store.storedProxyEnv()).toEqual({});
  });
});
