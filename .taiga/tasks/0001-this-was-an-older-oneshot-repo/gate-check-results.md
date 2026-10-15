The factory ran 4 checks in parallel in 1m08s: 2 passed, 2 failed.

### smoke: failed with exit status 1 after 34s

Command: `taiga runner request "In the repo root, run the flaregun CLI entry point with bun (see package.json bin/scripts) with --help, then 'expose --help', and report the output and exit codes. Do not contact Cloudflare."`
Full log: /tmp/gate-checks-cuo9ej6l/smoke.log

````text
## Operations run

- `cli` passed after 1 s. Output: /home/jp/.local/state/taiga/evidence/1-67e48bc9/runner/2026-10-15T21-37-16-708812-cli-23294261a307413693226814c8c6f064/output.log
- `cli` failed with exit code 1 after 0 s. Output: /home/jp/.local/state/taiga/evidence/1-67e48bc9/runner/2026-10-15T21-37-19-267004-cli-fb646c8d7e4d4daeb0ebfc2c3d997d9a/output.log

## Operations saved

- Added `cli`: Runs the flaregun CLI with supplied arguments.

## Report

`bun src/cli/index.ts --help` exited **0**:

```text
flaregun — Cloudflare Tunnels for your local ports, with Zero Trust login in front

Quick start:
  flaregun expose 3000                 https://3000.<your-domain>, login required
  flaregun expose 8080 grafana         https://grafana.<your-domain>, login required
  flaregun expose 5173 demo --public   https://demo.<your-domain>, open to anyone

Tunnels:
  setup      Connect flaregun to Cloudflare (clicks through the dashboard in your browser)
  expose     Put a local port online: expose <port> [subdomain] [--public]
  up         Start the tunnel, your services and the admin UI from flaregun.yml
  down       Stop a running flaregun up

Sites and cleanup:
  deploy     Build and deploy Pages sites and the fallback Worker
  build      Build services locally
  destroy    Delete everything flaregun created in Cloudflare

Options:
  --no-browser   setup, expose: do the Cloudflare dashboard clicks yourself
  --help, -h     Show this help text
```

`bun src/cli/index.ts expose --help` exited **1**:

```text
Unknown option --help
```

Neither command contacted Cloudflare. Repeat with `taiga runner cli --help` and `taiga runner cli expose --help`.

Details: /home/jp/.local/state/taiga/evidence/1-67e48bc9/runner/2026-10-15T21-36-57-097658-in-the-repo-root-run-the-flaregun-cli-en-d8abbbe019844fb2b84e927802b98f75
````

### full_tests: passed in 1m03s

Command: `taiga runner request "Run the browser automation tests: FLAREGUN_TEST_CHROME set to the Playwright Chromium binary under ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome, then 'bun test tests/browser'. Report pass/fail/skip counts."`
Full log: /tmp/gate-checks-cuo9ej6l/full_tests.log

````text
  runner: busy with another request; this one starts when that one finishes
## Operations run

- `tests-core` passed after 7 s. Output: /home/jp/.local/state/taiga/evidence/1-67e48bc9/runner/2026-10-15T21-37-44-959129-tests-core-2d9e6bcee8e749ac86bda1d88a148717/output.log

## Report

Browser automation tests passed: **14 passed, 0 failed, 0 skipped** across 3 files. Exit code **0**, duration **6.64s**.

Used Chromium at `/home/jp/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`.

Details: /home/jp/.local/state/taiga/evidence/1-67e48bc9/runner/2026-10-15T21-36-57-134705-run-the-browser-automation-tests-flaregu-36266c191d75496c96a7d659753ef777
````

### security: failed with exit status 1 after 12s

Command: `taiga static-checks`
Full log: /tmp/gate-checks-cuo9ej6l/security.log

````text
...
  DevSkim **DS172411** flagged `src/browser/cdp.ts:39`; `tests/admin.test.ts:546, 577, 611, 645, 690, 735, 780`; `tests/browser/fake-dashboard.ts:50, 56`; and `tests/orchestrate.test.ts:917, 926, 967, 975`. Test locations are more likely benign timing/test patterns. Check whether any delay value or callback behavior is influenced by untrusted input, especially in production code at `cdp.ts:39`; otherwise, record the test findings as false positives with rationale.

- **Debug code — likely low risk, confirm production behavior.**  
  DevSkim **DS162092** flagged `src/browser/discovery.ts:188`, `src/expose/index.ts:96, 148, 225, 227`, and `src/orchestrate/index.ts:246, 249`. Check whether these are debug-only logging or behavior that exposes sensitive data or affects production; remove or appropriately gate unsafe debug code.

### Coverage and scanner status

Gitleaks, DevSkim, and Checkov completed; Checkov reported **0 open findings**. Bandit, Gosec, PMD, Psalm, Trivy, and Zizmor were **skipped because no applicable files were in scope**—these are not clean scan results. No scanner errors were reported. **No findings were omitted from the input.** DevSkim also reports **17 ignored findings**; their details were not provided, and they were already accepted.

## Open findings

- c0e073150e8f · high · devskim DS173237 · tests/browser/dashboard-chrome.test.ts:61: Do not store tokens or keys in source code.
- 3c2e9920a763 · high · devskim DS173237 · tests/browser/fake-dashboard.ts:9: Do not store tokens or keys in source code.
- 41afd6bed329 · medium · gitleaks generic-api-key · tests/browser/fake-dashboard.ts:9: generic-api-key has detected secret for file /src/tests/browser/fake-dashboard.ts.
- 9815abf2cc6e · low · devskim DS172411 · src/browser/cdp.ts:39: Review setTimeout for untrusted data
- 254876d5e899 · low · devskim DS162092 · src/browser/discovery.ts:188: Do not leave debug code in production
- 039fbd72b865 · low · devskim DS162092 · src/expose/index.ts:96: Do not leave debug code in production
- 132a232280b5 · low · devskim DS162092 · src/expose/index.ts:148: Do not leave debug code in production
- 2c9fffc50991 · low · devskim DS162092 · src/expose/index.ts:225: Do not leave debug code in production
- 52e56b4cba9b · low · devskim DS162092 · src/expose/index.ts:227: Do not leave debug code in production
- 9fc3c250ffc3 · low · devskim DS162092 · src/orchestrate/index.ts:246: Do not leave debug code in production
- fecb918bbdf8 · low · devskim DS162092 · src/orchestrate/index.ts:249: Do not leave debug code in production
- 8f0868cdc506 · low · devskim DS172411 · tests/admin.test.ts:546: Review setTimeout for untrusted data
- 8f0868cdc506 · low · devskim DS172411 · tests/admin.test.ts:577: Review setTimeout for untrusted data
- 8f0868cdc506 · low · devskim DS172411 · tests/admin.test.ts:611: Review setTimeout for untrusted data
- 8f0868cdc506 · low · devskim DS172411 · tests/admin.test.ts:645: Review setTimeout for untrusted data
- 8f0868cdc506 · low · devskim DS172411 · tests/admin.test.ts:690: Review setTimeout for untrusted data
- d0fdf42b9a9c · low · devskim DS172411 · tests/admin.test.ts:735: Review setTimeout for untrusted data
- a3f49dc52bc5 · low · devskim DS172411 · tests/admin.test.ts:780: Review setTimeout for untrusted data
- 11f67fda26b2 · low · devskim DS172411 · tests/browser/fake-dashboard.ts:50: Review setTimeout for untrusted data
- 6c3bb8241b15 · low · devskim DS172411 · tests/browser/fake-dashboard.ts:56: Review setTimeout for untrusted data
- 499925759651 · low · devskim DS172411 · tests/orchestrate.test.ts:917: Review setTimeout for untrusted data
- 7eff177e1b9b · low · devskim DS172411 · tests/orchestrate.test.ts:926: Review setTimeout for untrusted data
- 499925759651 · low · devskim DS172411 · tests/orchestrate.test.ts:967: Review setTimeout for untrusted data
- 7eff177e1b9b · low · devskim DS172411 · tests/orchestrate.test.ts:975: Review setTimeout for untrusted data

## Ignored findings

Count, rule, who ignored it and why:

- 17 · devskim DS162092 · built-in: Tests print and log on purpose.

## Scanner notes

- bandit: No applicable files in scope
- gosec: No applicable files in scope
- pmd: No applicable files in scope
- psalm: No applicable files in scope
- trivy: No applicable files in scope
- zizmor: No applicable files in scope

## Next step

Open findings: 24. Fix each one. When a finding is a false positive, mark it with the reason it is safe, and later scans skip it:

    taiga static-checks --ignore ID [--ignore ID ...] --reason "why it is safe"

Commit .taiga/static-checks-ignore.toml with the change, then run the check again.

Results: /home/jp/.local/state/taiga/static-checks/a1152ac1ad5c4feb98c592087263fd20
````

### review_ranking: passed in 1m07s

Command: `taiga review --branch --quiet`
Full log: /tmp/gate-checks-cuo9ej6l/review_ranking.log

````text
...
13. "src/setup/io.ts" (committed)
   Risk criteria (0-4): Behavior 2.02, Interfaces 1.38, Security 0.27, Data 0.13, Verification gaps 1.88

14. "src/config/index.ts" (committed)
   Risk criteria (0-4): Behavior 1.37, Interfaces 1.43, Security 0.53, Data 0.12, Verification gaps 1.37

15. "tests/setup.test.ts" (committed)
   Risk criteria (0-4): Behavior 1.32, Interfaces 1.09, Security 0.53, Data 0.34, Verification gaps 1.19

16. "tests/browser/fake-dashboard.ts" (committed)
   Risk criteria (0-4): Behavior 1.23, Interfaces 0.83, Security 0.73, Data 0.15, Verification gaps 1.16

17. "tests/orchestrate.test.ts" (committed)
   Risk criteria (0-4): Behavior 1.45, Interfaces 1.10, Security 0.11, Data 0.11, Verification gaps 1.09

18. "src/sync/hot-reload.ts" (committed)
   Risk criteria (0-4): Behavior 1.48, Interfaces 0.49, Security 0.17, Data 0.16, Verification gaps 1.44

19. "tests/browser/dashboard-chrome.test.ts" (committed)
   Risk criteria (0-4): Behavior 1.54, Interfaces 0.35, Security 0.40, Data 0.12, Verification gaps 1.09

20. "README.md" (committed)
   Risk criteria (0-4): Behavior 0.62, Interfaces 1.04, Security 0.98, Data 0.11, Verification gaps 0.63
   No smell rules applied to this source.

21. "package.json" (committed)
   Risk criteria (0-4): Behavior 0.78, Interfaces 1.11, Security 0.45, Data 0.11, Verification gaps 0.94
   No smell rules applied to this source.

22. "tests/helpers/setup-fakes.ts" (committed)
   Risk criteria (0-4): Behavior 1.05, Interfaces 0.76, Security 0.20, Data 0.19, Verification gaps 0.91

23. "tests/sync/hot-reload.test.ts" (committed)
   Risk criteria (0-4): Behavior 1.05, Interfaces 0.25, Security 0.23, Data 0.11, Verification gaps 0.83

24. "tests/admin.test.ts" (committed)
   Risk criteria (0-4): Behavior 1.06, Interfaces 0.20, Security 0.08, Data 0.09, Verification gaps 0.90

25. "tests/config.test.ts" (committed)
   Risk criteria (0-4): Behavior 0.86, Interfaces 0.33, Security 0.33, Data 0.07, Verification gaps 0.64

26. "tests/browser/cdp.test.ts" (committed)
   Risk criteria (0-4): Behavior 1.02, Interfaces 0.22, Security 0.13, Data 0.08, Verification gaps 0.60

27. "tests/setup-token.test.ts" (committed)
   Risk criteria (0-4): Behavior 0.59, Interfaces 0.26, Security 0.37, Data 0.09, Verification gaps 0.59

28. "tests/setup-dashboard.test.ts" (committed)
   Risk criteria (0-4): Behavior 0.56, Interfaces 0.33, Security 0.27, Data 0.10, Verification gaps 0.62

29. "tests/browser/discovery.test.ts" (committed)
   Risk criteria (0-4): Behavior 0.66, Interfaces 0.23, Security 0.17, Data 0.12, Verification gaps 0.62

30. "tests/cloudflared.test.ts" (committed)
   Risk criteria (0-4): Behavior 0.59, Interfaces 0.30, Security 0.12, Data 0.08, Verification gaps 0.73

31. "tests/expose.test.ts" (committed)
   Risk criteria (0-4): Behavior 0.52, Interfaces 0.21, Security 0.20, Data 0.20, Verification gaps 0.62

Risk weights: Behavior 35%, Interfaces 20%, Security 20%, Data 15%, Verification gaps 10%.
````
