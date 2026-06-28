// Cloudflare challenge click-solver.
//
// Ported to Node/playwright-core from techinz/playwright-captcha (Apache-2.0):
//   https://github.com/techinz/playwright-captcha
//
// Finds the Cloudflare challenge iframe and clicks its verification checkbox.
// The decisive trick (vs. our accessibility-ref clicking, which can't reach
// closed shadow roots / cross-origin iframes) is page.frames(): Playwright tracks
// the full frame tree at the protocol level, so the challenge iframe is reachable
// even when it lives inside a closed shadow root. A shadow-DOM walk is kept as a
// fallback. Relies only on the browser's own stealth to make the click pass; it
// does NOT defeat a fingerprint that Cloudflare has already hard-rejected.

const CF_IFRAME_SRC = 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/';
const INTERSTITIAL_SEL = 'script[src*="/cdn-cgi/challenge-platform/"]';
const TURNSTILE_SEL = 'input[name="cf-turnstile-response"]';

// Collect every open shadowRoot in the document as element handles.
async function getShadowRoots(queryable) {
  const handle = await queryable.evaluateHandle(() => {
    const roots = [];
    const collect = (node) => {
      if (!node) return;
      const sh = node.shadowRoot;
      if (sh) { roots.push(sh); collect(sh); }
      for (const el of node.querySelectorAll('*')) if (el.shadowRoot) collect(el);
    };
    collect(document);
    return roots;
  });
  const roots = [];
  try {
    const props = await handle.getProperties();
    for (const p of props.values()) {
      const el = p.asElement();
      if (el) roots.push(el);
    }
  } finally {
    await handle.dispose().catch(() => {});
  }
  return roots;
}

// Find elements matching `selector` across all shadow roots, plus a direct-query fallback.
async function searchShadowElements(queryable, selector, timeoutMs = 5000) {
  const found = [];
  let roots = [];
  try { roots = await getShadowRoots(queryable); } catch { /* ignore */ }
  await Promise.all(roots.map(async (root) => {
    try {
      const el = await root.waitForSelector(selector, { timeout: timeoutMs });
      if (el) found.push(el);
    } catch { /* selector not in this root */ }
  }));
  if (!found.length) {
    try { found.push(...await queryable.$$(selector)); } catch { /* ignore */ }
  }
  return found;
}

// Find all Cloudflare challenge frames (including nested + those in closed shadow roots).
async function findCfFrames(page) {
  const frames = [];
  for (const f of page.frames()) {
    try { if (f.url().includes(CF_IFRAME_SRC) && !f.isDetached()) frames.push(f); } catch { /* ignore */ }
  }
  if (frames.length) return frames;
  // Fallback: walk shadow DOM for the iframe element and resolve its content frame.
  const iframeEls = await searchShadowElements(page, 'iframe');
  for (const el of iframeEls) {
    try {
      const src = await (await el.getProperty('src')).jsonValue();
      if (src && src.includes(CF_IFRAME_SRC)) {
        const cf = await el.contentFrame();
        if (cf && !cf.isDetached()) frames.push(cf);
      }
    } catch { /* ignore */ }
  }
  return frames;
}

// Poll the CF frames until a visible checkbox appears.
async function getReadyCheckbox(frames, { attempts, delayMs }) {
  for (let i = 0; i < attempts; i++) {
    for (const frame of frames) {
      if (frame.isDetached()) continue;
      let boxes = [];
      try { boxes = await searchShadowElements(frame, 'input[type="checkbox"]'); } catch { /* ignore */ }
      for (const box of boxes) {
        try { if (await box.isVisible()) return { frame, checkbox: box }; } catch { /* ignore */ }
      }
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

async function detectChallenge(page, type) {
  const sel = type === 'turnstile' ? TURNSTILE_SEL : INTERSTITIAL_SEL;
  try { return (await page.locator(sel).count()) > 0; } catch { return false; }
}

/**
 * Attempt to solve a Cloudflare challenge on `page` by clicking the checkbox.
 * @returns {Promise<{solved: boolean, detected: boolean, type: string|null}>}
 */
export async function solveCloudflare(page, opts = {}) {
  const {
    type = 'auto',
    solveClickDelayMs = 6000,
    waitCheckboxAttempts = 10,
    waitCheckboxDelayMs = 3000,
    checkboxClickAttempts = 3,
    expectedSelector = null,
  } = opts;

  let challengeType = type;
  if (challengeType === 'auto') {
    if (await detectChallenge(page, 'turnstile')) challengeType = 'turnstile';
    else if (await detectChallenge(page, 'interstitial')) challengeType = 'interstitial';
    else return { solved: true, detected: false, type: null };
  }
  if (!(await detectChallenge(page, challengeType))) {
    return { solved: true, detected: false, type: challengeType };
  }

  const frames = await findCfFrames(page);
  if (!frames.length) {
    return { solved: false, detected: true, type: challengeType, reason: 'challenge iframe not found' };
  }

  const ready = await getReadyCheckbox(frames, {
    attempts: Math.max(1, waitCheckboxAttempts),
    delayMs: waitCheckboxDelayMs,
  });
  if (!ready) {
    // No interactive checkbox appeared. Usually means Cloudflare flagged the
    // browser's fingerprint before presenting the challenge (nothing to click).
    return { solved: false, detected: true, type: challengeType, reason: 'no interactive checkbox presented' };
  }

  let clicked = false;
  for (let i = 0; i < checkboxClickAttempts; i++) {
    try { await ready.checkbox.click(); clicked = true; break; } catch { /* retry */ }
  }
  if (!clicked) {
    return { solved: false, detected: true, type: challengeType, reason: 'checkbox click failed' };
  }

  let solved = false;
  if (challengeType === 'turnstile') {
    const successEls = await searchShadowElements(ready.frame, 'div[id="success"]', solveClickDelayMs);
    if (successEls[0]) {
      try { await successEls[0].waitForElementState('visible', { timeout: solveClickDelayMs }); solved = true; }
      catch { solved = false; }
    } else {
      solved = !(await detectChallenge(page, 'turnstile'));
    }
  } else {
    try { await page.waitForLoadState('networkidle', { timeout: solveClickDelayMs }); } catch { /* ignore */ }
    solved = !(await detectChallenge(page, 'interstitial'));
  }

  if (!solved && expectedSelector) {
    try { if ((await page.locator(expectedSelector).count()) > 0) solved = true; } catch { /* ignore */ }
  }

  return { solved, detected: true, type: challengeType };
}
