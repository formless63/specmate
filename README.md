# Specmate

A self-hosted engineering workshop for reusable parts, boards, cables, enclosures,
firmware, assemblies, and the physical things built from them.

**Repository state: early implementation.** This checkout contains the accepted
product specification, architecture, engineering contracts, synthetic acceptance
examples, a locked Django/React foundation, and a source-built six-service deployment
with durable dispatch and optional isolated execution. It is not
yet a usable Specmate application. Planned functionality is not represented as implemented.

## Intended product

Define an engineering item once, pin an exact revision wherever it is used, and carry
its identity through design, documents, configurations, builds, and physical evidence.
Humans and authorized agents use the same controlled operations. Projects are private
by default. Git is for developing this software, not a requirement for engineering users.

The entire intended scope is in [the product specification](docs/PRODUCT.md), with
stable capability IDs in [the capability catalog](spec/capabilities.json). The catalog
contains requirements, not implementation status or a public development diary.

## Start contributing

Read [AGENTS.md](AGENTS.md), [the documentation map](docs/README.md), and
[CONTRIBUTING.md](CONTRIBUTING.md). The bootstrap checks need Python 3.11 or later:

```bash
python3 scripts/check_guidance.py
python3 scripts/check_public_tree.py
```

These commands check guidance integrity and common publication hazards. They do not
certify application behavior or guarantee that all confidential information has been found.
Build and test commands are listed in [AGENTS.md](AGENTS.md) and
[development policy](docs/DEVELOPMENT.md). See [deployment instructions](deploy/README.md)
for local source builds; published installation bundles and native tool packs remain separate work.

## Foundation

Python/Django/Ninja, PostgreSQL, a React/TypeScript/Vite interface, self-hosted Temporal,
and isolated on-demand engineering tools. See [architecture](docs/ARCHITECTURE.md).
No SaaS account, ERP, accounting service, AI provider, or email provider is a required
product dependency. Native execution is an explicit capability, not a consequence of import.

## Development and rights

Before v1.0.0 there are no supported production installations or historical development
schema guarantees. Only explicitly marked disposable environments may be reset.
See [development policy](docs/DEVELOPMENT.md).

The original public application code and documentation are AGPL-3.0-only unless a
file declares otherwise. Third-party code and engineering assets retain their terms.
See [LICENSING.md](LICENSING.md) and [NOTICE](NOTICE).
