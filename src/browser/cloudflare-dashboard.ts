/**
 * Clicks through the Cloudflare dashboard in the person's own browser.
 *
 * Only one dashboard job is automated: creating a token from Cloudflare's
 * "Create Additional Tokens" template. Cloudflare's API can't create the first
 * token, and that template is the only way to get a token that may create
 * others. Flaregun then uses the API to make its real token with exactly the
 * permissions it needs.
 *
 * The page scripts find buttons by their visible text rather than CSS classes,
 * which change more often. When a step can't be found, the caller falls back to
 * asking the person to finish in the same tab.
 */

import type { BrowserTab } from "./cdp.js";

export const API_TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";
export const ZERO_TRUST_URL = "https://one.dash.cloudflare.com/";

/** Raised when an expected dashboard step doesn't appear in time. */
export class DashboardStepError extends Error {
  constructor(readonly step: string) {
    super(`Couldn't ${step} in the Cloudflare dashboard.`);
    this.name = "DashboardStepError";
  }
}

export interface DashboardOptions {
  /** The API tokens page; tests point this at a local copy of the dashboard. */
  tokensUrl: string;
  /** Time the person gets to log in to Cloudflare when the tab shows the login page. */
  loginMs: number;
  /** Time for each page to show the button flaregun clicks next. */
  stepMs: number;
  /** Polling interval. */
  intervalMs: number;
}

export const DEFAULT_OPTIONS: DashboardOptions = {
  tokensUrl: API_TOKENS_URL,
  loginMs: 5 * 60_000,
  stepMs: 30_000,
  intervalMs: 500,
};

/** Page helpers shared by every script. Each script calls one of them. */
const HELPERS = `
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const textOf = (el) => (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
  const clickables = () =>
    [...document.querySelectorAll("button, a, [role=button]")].filter(
      (el) => visible(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true",
    );
  const findButton = (re) => clickables().find((el) => re.test(textOf(el)));
  const clickButton = (re) => {
    const el = findButton(re);
    if (!el) return false;
    el.click();
    return true;
  };
  const clickButtonNear = (labelRe, buttonRe) => {
    const labels = [...document.querySelectorAll("body *")].filter(
      (el) =>
        visible(el) &&
        labelRe.test(textOf(el)) &&
        ![...el.children].some((child) => labelRe.test(textOf(child))),
    );
    for (const label of labels) {
      let node = label;
      for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
        const button = [...node.querySelectorAll("button, a, [role=button]")].find(
          (el) => visible(el) && buttonRe.test(textOf(el)),
        );
        if (button) {
          button.click();
          return true;
        }
      }
    }
    return false;
  };
`;

/** Wraps a statement list into an expression that runs with the helpers in scope. */
function script(body: string): string {
  return `(() => { ${HELPERS} ${body} })()`;
}

function regex(source: string): string {
  return `new RegExp(${JSON.stringify(source)}, "i")`;
}

/**
 * What the person has to do in the tab before flaregun can carry on:
 * "login" for login, sign-up, two-factor or single sign-on pages, "check" for
 * Cloudflare's "Just a moment..." human check, or "" when nothing.
 */
function personNeeded(dashboardHost: string): string {
  return script(
    `const host = location.hostname;
     if (!host) return "";
     if (/just a moment/i.test(document.title) || document.querySelector('iframe[src*="challenges.cloudflare.com"]')) return "check";
     if (host !== ${JSON.stringify(dashboardHost)} || ["/login", "/sign-up", "/two-factor", "/verify"].some((p) => location.pathname.includes(p))) return "login";
     return "";`,
  );
}

const PERSON_MESSAGES: Record<string, string> = {
  login: "  Log in to Cloudflare in the browser tab flaregun opened. flaregun carries on once you're in.",
  check: "  Cloudflare is checking that a person is using the browser. If the tab shows a checkbox, tick it.",
};

const PERSON_STEPS: Record<string, string> = {
  login: "get past the login page",
  check: "get past Cloudflare's browser check",
};

const clickWhenPresent = (label: string) =>
  script(`return clickButton(${regex(`^${label}$`)});`);

const clickNearWhenPresent = (rowLabel: string, button: string) =>
  script(`return clickButtonNear(${regex(rowLabel)}, ${regex(`^${button}$`)});`);

/**
 * Finds token-looking strings on the success page: the token field itself and
 * the example `Authorization: Bearer ...` command Cloudflare shows next to it.
 * 32-character hex strings are IDs, not tokens.
 */
export const READ_TOKENS = script(`
  const found = new Set();
  const page = document.body ? document.body.innerText : "";
  for (const m of page.matchAll(/Bearer\\s+([A-Za-z0-9_.-]{30,})/g)) found.add(m[1]);
  for (const el of document.querySelectorAll("input, textarea, code, pre, span, div, p")) {
    const value = (el.value !== undefined ? el.value : el.children.length === 0 ? el.textContent : "") || "";
    const v = value.trim();
    if (/^[A-Za-z0-9_-]{36,}$/.test(v) && !/^[0-9a-f]{32}$/.test(v)) found.add(v);
  }
  return found.size ? [...found] : null;
`);

/**
 * Creates a token from the "Create Additional Tokens" template and returns the
 * token candidates read from the success page. The caller verifies them.
 *
 * @param print - Status messages for the person
 */
export async function createBootstrapToken(
  tab: BrowserTab,
  print: (msg: string) => void,
  options: DashboardOptions = DEFAULT_OPTIONS,
): Promise<string[]> {
  const { tokensUrl, stepMs, loginMs, intervalMs } = options;
  const needed = personNeeded(new URL(tokensUrl).hostname);
  const told = new Set<string>();

  /**
   * Waits while the person logs in or passes the human check, telling them what
   * to do whenever that changes. Returns the first thing they had to do, or "".
   */
  const waitForPerson = async (): Promise<string> => {
    let need = await tab.evaluate<string>(needed).catch(() => "");
    const first = need;
    const deadline = Date.now() + loginMs;
    while (need) {
      if (!told.has(need)) print(PERSON_MESSAGES[need]);
      told.add(need);
      if (Date.now() >= deadline) throw new DashboardStepError(PERSON_STEPS[need]);
      await Bun.sleep(intervalMs);
      // While a page is loading the script can fail; keep waiting for the same thing.
      const current: string = need;
      need = await tab.evaluate<string>(needed).catch(() => current);
    }
    return first;
  };

  const steps: Array<[string, string]> = [
    ['click "Create Token"', clickWhenPresent("create token")],
    [
      'click "Use template" next to "Create Additional Tokens"',
      clickNearWhenPresent("^create additional tokens$", "use template"),
    ],
    ['click "Continue to summary"', clickWhenPresent("continue to summary")],
    ['click "Create Token" on the summary page', clickWhenPresent("create token")],
  ];

  // Let the first navigation settle; the dashboard redirects to /login when signed out.
  await Bun.sleep(intervalMs * 4);

  for (let i = 0; i < steps.length; i++) {
    let deadline = Date.now() + stepMs;
    while (true) {
      const need = await waitForPerson();
      if (need === "login") {
        // Logging in may land anywhere; start again from the API tokens page.
        await tab.navigate(tokensUrl);
        await Bun.sleep(intervalMs * 4);
        i = 0;
        deadline = Date.now() + stepMs;
        continue;
      }
      if (need) deadline = Date.now() + stepMs;
      if (await tab.evaluate<boolean>(steps[i][1]).catch(() => false)) break;
      if (Date.now() >= deadline) throw new DashboardStepError(steps[i][0]);
      await Bun.sleep(intervalMs);
    }
    // Give the single-page app a moment to swap views before looking for the next button.
    await Bun.sleep(intervalMs * 2);
  }

  const tokens = await tab.waitFor<string[]>(READ_TOKENS, stepMs, intervalMs);
  if (!tokens) throw new DashboardStepError("read the new token");
  return tokens;
}
