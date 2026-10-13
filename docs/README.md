# Documentation map and authority

| Document | Purpose |
| --- | --- |
| PRODUCT | Complete generalized product scope and boundaries. |
| ARCHITECTURE | Accepted stack, ownership, integration and deployment choices. |
| DOMAIN | Authoritative model, invariants, state semantics and worked examples. |
| CONTRACTS | Operation, source, scene, job, evidence and extension boundaries. |
| UX | Human and agent journeys, workspace interaction and progressive disclosure. |
| TESTING | Relevant checks, integration checkpoints and evidence semantics. |
| DEVELOPMENT | Fast pre-1.0 development, disposable-state policy and contribution rules. |
| OPERATIONS | Installation, startup, resources, backup, remote workers and release operation. |
| SECURITY | Trust, permissions, execution isolation, privacy and export controls. |
| REUSE | Reuse review and provenance; no private source inventory is published here. |
| EXTENSIONS | Content and executable extension lifecycle and rights boundaries. |
| RELEASE | Acceptance, publication and v1.0.0 baseline requirements. |
| SOURCES | Primary-source references for external technical claims. |
| modules/ | Detailed engineering workflow contracts. |
| decisions/ | Settled tradeoffs and superseded alternatives. |

`spec/capabilities.json` is the stable requirement index; `spec/acceptance.json` contains
scenario obligations. Neither is an implementation-status board. The issue tracker owns
work status; test results establish verification for exact inputs.

## Resolving disagreement

Operator-authorized product decisions set intent. PRODUCT defines scope; DOMAIN and
CONTRACTS define engineering invariants; ARCHITECTURE and accepted decisions define the
current implementation direction. Code or tests that contradict a requirement do not
silently amend it. Raise the conflict with its smallest concrete example and proposed fix.

Public documentation is sufficient for an outside contributor to understand and build
the product. Personal planning, progress notes, and private examples are not dependencies.
Contract examples in this bootstrap are proposed v0 formats for implementation, not
claims that an API, job engine, or app endpoint already exists.
