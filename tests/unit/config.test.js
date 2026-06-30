import { describe, expect, test, afterEach } from '@jest/globals';
import { loadConfig } from '../../lib/config.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('loadConfig', () => {
  test('prefers CAMOUFOX_EXECUTABLE for external Camoufox executable', () => {
    process.env.CAMOUFOX_EXECUTABLE = '/nix/store/camoufox/bin/camoufox';
    process.env.CAMOUFOX_EXECUTABLE_PATH = '/ignored/camoufox';
    process.env.CAMOFOX_EXECUTABLE_PATH = '/also-ignored/camoufox';

    const config = loadConfig();

    expect(config.camoufoxExecutablePath).toBe('/nix/store/camoufox/bin/camoufox');
    expect(config.serverEnv.CAMOUFOX_EXECUTABLE).toBe('/nix/store/camoufox/bin/camoufox');
    expect(config.serverEnv.CAMOUFOX_EXECUTABLE_PATH).toBe('/ignored/camoufox');
    expect(config.serverEnv.CAMOFOX_EXECUTABLE_PATH).toBe('/also-ignored/camoufox');
  });

  test('accepts compatibility executable env vars', () => {
    process.env.CAMOUFOX_EXECUTABLE_PATH = '/compat/camoufox';
    expect(loadConfig().camoufoxExecutablePath).toBe('/compat/camoufox');

    delete process.env.CAMOUFOX_EXECUTABLE_PATH;
    process.env.CAMOFOX_EXECUTABLE_PATH = '/legacy/camoufox';
    expect(loadConfig().camoufoxExecutablePath).toBe('/legacy/camoufox');
  });

  test('configures browser RSS restart threshold', () => {
    delete process.env.BROWSER_RSS_RESTART_THRESHOLD_MB;
    expect(loadConfig().browserRssRestartThresholdMb).toBe(1500);

    process.env.BROWSER_RSS_RESTART_THRESHOLD_MB = '2048';
    expect(loadConfig().browserRssRestartThresholdMb).toBe(2048);
  });

  test('preserves zero browser idle timeout and falls back for invalid values', () => {
    delete process.env.BROWSER_IDLE_TIMEOUT_MS;
    expect(loadConfig().browserIdleTimeoutMs).toBe(300000);

    process.env.BROWSER_IDLE_TIMEOUT_MS = 'not-a-number';
    expect(loadConfig().browserIdleTimeoutMs).toBe(300000);

    process.env.BROWSER_IDLE_TIMEOUT_MS = '0';
    expect(loadConfig().browserIdleTimeoutMs).toBe(0);
  });

  test('forwards VNC env vars to server subprocess whitelist', () => {
    process.env.ENABLE_VNC = '1';
    process.env.VNC_RESOLUTION = '1280x720';
    process.env.VNC_PASSWORD = 'secret';
    process.env.VIEW_ONLY = '1';
    process.env.VNC_PORT = '5901';
    process.env.NOVNC_PORT = '6081';
    process.env.VNC_BIND = '0.0.0.0';

    const config = loadConfig();

    expect(config.pluginEnv).toEqual({ ENABLE_VNC: '1' });
    expect(config.serverEnv).toMatchObject({
      ENABLE_VNC: '1',
      VNC_RESOLUTION: '1280x720',
      VNC_PASSWORD: 'secret',
      VIEW_ONLY: '1',
      VNC_PORT: '5901',
      NOVNC_PORT: '6081',
      VNC_BIND: '0.0.0.0',
    });
  });

  describe('host binding / trustLocal', () => {
    test('defaults to 0.0.0.0 and does NOT bypass auth', () => {
      delete process.env.CAMOFOX_HOST;
      delete process.env.HOST;
      const config = loadConfig();
      expect(config.host).toBe('0.0.0.0');
      expect(config.trustLocal).toBe(false);
    });

    test('bypasses auth only for loopback-exclusive bindings', () => {
      for (const h of ['127.0.0.1', '127.1.2.3', '::1', 'localhost', 'LocalHost', '[::1]']) {
        process.env.CAMOFOX_HOST = h;
        expect(loadConfig().trustLocal).toBe(true);
      }
    });

    test('requires auth for all-interface and external bindings', () => {
      for (const h of ['0.0.0.0', '::', '192.168.1.50', '10.0.0.1', '0.0.0.0:9377']) {
        process.env.CAMOFOX_HOST = h;
        expect(loadConfig().trustLocal).toBe(false);
      }
    });

    test('CAMOFOX_HOST takes precedence over HOST', () => {
      process.env.HOST = '0.0.0.0';
      process.env.CAMOFOX_HOST = '127.0.0.1';
      const config = loadConfig();
      expect(config.host).toBe('127.0.0.1');
      expect(config.trustLocal).toBe(true);
    });
  });
});
