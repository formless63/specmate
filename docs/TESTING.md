# Verification policy: relevant checks, meaningful checkpoints

Conversation turns, saves and tiny commits are not reasons to run a full test suite.
Choose the smallest checks that cover the changed behavior and affected contracts.
Testing supports fast correct work; ritual repetition does not.

## Verification levels

| Level | When | Evidence |
| --- | --- | --- |
| Focused | During/completing a coherent task | Changed-file lint/types; pertinent unit/property/contract tests; targeted browser check where relevant. |
| Integration | Connected work is ready, or a shared contract changes | Selected journeys, real tool adapters, authorization/concurrency boundaries, failure/recovery. |
| Release | Explicit integration/release candidate | Complete agreed scope, clean install, privacy/rights, restore, supported environments, resource qualification. |

A geometry material tweak does not require firmware/inventory tests. An occurrence-address
change can affect every view/export and deserves broader impacted checks despite a small
diff. Permissions, data loss, operation envelopes and runner authority are high-impact.

Do not run expensive real-tool/E2E suites after every edit or automatically every night.
Schedule meaningful batches; after a failure rerun the affected check first. Reuse a
successful result only while its relevant code/input/tool/environment fingerprints remain
unchanged. Avoid duplicate local and CI work on identical inputs without reason.

## Evidence and independence

Capability IDs map to explicit scenario obligations in `spec/acceptance.json`. Tests must
specify expected engineering results independently of the implementation where practical.
Examples include known conductor mappings/cut arithmetic, separate resistor/capacitor
semantics, contextual occurrence selection and bought-board procurement boundaries.
Several outputs agreeing with one wrong function do not prove correctness.

Preserve useful predecessor regression tests and visual baselines, but review their
embedded assumptions. Public fixtures are original synthetic examples or approved licensed
inputs. Private acceptance can validate confidential use cases separately and never be
required for public CI.

Declare evidence level: unit, contract, real-tool, browser/agent journey, installation,
recovery, or physical measurement. A mock does not establish tool compatibility. An absent
tool reports not-verified/blocked, not a successful skip disguised as acceptance.

## Deferred checks

Record the reason, affected scope, owning integration checkpoint and responsible work
item. Implementation can complete before integration verification; capability acceptance
cannot. Do not change every task back to open solely because a planned later integration
batch has not run. Keep implementation and qualification states distinguishable.

## Failure-oriented cases

Test stale writes, replayed operations, competing reservations, corrupt/partial uploads,
unauthorized traversal, cancelled subprocesses, lost receipts, disconnected/stale runners,
missing models, inconsistent sources, unknown rights and orphan cleanup. Test cancellation
of actual processes and fence stale result registration. Permission changes apply to
execution and disclosure, not just job submission.

Test Temporal workflow history compatibility when retained histories must survive a change.
Pre-1.0 disposable histories may instead be deliberately reset; do not preserve every
hour-old workflow merely for ceremony. At the supported-release boundary retained histories
and upgrade behavior become explicit obligations. Temporal's Python testing guidance
supports history replay checks.

## Bootstrap checks

`check_guidance.py` validates catalogs, cross-references, schema/example structure and
synthetic oracle arithmetic. `check_public_tree.py` is a heuristic safety scan. They are
fast repository checks, not proof of implemented product behavior or a comprehensive
confidentiality review. No application tests are claimed until the app exists.

Reference: [Temporal testing](https://docs.temporal.io/develop/python/testing-suite).
