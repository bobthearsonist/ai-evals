# ai-evals

Shared Node.js engine for local skill evaluations. Skill source,
cases, fixtures and run artifacts belong to the consuming repository, not this
one. Extracted from `bobthearsonist/ai` at `f39fe21`; only synthetic test data is
included here.

Requires Node.js 22.12+. **ACP is the only supported transport** for Claude
and Copilot, including the library API, CLI and multi-runner.
Native candidate profiles use temporary homes, explicit read-only tools and
controlled skill workspaces. Bounded Claude ACP smoke and judge runs have
completed in the consuming repositories; this is not cross-client acceptance
or judge calibration.
SDK/plugin-eval execution and replay code
have been removed; there is no transport selector or fallback.
ACP is not an isolation guarantee. Gherkin and compatibility JSON use the same
deterministic policy; AI judging is a separate, explicitly approved assessment.

## Install

This repository is public; installation does not require GitHub credentials.
Pin a reviewed commit from `main` or a tag in each consumer, rather than
following a moving branch. The ACP/Gherkin engine is on `main`; historical
tags may predate it. Replace the placeholder below:

```powershell
npm install --save-dev git+https://github.com/bobthearsonist/ai-evals.git#REVIEWED_COMMIT
```

The npm package is `@bobthearsonist/ai-evals`; the executable is `ai-evals`.
It is installed from Git, not published to the npm registry. For development,
clone the repository and invoke `node <checkout>\local\cli.mjs`.

`tests/fixtures` contains only a synthetic `demo` greeting skill and cases used
to test the engine. These fixtures are excluded from the installed package.
Real skill suites stay in their respective consuming repositories.

## Repository-owned evaluations

```text
your-repo/
  skills/my-skill/SKILL.md
  evals/
    evals.json
    cases/my-suite/
      cases.feature
      positive.samples.json
      negative-control.samples.json
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

Config paths are relative to the config file. Without `--config`, the engine
walks up from the working directory for `evals/evals.json` or `evals.json`; if
none exists, paths resolve from the caller as `evals/cases`, `skills`, and
`evals/.work`. Explicit `--config` always takes precedence. `--cases-dir`,
`--skill-root` (semicolon-separated), `--output-dir` and `--results-dir`
override config with paths relative to the working directory.
`EVAL_SKILL_ROOT` can also override skill roots. With no `suites` mapping, suite
ids equal their skill names and case directories.

```powershell
npx --no-install ai-evals preflight --client claude --model MODEL_ID
npx --no-install ai-evals smoke --config evals/evals.json --suite my-suite --model MODEL_ID --approve-sessions 1
npx --no-install ai-evals run --config evals/evals.json --suite my-suite --model MODEL_ID --runs 3 --approve-sessions 18
npx --no-install ai-evals run-all --config evals/evals.json
npx --no-install ai-evals smoke --config evals/evals.json --suite my-suite --case first --case second --json
npx --no-install ai-evals report evals/.work/local-runs/<run>
npx --no-install ai-evals report evals/.work/local-runs/<run> --answer --json
```

Model IDs are adapter-specific ACP selection values, not interchangeable provider
API IDs. The pinned Claude adapter exposes Haiku 5.5 as `haiku`; Copilot exposes
it as `claude-haiku-5.5`. The requested value must be confirmed before prompting;
an unavailable model fails rather than falling back to a default.

`run` requires `--suite`. `smoke` accepts repeatable `--case ID` options and
archives the selected cases in one run directory. `validate`, `smoke`, and dry-run
commands use concise human output by default; add `--json` for the complete
machine-readable result. `run-all` discovers configured suites (or case folders)
and prints the required session approval before doing paid work. A three-case,
three-repeat, with/without suite plans 18 sessions. `--concurrency` bounds
sessions in flight (1-8); the current ACP runner executes serially. Suite/runner pairs run serially, so this is a global
ceiling rather than a multiplier per suite or runner.
An alternate `ai-evals-all` binary exposes `run-all` directly.

Select one or multiple runners with `--runners` (comma-separated or repeated):

```powershell
npx --no-install ai-evals smoke --config evals/evals.json --suite my-suite --runners claude,copilot --claude-model CLAUDE_MODEL --copilot-model COPILOT_MODEL --approve-sessions 2
npx --no-install ai-evals run-all --config evals/evals.json --runners claude --runners copilot --claude-model CLAUDE_MODEL --copilot-model COPILOT_MODEL
```

The approval count includes every selected runner, suite, repetition and arm.
All selected runners must pass preflight before any paid work starts.
`--client` remains a single-runner alias; do not combine it with `--runners`.
With multiple runners, use `--claude-exe`/`--copilot-exe` and
`--claude-model`/`--copilot-model` instead of ambiguous `--exe`/`--model`. OpenCode is rejected
as unimplemented by standard entrypoints. Summaries identify runner, transport and model; smoke results go to
`smoke-summary.md`, separately from the full-run `summary.md`.

Add `evals/.work/` and `node_modules/` to the consumer's `.gitignore`.
Keep evaluation data outside distributed skill/plugin payloads.

## Case format

Author new suites in Gherkin with sample sidecars (see below). The engine's
three demo cases also use this format. JSON remains a compatibility input;
each JSON file holds one case. Version 1 remains compatible:

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
`"fixtures": true` stages the suite's `fixtures` directory for each session;
use `{{fixtures}}` in the prompt to refer to it. Schema version 1 is
supported; omitted versions remain compatible.

Version 2 adds `contains`, `not_contains`, `starts_with`, `max_length`
(inclusive), `length_less_than` (exclusive), `conventional_header`, and
`lowercase_initial`. Text operations are case-sensitive and untrimmed;
lengths count Unicode code points. Targets are `last_message` (default),
`trace`, or `commit_subject`. The latter extracts one conventional subject
from plain text, inline backticks or fenced output; ambiguous subjects fail.
V2 missing required evidence is invalid, not skipped. V2 `file_exists` is
refused until filesystem snapshots are implemented. Existing v1
`file_exists` replay behavior is unchanged.

```json
{
  "schemaVersion": 2,
  "id": "short-subject",
  "prompt": "Write a commit line.",
  "shouldTrigger": true,
  "checks": [
    { "name": "header", "type": "conventional_header", "target": "commit_subject", "types": ["feat", "fix"] },
    { "name": "short", "type": "length_less_than", "target": "commit_subject", "limit": 72 }
  ]
}
```

Suites can mix `.json` and `.feature` files. The official Gherkin parser and
Cucumber Expressions compile features to exactly the same v2 case/check
objects. IDs must be unique across the entire suite, including expanded
Scenario Outlines. Handwritten examples are offline sample sidecars
(`*.samples.json`); they never appear in the model prompt.

```powershell
ai-evals validate --config evals\evals.json --suite my-suite
ai-evals run --config evals\evals.json --suite my-suite --dry-run
ai-evals run-all --config evals\evals.json --dry-run
```

These commands parse/validate and report the expanded policy/session plan
without launching a client or making an inference call.

### Gherkin authoring

Use English features with one `@case:<id>` and one `@should-trigger` or
`@should-not-trigger` tag per scenario. The prompt is a Doc String:

```gherkin
Feature: Greeting
  @case:greeting @should-not-trigger
  Scenario: Greet the user
    When the user asks:
      """
      Say hello.
      """
    Then the response contains "hello" named "greeting"
```

A companion `greeting.samples.json` contains
`{"caseId":"greeting","pass":["hello"],"fail":["goodbye"]}`. Both arrays are
required and nonempty. Keep negative controls and discriminating samples;
samples test the graders, not model quality.

The controlled vocabulary supports response `contains`, `does not contain`,
`starts with` quoted text, and `contains each row:` with a headerless
one-column table. Response or commit subject `is at most N characters` is
inclusive; `is shorter than N characters` is exclusive. Regex steps use
`matches regex named "id" with flags "flags":` (or `does not match`) and a
Doc String. Commit subjects also support `uses a conventional header with
types "feat,fix"` and `description starts with a lowercase letter`.
Non-regex assertions may append `named "id"`. Fixture cases add
`Given the suite fixtures are available`.

Scenario Outlines require an Examples `id` column. A tag such as
`@case:greeting-<id>` substitutes that stable ID; a plain family tag uses the
row's full `id`. Give every expanded case its own sample sidecar. Source
locations and Examples rows appear in validation errors, not prompts.
Unknown steps, ambiguous IDs, orphan samples, unsupported dialects and
fixtures escaping the suite's `fixtures` directory fail offline.

## Results and deterministic regrading

Both clients execute through the same ACP runner and shared host policy.
Model answers vary; deterministic evaluation
means the same captured answer receives the same check outcomes, not that
model output repeats. Judge assessments do not change these scores.

Runs write immutable `plan.json` and `policy.json` snapshots, `normalized.json`,
transport output and archived
`traces/<case>/<arm>-<n>.jsonl` under the configured output directory. History
and `latest.json` live under the results directory; `run-all` writes
`summary.md` from the current invocation. ACP history lives under
`<resultsDir>/acp/<client>/<model-slug-and-hash>/<suite>` (Claude with an
unspecified model retains `<resultsDir>/acp/<suite>`).
Clients and models never overwrite or compare one another's latest results.
Historical non-ACP results are left untouched but cannot be replayed or judged
by this engine.

Case verdicts are `same` (absolute mean delta below 0.05), `lift` (all with
scores exceed all without scores), `regression` (reverse), `inconclusive`
(overlap), or `unmeasured` (missing arm). These are descriptive, not statistical
significance tests. Three repeats provide only a limited view of variance.
Runs without a final result are excluded and counted as invalid.

```powershell
npx --no-install ai-evals regrade evals/.work/local-runs/<run> --config evals/evals.json --suite my-suite
```

`report RUN_DIR` reads the archived policy and traces, then uses the shared
ACP parser and grader to show PASS/FAIL check outcomes, reasons, trace validity,
and Skill tool-call counts. Add `--answer` to include captured final answers or
`--json` for machine-readable detail. It makes no model calls.

Offline regrading uses the shared transcript grader and makes no model calls.
It defaults to the archived policy, so later case edits cannot silently change
the yardstick. Use `--policy current --suite my-suite` to deliberately apply
today's definitions. ACP runs without a snapshot require that explicit
option. Every replay writes a separate, uniquely named
`regrades/<id>.json` with the policy mode/hash, without rewriting the original
result. Recorded replay does not need the original source suite.
It supports text and tool-order checks. ACP cannot capture filesystem
snapshots, so filesystem checks are refused before execution.

Results use the `acp-non-hermetic` label; this is not authentication attestation.
ACP preflight does not authenticate or launch a subprocess.

## Common ACP transport and separate AI assessments

`--client claude|copilot --model MODEL_ID` selects the shared official
stable-v1 ACP client. There is no `--transport` option. It records
messages, tool events, completion and observed usage,
denies permission requests by default, and stops on errors/timeouts without
retries. Missing usage/cost is `null`, not zero. ACP does not provide an OS
sandbox, prove that ambient MCP/configuration is disabled, or enforce a
hard spend cap; spend-cap flags are rejected for this transport.
Native launch profiles must verify the required isolation controls before
inference. Unsupported controls cause refusal, not a less-isolated fallback.
Offline fake-server success is not native-runtime acceptance.
The built-in **candidate** profiles use Copilot CLI **1.0.102** or the package's
pinned Claude ACP adapter **0.94.0** / Claude Agent SDK **0.3.303**. Copilot
disables custom instructions and built-in MCPs and exposes only
`view`, `glob`, `grep`, `skill`; Claude exposes only `Read`, `Glob`, `Grep`,
`Skill`, uses project-only settings and strict empty MCP configuration.
Each arm gets a temporary Git workspace with fixtures; only the with-skill
arm contains the selected skill. Both use temporary HOME/config directories,
drop ambient provider/configuration environment variables and pass existing
credentials only in the child environment. No credential file is copied.
Claude refuses active machine-managed settings rather than bypassing policy.
OpenCode remains unsupported by standard entrypoints.

Claude uses an existing `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, or
unexpired local Claude OAuth credential; Copilot uses an existing
`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token`.
No login, token refresh, API billing substitution or fallback is attempted.
The native protocol must confirm the pinned agent version and requested model
before receiving a prompt. These controls have offline coverage, **not live
native ACP acceptance**. Historical SDK smoke acceptance is not ACP acceptance.

For an explicitly configured custom server, use `--acp-profile PATH` with a
JSON object containing `command`, `args`, and optionally `env`, `sessionMeta`
and `mcpServers`. For example, offline engine tests use:

```json
{ "command": "node", "args": ["C:\\checkout\\ai-evals\\tests\\fixtures\\fake-acp.mjs"] }
```

Custom configuration is operator opt-in, **not a verified-isolation profile**.
Results and preflight say so; it cannot replace the pinned judge profile or
assert native isolation capabilities. Do not point it at a live runtime unless
you separately accept and audit its configuration. Multi-runner invocations
require `--claude-acp-profile` and `--copilot-acp-profile` instead of an ambiguous
shared profile. `--exe` cannot be combined with a custom profile.

Every ACP candidate needs an explicit model (`auto` is rejected). Preflight
validates launch/profile capabilities, local executable/policy readiness and
credential availability without an inference call. It does not prove provider
access or live skill discovery. Approval
gates still precede native capability preflight and require the exact planned
session count. CLI exit codes are consistent: `0` means success, `1` means
evaluation/preflight failure or a below-threshold result, and `2` means a
usage/configuration/approval error. Human-readable errors use the `error:`
prefix. `--json` emits complete result objects where applicable. Dry runs report
`"transport": "acp"` without authentication or inference.
`--max-cost-usd`, `--max-ai-credits` and legacy `--copilot-home` are refused
instead of silently ignored. The current runner is serial even with a higher
concurrency ceiling. Tool/trace evidence is available, skill-discovery evidence
and filesystem snapshots are not verified; v2 filesystem checks refuse before
execution. Fixture reads explicitly refused without any successful read are
invalid execution evidence, not model-quality failures.

Each session preserves the branded frozen builder launch unchanged. Archives
store raw ACP event objects plus a receipt; the shared grader sees a serialized
raw string so live and replay trace/canary checks agree. Replay requires valid
receipts and selects ACP from recorded metadata, never from current defaults.
Copilot skill calls are identified by their native title plus structured skill
input. Anonymous ACP read/search events retain their categories, not invented
tool names: fixture-denial checks can use them, but exact tool-order checks
still require names. Unrecognized anonymous tool events remain invalid evidence.

AI judging is a separate command, never an automatic stage of `run`,
`run-all`, deterministic `regrade`, or historical score calculation:

```powershell
ai-evals judge evals\.work\local-runs\<run> --client claude --model MODEL_ID --rubric .\rubric.txt --dry-run
ai-evals judge evals\.work\local-runs\<run> --client claude --model MODEL_ID --rubric .\rubric.txt --approve-sessions N
```

Choose the judge runtime explicitly, independently of the archived candidate
runtime. `N` must exactly equal the eligible complete answers selected
(optionally `--case ID`); invalid receipts and incomplete captures are
ineligible. A missing/mismatched approval refuses before inference.
`--rubric` reads a UTF-8 text rubric applied to every selected answer, or a
`.json` object mapping case IDs to non-empty rubric strings. With a JSON map,
only cases with a rubric are eligible; other archived answers are reported
as skipped. An explicit `--case ID` without a matching rubric is an error.
Dry-run/approval counts include only eligible mapped answers. JSON rubrics
are not candidate prompts or deterministic checks.
Judge output must be strict
`{verdict,rationale,evidence}` JSON; pass/fail requires exact evidence quotes
from the answer. Evidence is trimmed and matching surrounding straight or smart
quote wrappers are removed before exact-match verification. Invalid, missing or unsupported output abstains rather than
passing. A native profile unable to verify tool/skill/MCP exclusion refuses.
There is no retry or implicit model selection. `--dry-run` reports the exact
eligible session count without inference or assessment writes.

Assessments record input/rubric hashes, runtime/model, raw output, usage and
validation status under a uniquely named `assessments` artifact. They never
overwrite candidate traces, `normalized.json`, deterministic scores or
history. These assessments are advisory. A bounded live check completed on
2026-10-23: one Claude `haiku` candidate and one judge session for each of nine
mapped rubrics; all nine produced valid, exact-evidence assessments (eight
`pass`, one `fail`). This verifies the exercised archive-to-judge execution
path only, not judge accuracy calibration or cross-provider quality. The
built-in judge profile is Claude-only and source-verified for its pinned
adapter, not independently live-audited. Other native judge runtimes remain
unsupported.
It uses the same package-pinned adapter and sterile home as candidate sessions,
with no tools or skills and no project settings. It requires adapter version
`0.94.0` and confirmation of the requested model before the prompt is sent.
Missing executables, version mismatches and unconfirmed models fail closed.

## Engine and adapters

`local/contract.mjs` defines the neutral cases, runner registry, capabilities
and results. Adapters provide `prepare`, `parseTrace`, `preflight`,
`plannedSessions` and `run`. Use `createAcpRunner({ client: 'claude' })` or
`createAcpRunner({ client: 'copilot' })` from `local/acp-runner.mjs`.
`local/acp-profiles.mjs` owns launch/isolation validation
and `local/acp.mjs` owns the protocol. `local/workspace.mjs` stages shared inputs.
`grade.mjs`, `regrade.mjs` and
`summary.mjs` handle deterministic offline checks and reporting.

Library helpers are available through subpaths, for example:

```js
import { validateCase, gradeSample } from '@bobthearsonist/ai-evals/contract';
import { loadSuite } from '@bobthearsonist/ai-evals/suite';
```

## Development

```powershell
npm test
npm pack --dry-run
```

Tests and CI use synthetic fixtures and never start live model sessions.
The ACP SDK is installed with the package; no build step is needed.
Fake ACP subprocess tests cover both CLI
clients and multi-runner forwarding without contacting any model.
