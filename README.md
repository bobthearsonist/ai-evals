# ai-evals

Shared Node.js engine for local skill evaluations. Skill source,
cases, fixtures and run artifacts belong to the consuming repository, not this
one. Extracted from `bobthearsonist/ai` at `f39fe21`; only synthetic test data is
included here.

Requires Node.js 22.12+. **Claude and Copilot both default to the common ACP
transport**, including their public adapter factories, CLI and multi-runner.
Native candidate ACP profiles currently refuse because ambient skill/MCP
isolation has not been verified. There is no implicit SDK/plugin-eval fallback.
ACP is not an isolation guarantee. Gherkin and compatibility JSON use the same
deterministic policy; AI judging is a separate, explicitly approved assessment.

## Install

This repository is public; installation does not require GitHub credentials.
Pin a commit or tag in each consumer, rather than following a moving branch:

```powershell
npm install --save-dev git+https://github.com/bobthearsonist/ai-evals.git#v0.1.0
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

Config paths are relative to the config file. Without `--config`, paths resolve
from the calling repository: `evals/cases`, `skills`, and `evals/.work`.
`--cases-dir`, `--skill-root` (semicolon-separated), `--output-dir` and
`--results-dir` override config with paths relative to the working directory.
`EVAL_SKILL_ROOT` can also override skill roots. With no `suites` mapping, suite
ids equal their skill names and case directories.

```powershell
npx --no-install ai-evals preflight --client claude --model MODEL_ID
npx --no-install ai-evals smoke --config evals/evals.json --suite my-suite --model MODEL_ID --approve-sessions 1
npx --no-install ai-evals run --config evals/evals.json --suite my-suite --model MODEL_ID --runs 3 --approve-sessions 18
npx --no-install ai-evals run-all --config evals/evals.json
```

`run` requires `--suite`. `run-all` discovers configured suites (or case folders)
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
`"fixtures": true` copies the suite's `fixtures` directory into each generated
case; use `{{fixtures}}` in the prompt to refer to it. Schema version 1 is
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

Both default adapters execute through the same ACP runner and shared host
policy. Explicit legacy `--transport native` retains Claude plugin eval
(v1 native graders, v2 capture-only host grading) and Copilot SDK sessions;
neither route is selected automatically.
Model answers vary; deterministic evaluation
means the same captured answer receives the same check outcomes, not that
model output repeats. Judge assessments do not change these scores.

Runs write immutable `plan.json` and `policy.json` snapshots, `normalized.json`,
transport output and archived
`traces/<case>/<arm>-<n>.jsonl` under the configured output directory. History
and `latest.json` live under the results directory; `run-all` writes
`summary.md` from the current invocation. ACP history lives under
`<resultsDir>/acp/<client>/<model-slug-and-hash>/<suite>`.
Legacy Claude history without a model stays in `<resultsDir>/<suite>`;
legacy modeled histories use `<resultsDir>/<client>/<model-slug-and-hash>/<suite>`.
Transports, clients and models never overwrite or compare one another's latest results.

Case verdicts are `same` (absolute mean delta below 0.05), `lift` (all with
scores exceed all without scores), `regression` (reverse), `inconclusive`
(overlap), or `unmeasured` (missing arm). These are descriptive, not statistical
significance tests. Three repeats provide only a limited view of variance.
Runs without a final result are excluded and counted as invalid.

```powershell
npx --no-install ai-evals regrade evals/.work/local-runs/<run> --config evals/evals.json --suite my-suite
```

Offline regrading uses the shared transcript grader and makes no model calls.
It defaults to the archived policy, so later case edits cannot silently change
the yardstick. Use `--policy current --suite my-suite` to deliberately apply
today's definitions. Legacy runs without a snapshot require that explicit
option. Every replay writes a separate, uniquely named
`regrades/<id>.json` with the policy mode/hash, without rewriting the original
result. Recorded replay does not need the original source suite.
It supports text and tool-order checks; file-existence checks are marked
skipped because archived traces do not include filesystem snapshots. Offline
scores therefore need not match live scores for cases containing such checks.

Results retain the historical `native-authenticated-non-hermetic` compatibility
label; this is not authentication attestation. The explicit `transport` field
identifies ACP versus legacy native execution. Default ACP preflight does not
authenticate or launch a subprocess. Legacy native routes reject API-key
environment overrides; their historical cost estimates/caps are not hard quotas.

## Legacy native adapters (explicit compatibility routes)

Only `--transport native` selects Claude plugin eval or the experimental
Copilot SDK adapter described below. Programmatic callers must explicitly
import `createLegacyClaudeRunner` or `createLegacyCopilotRunner`; the existing
`createClaudeRunner` and `createCopilotRunner` names now return ACP runners.
Claude's legacy path requires Claude Code 2.1.269+ and an existing subscription
login. Archived runs with missing `transport` retain their original native
parsers, regardless of today's default or supplied candidate transport flags.

### Copilot SDK adapter (experimental, legacy)

The adapter uses `@github/copilot-sdk` 1.0.25 to create a session against the
selected native Copilot CLI runtime. It does not inspect bundled code or
managed authentication-state fields. Preflight checks public `--help` options
and records the executable's version. Pin the executable you use; `--exe`
selects it and `--no-auto-update` prevents an automatically downloaded version
from being substituted. Windows requires a native executable, not an npm
`.cmd`/`.bat` wrapper.

The SDK session disables configuration discovery, supplies no configured MCP
servers, disables the exact `github-mcp-server` name for that session, and
includes no built-in skills. Only the staged skill directory and the `skill`,
`view`, `glob`, and `rg` tools are enabled. Skill and MCP inventories are
checked before and after the prompt, and runtime MCP events are audited.
Explicitly inactive MCP statuses (`disabled`, `not_configured`, or `stopped`)
are accepted; enabled servers, active or unknown statuses, and MCP tool-load
events fail closed. The SDK's `disabledMcpServers` setting is session-scoped
and exact-name matched; the disabled server is not started or authenticated.
These checks are configuration controls, not an OS sandbox or authentication
boundary.

One bounded `git-commit-style` smoke on 2026-10-22 using `gpt-6.1-sol` completed
with a valid receipt and captured usage. The staged skill was loaded and
invoked; runtime explicitly reported `github-mcp-server` disabled, no MCP
tools loaded, and empty pre/post SDK MCP inventories. Offline regrading
reproduced its score of 0.75. This is a valid, audited end-to-end smoke, but
not a case-level pass: the `header-under-72` check failed, leaving the result
below threshold. It does not measure skill lift or establish acceptance for
other CLI builds. A separate 2026-10-21 CLI-path smoke did observe active MCP
tools and a built-in-skill mismatch; that earlier run remains invalid and
unscored, and is not evidence about the corrected SDK session configuration.
No model call is made by `preflight` or `regrade`.

Replace `MODEL_ID` with an explicit model supported by your subscription;
`auto` is intentionally rejected:

```powershell
npx --no-install ai-evals preflight --transport native --client copilot --model MODEL_ID
npx --no-install ai-evals smoke --transport native --config evals/evals.json --suite my-suite --client copilot --model MODEL_ID --approve-sessions 1
npx --no-install ai-evals run --transport native --config evals/evals.json --suite my-suite --case positive --client copilot --model MODEL_ID --runs 1 --max-ai-credits 30 --timeout-seconds 120 --approve-sessions 2
```

`--max-ai-credits` defaults to 30, the CLI's minimum, **per session**. It is a
post-call soft limit: a single call can exceed it. It is not a suite-wide cap
or a USD cap. Copilot rejects `--max-cost-usd`, reports unknown USD cost as
`null`, and archives the CLI's usage JSON without converting units or prices.
The parent enforces `--timeout-seconds` (default 120) and terminates the owned
process tree on timeout or interruption. `--concurrency` bounds sessions in
flight (1-8); each case, arm and repetition gets a fresh process and workspace.
The runner does not retry failed sessions and stops scheduling after a failure;
already-running sessions may finish. `run-all --runners copilot` is supported,
subject to the same live-acceptance limitation.

By default the runner creates and removes a fresh configuration home. It never
copies credentials or injects tokens. If normal credential-store login is not
available there, provide `--copilot-home PATH` pointing to a **dedicated** home
you authenticated using the CLI's normal login flow. Do not point it at your
everyday Copilot home. The adapter does not edit or delete a supplied home and
rejects its settings, hooks, extensions, installed plugins, MCP/LSP servers,
providers, agents and personal skills. Existing token/BYOK environment overrides
are rejected. Authentication failure is reported, not replaced by API billing.

Only the with-skill workspace receives the unchanged skill snapshot under
`.github/skills/<name>`. Fixtures are copied separately; grader definitions and
canaries stay outside the workspace. Before every prompt, `copilot skill list
--json` must show exactly that enabled skill at its staged path, or no enabled
skills for the without arm. Unexpected personal, ancestor, plugin or built-in
skills cause a clear failure. In disposable generated homes only, built-in
skills are disabled through the public `skill disable` command and the listing
is checked again; supplied homes are never modified. Runtime discovery must
independently match the expected skill set. Clean configuration does not guarantee clean
skill discovery: `COPILOT_HOME` does not suppress every discovery location.
An explicit dedicated home must remain free of customizations during a run.

Prompts disable custom instructions, built-in MCP servers and user questions.
Available tools are restricted to `skill`, `view`, `glob` and `rg`, with
read/skill permissions only; no shell, writes, fleet or subagent tool is enabled.
These controls are **not an OS sandbox or an authentication boundary**. Runs
retain the `native-authenticated-non-hermetic` label.

Raw JSONL is archived unchanged in `traces/<case>/<arm>-<n>.jsonl`. Sidecar
`.receipt.json` files record exit/timeout validity and usage; stderr and skill
discovery audits live in `eval-output`. Scratch workspaces and generated homes
are removed, not archived. Preserve receipts alongside traces for regrading.
Copilot regrading selects the archived client automatically and requires valid
receipts, so a failed process with an apparently complete trace cannot become
a successful offline grade.

The SDK session worker and session configuration are in
`local/copilot-sdk.mjs`; the compatibility boundary is in `local/copilot.mjs`: root
`assistant.message`, `skill.invoked`, matched successful `tool.execution_complete`
events, `tool.execution_start`, `session.skills_loaded`, `session.idle`, the CLI's
top-level `result` envelope, error and abort events. Unknown event types are retained and ignored; malformed
events or missing root completion invalidate the run. Mentioning a skill or
requesting its tool is not invocation evidence. `view`/`glob`/`rg` map to the
shared `Read`/`Glob`/`Grep` tool-order names. `file_exists` cases are rejected
before live execution in this first version, rather than silently skipped.

Public interfaces: [programmatic CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference),
[configuration directory](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference),
and [SDK session-event types](https://github.com/github/copilot-sdk/blob/main/nodejs/src/generated/session-events.ts).

## Common ACP transport and separate AI assessments

`--client claude|copilot --model MODEL_ID` selects the shared official
stable-v1 ACP client by default; `--transport acp` is redundant. It records
messages, tool events, completion and observed usage,
denies permission requests by default, and stops on errors/timeouts without
retries. Missing usage/cost is `null`, not zero. ACP does not provide an OS
sandbox, prove that ambient MCP/configuration is disabled, or enforce a
hard spend cap; spend-cap flags are rejected for this transport.
Native launch profiles must verify the required isolation controls before
inference. Unsupported controls cause refusal, not a less-isolated fallback.
Offline fake-server success is not native-runtime acceptance.
The built-in **candidate** profiles for Claude, Copilot and OpenCode currently
all refuse: ambient skill/MCP isolation has not been verified for those ACP
launches. An `--exe` override does not bypass this refusal. Both adapter
layers have switched to ACP; this refusal is the default result until native
candidate isolation is verified. Historical SDK smoke acceptance is not ACP
acceptance. No login, API billing substitution or fallback is attempted.

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
validates launch/profile capabilities without starting an agent. Approval
gates still precede native capability preflight: single-runner unapproved
`run` exits 4, multi-runner/run-all exits 1 and prints the exact session count.
Dry runs report `"transport": "acp"` without authentication or inference.
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
from the answer. Invalid, missing or unsupported output abstains rather than
passing. A native profile unable to verify tool/skill/MCP exclusion refuses.
There is no retry or implicit model selection. `--dry-run` reports the exact
eligible session count without inference or assessment writes.

Assessments record input/rubric hashes, runtime/model, raw output, usage and
validation status under a uniquely named `assessments` artifact. They never
overwrite candidate traces, `normalized.json`, deterministic scores or
history. These assessments are advisory: no judge accuracy calibration,
cross-provider quality result, or live judge acceptance is claimed.
The built-in judge profile is Claude-only and source-verified for its pinned
adapter, not live-audited. Other native judge runtimes remain unsupported.
It expects a separately installed `claude-agent-acp` executable reporting
adapter version `0.94.0`, and confirmation of the requested model before the
prompt is sent. That adapter is not bundled or installed by this package.
Missing executables, version mismatches and unconfirmed models fail closed.

## Engine and adapters

`local/contract.mjs` defines the neutral cases, runner registry, capabilities
and results. Adapters provide `prepare`, `parseTrace`, `preflight`,
`plannedSessions` and `run`. Both default factories delegate to
`local/acp-runner.mjs`; `local/acp-profiles.mjs` owns launch/isolation validation
and `local/acp.mjs` owns the protocol. Legacy Claude alone compiles a plugin.
`grade.mjs`, `regrade.mjs` and
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
The ACP SDK and legacy Copilot SDK dependencies are installed with the package;
no build step is needed. Fake ACP subprocess tests cover both default CLI
clients and multi-runner forwarding without contacting any model.
