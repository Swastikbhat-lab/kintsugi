import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

/**
 * How Kintsugi gets hold of a browser.
 *
 * Nearly all of a real app sits behind a login, and a launched-fresh browser
 * can only ever reach the signed-out shell — so the audit reports on the login
 * screen and reads as though the product were catastrophically broken.
 *
 * The fix is not to teach the tool to authenticate. It must never be handed a
 * credential and must never type one into a page; that is the user's to do and
 * nobody else's. Instead we attach over CDP to a browser a human has already
 * signed into, and drive the session they opened.
 *
 * Which makes that browser someone else's property. Everything below is
 * written around one rule: we clean up what we created and leave the rest
 * exactly as we found it.
 */

// ---------------------------------------------------------------- options

export interface BrowserOptions {
  /**
   * CDP endpoint of an already-running, already-signed-in browser,
   * e.g. "http://localhost:9222". When absent, launch a fresh headless one.
   */
  attach?: string;
  /**
   * How long to wait on the CDP handshake. Shorter than Playwright's 30s
   * default because the common failure is "nothing is listening", and the
   * useful response to that is the help text, quickly.
   */
  connectTimeout?: number;
}

export interface BrowserHandle {
  browser: Browser;
  /**
   * The context every Kintsugi page is opened in. When attached this is the
   * user's own signed-in context — `browser.newPage()` would quietly spin up
   * a *new* context with an empty cookie jar, which loses the session and puts
   * us back to auditing login screens.
   */
  context: BrowserContext;
  /** True when we attached to someone else's browser rather than launching. */
  attached: boolean;
  /** Open a page in that context and register it for cleanup. */
  newPage(opts?: { viewport?: { width: number; height: number } }): Promise<Page>;
  /** Close only what we own: never kill a browser the user is using. */
  dispose(): Promise<void>;
}

const CONNECT_TIMEOUT = 10_000;

// ---------------------------------------------------------------- help

/**
 * Printed whenever attaching fails. Setup is the part people get wrong, and a
 * bare ECONNREFUSED tells them nothing about what to do next.
 */
export const ATTACH_HELP = `Kintsugi audits what a signed-in user actually sees, so for anything behind a
login it attaches to a browser you have already signed into yourself. It never
asks for, stores, or types a credential.

Start Chrome with a debugging port on its own profile directory:

  cmd.exe
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\\.kintsugi-chrome"

  PowerShell
    & "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:USERPROFILE\\.kintsugi-chrome"

Then, in the window that opens:

  1. Sign into the app yourself, the way you normally would.
  2. Check that http://localhost:9222/json/version returns JSON.
  3. Re-run Kintsugi with --attach http://localhost:9222

The separate --user-data-dir earns its keep twice. Chrome forwards its command
line to an already-running instance sharing that profile, so without it the flag
is silently dropped and no port ever opens. It also keeps the debugging port off
your everyday profile: any local process can drive a browser that has one open,
so sign into the app under audit there, and close the window when the run ends.`;

// ---------------------------------------------------------------- open

export async function openBrowser(opts: BrowserOptions): Promise<BrowserHandle> {
  const endpoint = opts.attach?.trim();

  // An empty --attach is a misconfiguration, not a request to launch. Falling
  // through to a fresh browser here would be the silent-fallback trap below.
  if (opts.attach !== undefined && !endpoint) {
    throw new Error(`No CDP endpoint given to attach to.\n\n${ATTACH_HELP}`);
  }

  return endpoint
    ? attachTo(endpoint, opts.connectTimeout ?? CONNECT_TIMEOUT)
    : launchFresh();
}

async function launchFresh(): Promise<BrowserHandle> {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  return makeHandle(browser, context, { attached: false, ownsContext: true });
}

async function attachTo(endpoint: string, timeout: number): Promise<BrowserHandle> {
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout });
  } catch (cause) {
    // Deliberately no fallback to a fresh launch. A silent fallback "succeeds",
    // then measures the login page of every route and reports it as a wall of
    // blockers — worse than failing, because the user has no reason to doubt it.
    throw new Error(
      `Could not attach to a browser at ${endpoint}.\n` +
        `  ${firstLine(cause)}\n\n` +
        ATTACH_HELP,
      { cause },
    );
  }

  // Reuse the context that is already authenticated. newContext() hands back a
  // blank cookie jar, which defeats the entire point of having attached.
  const existing = browser.contexts()[0];
  const context = existing ?? (await browser.newContext());
  return makeHandle(browser, context, { attached: true, ownsContext: !existing });
}

const firstLine = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).split('\n')[0].trim();

// ---------------------------------------------------------------- handle

function makeHandle(
  browser: Browser,
  context: BrowserContext,
  own: { attached: boolean; ownsContext: boolean },
): BrowserHandle {
  /** Only the pages we opened. Anything already in the context is the user's. */
  const ours: Page[] = [];
  let disposed = false;

  return {
    browser,
    context,
    attached: own.attached,

    async newPage(opts) {
      const page = await context.newPage();
      // Set after creation rather than passed in: a CDP-attached context is
      // persistent and takes no per-page options.
      if (opts?.viewport) await page.setViewportSize(opts.viewport);
      ours.push(page);
      return page;
    },

    async dispose() {
      if (disposed) return;
      disposed = true;

      if (!own.attached) {
        // We started this process, so ending it is ours to do, and it takes
        // its pages and contexts down with it.
        await browser.close();
        return;
      }

      // Attached. The browser, the window and the session belong to the user
      // and are still in use — closing any of them would be destroying
      // something we were only lent. Tear down exactly what we added.
      for (const page of ours) {
        if (!page.isClosed()) await page.close().catch(() => {});
      }
      // Only when the browser had no context at all and we made one. The
      // signed-in context we borrowed is never closed.
      if (own.ownsContext) await context.close().catch(() => {});
      ours.length = 0;

      // The CDP socket is left open on purpose. browser.close() is the only
      // way to drop it, and this module does not call that on a browser it
      // does not own. The socket keeps the event loop alive, so a long-lived
      // host should exit explicitly once the run is reported, as cli.ts does.
    },
  };
}
