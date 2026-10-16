The factory ran 2 checks in parallel in 1m07s: 2 passed, 0 failed.

### full_tests: passed in 1m07s

Command: `taiga runner tests-core`
Full log: /tmp/gate-checks-irfjesv0/full_tests.log

````text
Running `tests-core` · output: /home/jp/.local/state/taiga/evidence/1-67e48bc9/runner/2026-10-16T05-55-54-611171-tests-core-a27990b1e1b64006924f045f3804e461/output.log
`tests-core` failed with exit code 1 after 9 s. The runner agent is looking into it.
## Operations run

- `tests-core` passed after 9 s. Output: /home/jp/.local/state/taiga/evidence/1-67e48bc9/runner/2026-10-16T05-56-42-766465-tests-core-0472024753264c159f8a3ffcc19e1d22/output.log

## Report

`tests-core` now passes: 666 passed, 4 skipped, 0 failed.

The earlier failures came from the runner’s temporary directory being unavailable: `mkdtemp` reported `ENOENT` at `tests/setup.test.ts:27`, `tests/process.test.ts:37`, and in lock-file tests. Cleanup errors followed from that failure.

The directory already existed when inspected, so no repair or source changes were needed. The rerun passed in 9 seconds. Browser tests remained skipped.

Repeat with `taiga runner tests-core`.

Details: /home/jp/.local/state/taiga/evidence/1-67e48bc9/runner/2026-10-16T05-56-05-139651-the-saved-operation-tests-core-just-fail-66b14e559c6e4514a5ebad4ae681c132
````

### review_ranking: passed in 1m04s

Command: `taiga review --branch --include-uncommitted --quiet`
Full log: /tmp/gate-checks-irfjesv0/review_ranking.log

````text
Branch HEAD 96767a657260 since merge base 008ecdfbdcaf with refs/remotes/origin/main; Uncommitted changes (HEAD to index, index to working copy, and untracked)

Review priority: unknown risk first, then change risk descending; smell count breaks ties.
Each changed version (committed, staged, unstaged, untracked) is ranked separately.
Risk is a model estimate from 0 to 100, independent of file smells.
Smells are counted and listed only when probability > 0.8.

| rank | file | version | change | risk / 100 | smells |
|---|---|---|---|---|---|
| 1 | "src/sync/access.ts" | committed | modified | 37.7 | 0 |
| 2 | "tests/helpers/mock-client.ts" | committed | modified | 20.4 | 0 |
| 3 | "tests/sync/access.test.ts" | committed | modified | 14.5 | 0 |

1. "src/sync/access.ts" (committed)
   Risk criteria (0-4): Behavior 1.84, Interfaces 0.66, Security 1.53, Data 1.54, Verification gaps 1.94

2. "tests/helpers/mock-client.ts" (committed)
   Risk criteria (0-4): Behavior 1.14, Interfaces 1.12, Security 0.16, Data 0.37, Verification gaps 1.05

3. "tests/sync/access.test.ts" (committed)
   Risk criteria (0-4): Behavior 1.00, Interfaces 0.22, Security 0.37, Data 0.25, Verification gaps 0.76

Risk weights: Behavior 35%, Interfaces 20%, Security 20%, Data 15%, Verification gaps 10%.
````
