# Flaregun Repo Gotchas

Work-derived traps and procedures observed while maintaining the flaregun repo.

## TypeScript / tooling
- `bunx tsc` resolves to TypeScript 7 in this environment and works even though the root project has no local `typescript` dependency.

## Cloudflare SDK
- Cloudflare SDK 4.x has no `zeroTrust.tunnels.create`; tunnels live under `zeroTrust.tunnels.cloudflared.{create,list,get,token.get}`. The pre-facelift setup called the missing path and only passed because tests mocked it — a reminder that mocked tests can hide wrong SDK paths.

## Dashboard automation
- Headless Chrome opening dash.cloudflare.com gets the "Just a moment..." Turnstile check at the same URL, so detect it by `document.title` or a `challenges.cloudflare.com` iframe, not by hostname.
- When writing page scripts inside TS template literals via python edits, regex escapes like `\\/` get lost and turn into `//` comments; prefer plain string checks.

## Testing
- Test the dashboard automation with `FLAREGUN_TEST_CHROME=~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome bun test tests/browser` (uses a local fake dashboard).
- `tests/admin.test.ts` subscription-switch test raced with restarting echo services; fixed by waiting for two history messages.
