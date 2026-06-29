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
    hostname === "[::1]" ||
    hostname === "::1" ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal" ||
    isPrivateIpv4(hostname)
  ) {
    return null;
  }

  return parsed.toString();
}

async function captureMarkdown(env: Env, url: string): Promise<Response> {
  const response = await env.BROWSER.quickAction("markdown", {
    url,
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
