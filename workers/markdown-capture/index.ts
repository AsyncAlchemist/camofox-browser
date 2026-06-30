/**
 * Cloudflare Browser Rendering Markdown capture endpoint for camofox CLI.
 *
 * Routes:
 *   POST /markdown  { "url": "https://example.com" } -> text/markdown
 *   GET  /health    -> { ok: true }
 *
 * Optional secret:
 *   MARKDOWN_CAPTURE_TOKEN
 *
 * When MARKDOWN_CAPTURE_TOKEN is set, callers must send:
 *   Authorization: Bearer <token>
 */

interface BrowserRendering extends Fetcher {
  quickAction(
    action: "markdown",
    options: {
      url: string;
      rejectRequestPattern?: string[];
      gotoOptions?: { waitUntil?: string; timeout?: number };
    }
  ): Promise<Response>;
}

interface Env {
  BROWSER: BrowserRendering;
  MARKDOWN_CAPTURE_TOKEN?: string;
}

const CHALLENGE_MARKERS = [
  "performing security verification",
  "challenges.cloudflare.com",
  "verifying you are human",
  "verify you are human",
  "enable javascript and cookies to continue",
  "just a moment...",
  "attention required! | cloudflare",
];

// Defense-in-depth against SSRF at the browser navigation layer. validateUrl
// vets the initial URL, but a public hostname can REDIRECT to an internal IP
// literal (302 -> http://169.254.169.254/) or pull internal subresources;
// rejectRequestPattern blocks any such request the browser would make.
// (Residual gap: pure DNS rebinding of a public hostname to a private A record
// is resolved at navigation time and can't be caught by URL/IP-literal rules
// here — that needs DoH pre-resolution, out of scope for this layer.)
const REJECT_INTERNAL_PATTERNS = [
  "^https?://(\\[)?(localhost|[^/]*\\.local)([:/]|$)",
  "^https?://metadata\\.google\\.internal([:/]|$)",
  "^https?://127\\.",
  "^https?://0\\.",
  "^https?://10\\.",
  "^https?://169\\.254\\.",
  "^https?://192\\.168\\.",
  "^https?://172\\.(1[6-9]|2[0-9]|3[01])\\.",
  "^https?://\\[::1?\\]", // loopback / unspecified
  "^https?://\\[::ffff:", // IPv4-mapped
  "^https?://\\[f[cd][0-9a-f]*:", // ULA fc00::/7
  "^https?://\\[fe[89ab][0-9a-f]*:", // link-local fe80::/10
];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function text(markdown: string): Response {
  return new Response(markdown, {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
    },
  });
}

function isBotChallenge(markdown: string): boolean {
  const lower = markdown.toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => lower.includes(marker));
}

function bearerToken(req: Request): string {
  const header = req.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function isPrivateIpv4(hostname: string): boolean {
  // Note: the WHATWG URL parser already normalizes decimal/octal/hex/short-form
  // IPv4 literals (e.g. http://2130706433/, http://0x7f000001/, http://127.1/)
  // to dotted-quad in parsed.hostname before this runs, so a dotted-quad check
  // is sufficient — non-dotted forms never reach here un-normalized.
  const parts = hostname.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

// parsed.hostname renders IPv6 bracketed and lowercased, e.g. "[fd00::1]".
// Block loopback, unspecified, ULA (fc00::/7), link-local (fe80::/10), and any
// IPv4-mapped/compatible address (::ffff:127.0.0.1 normalizes to "[::ffff:7f00:1]",
// which the dotted-quad isPrivateIpv4 check never sees).
function isBlockedIpv6(hostname: string): boolean {
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return false;
  const addr = hostname.slice(1, -1).toLowerCase();
  if (addr === "::1" || addr === "::") return true; // loopback / unspecified
  // Anything in the "::"-prefixed space embeds an IPv4 (mapped/compatible) or is
  // loopback/unspecified — none are valid public destinations, so block the class.
  if (addr.startsWith("::")) return true;
  const first = parseInt(addr.split(":")[0], 16);
  if (Number.isNaN(first)) return false;
  if (first >= 0xfc00 && first <= 0xfdff) return true; // ULA fc00::/7
  if (first >= 0xfe80 && first <= 0xfebf) return true; // link-local fe80::/10
  return false;
}

function validateUrl(input: unknown): string | null {
  if (typeof input !== "string" || !input.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal" ||
    isPrivateIpv4(hostname) ||
    isBlockedIpv6(hostname)
  ) {
    return null;
  }

  return parsed.toString();
}

async function captureMarkdown(env: Env, url: string): Promise<Response> {
  const response = await env.BROWSER.quickAction("markdown", {
    url,
    rejectRequestPattern: REJECT_INTERNAL_PATTERNS,
    gotoOptions: { waitUntil: "networkidle2", timeout: 30000 },
  });
  const data = (await response.json()) as { success?: boolean; result?: string; errors?: unknown };
  if (!data.success || typeof data.result !== "string") {
    return json({ ok: false, error: "markdown action failed", details: data.errors ?? data }, 502);
  }
  const markdown = data.result;
  if (!markdown.trim()) {
    return json({ ok: false, error: "empty markdown (page rendered no extractable content)" }, 502);
  }
  if (isBotChallenge(markdown)) {
    return json({ ok: false, error: "blocked by bot challenge (needs camofox)" }, 502);
  }
  return text(markdown);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    if (url.pathname !== "/markdown") {
      return json({ ok: false, error: "not found" }, 404);
    }
    if (req.method !== "POST") {
      return json({ ok: false, error: "method not allowed" }, 405);
    }
    if (env.MARKDOWN_CAPTURE_TOKEN && bearerToken(req) !== env.MARKDOWN_CAPTURE_TOKEN) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    const body = (await req.json().catch(() => null)) as { url?: unknown } | null;
    const target = validateUrl(body?.url);
    if (!target) {
      return json({ ok: false, error: "url must be a public http(s) URL" }, 400);
    }

    try {
      return await captureMarkdown(env, target);
    } catch (error) {
      return json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }, 502);
    }
  },
};
