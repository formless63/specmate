# Technical references

Reviewed for this bootstrap on 2026-10-12. These are primary documentation links,
not claims that the assembled application has been tested. Lock and qualify exact
versions during implementation. External documentation must not silently override
accepted architecture or change the scope.

| Topic | Primary reference | Use |
| --- | --- | --- |
| Django support | https://www.djangoproject.com/download/ | Supported release line; 5.2 LTS selected. |
| Django migrations | https://docs.djangoproject.com/en/5.2/topics/migrations/ | Current schema creation; coordinated pre-1.0 resets. |
| Django async boundaries | https://docs.djangoproject.com/en/5.2/topics/async/ | Keep transactional operations synchronous where required. |
| Django Ninja | https://django-ninja.dev/ | Typed API and OpenAPI contracts. |
| Pydantic schemas | https://docs.pydantic.dev/latest/concepts/json_schema/ | Generate schemas rather than duplicate authoritative models. |
| PostgreSQL releases | https://www.postgresql.org/support/versioning/ | PostgreSQL 18 maintenance and support. |
| PostgreSQL extensions | https://www.postgresql.org/docs/18/pgtrgm.html | Fuzzy matching is not automatic identity approval. |
| Temporal deployment | https://docs.temporal.io/self-hosted-guide/deployment | Production server and version-matched schema tooling. |
| Temporal SQL Visibility | https://docs.temporal.io/self-hosted-guide/visibility/postgresql | PostgreSQL workflow search; no mandatory Elasticsearch. |
| Temporal testing | https://docs.temporal.io/develop/python/testing-suite | Replay compatibility and activity tests at affected checkpoints. |
| Node releases | https://nodejs.org/en/about/previous-releases | Frontend build runtime baseline; not a required app server. |
| Bun | https://bun.sh/docs/install/lockfile | JS package manager/script runner; text `bun.lock`, `--frozen-lockfile` installs. |
| Vite static build | https://vite.dev/guide/static-deploy | Ship compiled frontend assets. |
| React Flow | https://reactflow.dev/ | Interactive graph projection, not electrical semantics. |
| React Three Fiber | https://r3f.docs.pmnd.rs/advanced/scaling-performance | Demand rendering and bounded geometry. |
| KiCad CLI | https://docs.kicad.org/10.0/en/cli/cli.html | Qualify available checks/exports for the selected version. |
| build123d | https://build123d.readthedocs.io/en/latest/ | Programmatic geometry in isolated environments. |
| FreeCAD | https://github.com/FreeCAD/FreeCAD | Native-document authoring/interoperability adapter. |
| WireViz | https://github.com/wireviz/WireViz | Optional output adapter, not the cable model or primary visualizer. |
| PlatformIO Core | https://docs.platformio.org/en/latest/core/index.html | Supported firmware build environments. |
| Typst | https://typst.app/open-source/ | Local optional document composition engine. |
| MCP Python SDK | https://github.com/modelcontextprotocol/python-sdk | Agent transport; authorization remains in Specmate. |
| Podman service | https://docs.podman.io/en/latest/markdown/podman-system-service.1.html | Runtime socket is powerful execution authority. |
| Docker build contexts | https://docs.docker.com/build/building/context/ | Build only from the public application checkout. |
| Garage compatibility | https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/ | Test only the required storage API subset. |
| Gitleaks | https://github.com/gitleaks/gitleaks | Secret detection, not complete business-data privacy review. |
| Contributor instructions | https://agents.md/ | Repository guidance, distinct from runtime engineering guides. |

Required upstream notices accompany actual imported code/assets when those imports
occur. Private reference investigations and source locations are not part of this file.
