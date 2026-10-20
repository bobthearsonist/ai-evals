# ai-evals

Shared, dependency-free Node.js engine for local skill evaluations. Skill source,
cases, fixtures and run artifacts belong to the consuming repository, not this
one. Extracted from `bobthearsonist/ai` at `f39fe21`; only synthetic test data is
included here.

Requires Node.js 22+. Live Claude runs require Claude Code 2.1.269+ and an
existing subscription login. **Copilot and OpenCode remain unimplemented
adapters.** No AI judge is used.

## Install

This repository is private, so GitHub SSH access is required. Pin a commit or
tag in each consumer, rather than following a moving branch:

```powershell
npm install --save-dev git+ssh://git@github.com/bobthearsonist/ai-evals.git#v0.1.0
```

The npm package is `@bobthearsonist/ai-evals`; the executable is `ai-evals`.
It is installed from Git, not published to the npm registry. For development,
clone the repository and invoke `node <checkout>\local\cli.mjs`.

## Repository-owned evaluations

```text
your-repo/
  skills/my-skill/SKILL.md
  evals/
    evals.json
    cases/my-suite/
      positive.json
      negative-control.json
      fixtures/
```

`evals/evals.json`:

```json
{
  "casesDir": "cases",
  "skillsRoots": ["../skills"],
  "outputDir": ".work/local-runs",
  "resultsDir": ".work/results",
  "suites": {
    "my-suite": { "skill": "my-skill", "cases": "my-suite" }
  }
}
```

Config paths are relative to the config file. Without `--config`, paths resolve
from the calling repository: `evals/cases`, `skills`, and `evals/.work`.
`--cases-dir`, `--skill-root` (semicolon-separated), `--output-dir` and
`--results-dir` override config with paths relative to the working directory.
`EVAL_SKILL_ROOT` can also override skill roots. With no `suites` mapping, suite
ids equal their skill names and case directories.

```powershell
npx --no-install ai-evals preflight
npx --no-install ai-evals smoke --config evals/evals.json --suite my-suite --approve-sessions 1
npx --no-install ai-evals run --config evals/evals.json --suite my-suite --runs 3 --approve-sessions 18
npx --no-install ai-evals run-all --config evals/evals.json
```

`run` requires `--suite`. `run-all` discovers configured suites (or case folders)
and prints the required session approval before doing paid work. A three-case,
three-repeat, with/without suite plans 18 sessions. `--concurrency` controls
sessions in flight per suite (1-8); `run-all` also runs suites concurrently.
An alternate `ai-evals-all` binary exposes `run-all` directly.

Add `evals/.work/` and `node_modules/` to the consumer's `.gitignore`.
Keep evaluation data outside distributed skill/plugin payloads.

## Case format

Each JSON file holds one case:

```json
{
  "schemaVersion": 1,
  "id": "positive",
  "prompt": "Use my-skill and include the word hello.",
  "shouldTrigger": true,
  "checks": [{ "name": "greeting", "type": "regex", "pattern": "hello" }],
  "samples": { "pass": ["hello"], "fail": ["goodbye"] }
}
```

Checks: `regex`, `not_regex`, `file_exists`, `tool_order`. Optional
`"fixtures": true` copies the suite's `fixtures` directory into each generated
case; use `{{fixtures}}` in the prompt to refer to it. Schema version 1 is
supported; omitted versions remain compatible.

## Results and deterministic regrading

Live execution still uses `claude plugin eval`, with deterministic checks
compiled into its grader format. Model answers vary; deterministic evaluation
means the same captured answer receives the same check outcomes, not that
model output repeats. There is no LLM-judge path.

Runs write `normalized.json`, Claude output and archived
`traces/<case>/<arm>-<n>.jsonl` under the configured output directory. History
and `latest.json` live under the results directory; `run-all` writes
`summary.md` from the current invocation.

Case verdicts are `same` (absolute mean delta below 0.05), `lift` (all with
scores exceed all without scores), `regression` (reverse), `inconclusive`
(overlap), or `unmeasured` (missing arm). These are descriptive, not statistical
significance tests. Three repeats provide only a limited view of variance.
Runs without a final result are excluded and counted as invalid.

```powershell
npx --no-install ai-evals regrade evals/.work/local-runs/<run> --config evals/evals.json --suite my-suite
```

Offline regrading uses the shared transcript grader and makes no model calls.
It supports text and tool-order checks; file-existence checks are marked
skipped because archived traces do not include filesystem snapshots. Offline
scores therefore need not match live scores for cases containing such checks.

Results are labelled `native-authenticated-non-hermetic`. API-key environment
variables are rejected to avoid unintentionally switching subscription runs
to API billing. The cost cap is delegated to Claude and cost is a list-price
estimate, not a hard quota guarantee.

## Engine and adapters

`local/contract.mjs` defines the neutral cases, runner registry, capabilities
and results. Adapters provide `prepare`, `parseTrace`, `preflight`,
`plannedSessions` and `run`. The Claude adapter compiles a temporary plugin;
the CLI does not own that compilation. `grade.mjs`, `regrade.mjs` and
`summary.mjs` handle deterministic offline checks and reporting.

Library helpers are available through subpaths, for example:

```js
import { validateCase, gradeSample } from '@bobthearsonist/ai-evals/contract';
import { loadSuite } from '@bobthearsonist/ai-evals/compile-claude';
```

## Development

```powershell
npm test
npm pack --dry-run
```

Tests and CI use synthetic fixtures and never start live model sessions.
No runtime dependencies or build step are needed.
