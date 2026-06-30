/**
 * Persistent proxy assignment for camofox.
 *
 * `camofox proxy use <line>` writes the chosen proxy here; both the CLI's
 * `serve` (which forwards it into the container env) and lib/config.js (which
 * reads it as a fallback for a locally-run server) consume it. Environment
 * PROXY_* variables always win over the stored value.
 *
 * Format on disk (~/.camofox/proxy.json):
 *   { "host", "port", "username", "password", "strategy", "country", "raw", "source" }
 */

import { homedir } from 'os';
import { join, dirname } from 'path';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';

export const PROXY_STORE_PATH = join(homedir(), '.camofox', 'proxy.json');

/**
 * Parse one proxy line into structured fields, or null if unrecognized.
 * Accepts the two shapes byteful's residential_list() can emit:
 *   - "ip:port:user:pass" or "ip:port"          (list_format=standard)
 *   - "http://user:pass@host:port" / "socks5://..." (URL formats)
 */
export function parseProxyLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return null;

  if (raw.includes('://')) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (!url.hostname || !url.port) return null;
    return {
      host: url.hostname,
      port: url.port,
      username: url.username ? decodeURIComponent(url.username) : '',
      password: url.password ? decodeURIComponent(url.password) : '',
      protocol: url.protocol.replace(/:$/, ''),
      raw,
    };
  }

  // Colon-delimited. Password may itself contain ':', so only split the first
  // three separators: host:port:user:pass(:with:colons).
  const parts = raw.split(':');
  if (parts.length < 2) return null;
  const [host, port, username = '', ...passParts] = parts;
  if (!host || !/^\d+$/.test(port)) return null;
  return {
    host,
    port,
    username,
    password: passParts.join(':'),
    protocol: 'http',
    raw,
  };
}

/** Read the stored proxy assignment, or null if none/unreadable/corrupt. */
export function readStoredProxy() {
  let text;
  try {
    text = readFileSync(PROXY_STORE_PATH, 'utf8');
  } catch {
    return null;
  }
  try {
    const obj = JSON.parse(text);
    return obj && obj.host ? obj : null;
  } catch {
    return null;
  }
}

/** Persist a proxy assignment (created from parseProxyLine + metadata). */
export function writeStoredProxy(proxy) {
  mkdirSync(dirname(PROXY_STORE_PATH), { recursive: true });
  writeFileSync(PROXY_STORE_PATH, JSON.stringify(proxy, null, 2) + '\n', { mode: 0o600 });
}

/** Remove any stored proxy assignment. Returns true if one existed. */
export function clearStoredProxy() {
  try {
    rmSync(PROXY_STORE_PATH);
    return true;
  } catch {
    return false;
  }
}

/**
 * The stored proxy as PROXY_* env pairs (empty object if none stored).
 * Used by `serve` to forward the assignment into the container, since the
 * container can't read the host's ~/.camofox.
 */
export function storedProxyEnv() {
  const p = readStoredProxy();
  if (!p) return {};
  const env = {
    PROXY_STRATEGY: p.strategy || 'round_robin',
    PROXY_HOST: p.host,
    PROXY_PORT: String(p.port),
  };
  if (p.username) env.PROXY_USERNAME = p.username;
  if (p.password) env.PROXY_PASSWORD = p.password;
  if (p.country) env.PROXY_COUNTRY = p.country;
  return env;
}
