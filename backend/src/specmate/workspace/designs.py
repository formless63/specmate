"""Batched exact-state projection for the Designs landing page.

Filters run in PostgreSQL before the cursor and page limit. A recursive set of exact
pins resolves stock/board names without a per-row walk or mixing in newer dependencies.
The latest frozen content wins over drafts; draft content is used only without a revision.
Nothing in this projection evaluates engineering checks or interprets review as a pass.
"""

import json
from datetime import datetime
from uuid import UUID

from django.db import connection

from specmate.design.models import Definition, Draft, Revision, Snapshot
from specmate.operations import ValidationFailed
from specmate.workspace.contracts import ListLibrary
from specmate.workspace.design_contracts import DesignPage, DesignRecord, ListDesigns
from specmate.workspace.queries import (
    _actor,
    _context,
    _decode,
    _definitions,
    _encode,
    _records,
    _workspace,
)


def list_designs(user, payload: ListDesigns) -> dict:
    actor = _actor(user)
    workspace = _workspace(actor, payload.workspace_id)
    context = _context(workspace, payload.project_id)
    params = {"workspace": str(workspace.id), "limit": payload.limit + 1}
    predicates = []
    root_predicates = []
    if payload.kind:
        root_predicates.append("d.kind = %(kind)s")
        params["kind"] = payload.kind

    # Escape wildcard characters: these are literal substring searches, not SQL patterns.
    def contains(value):
        return "%" + value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"

    if payload.q:
        root_predicates.append("d.name ILIKE %(q)s")
        params["q"] = contains(payload.q)
    for field, value in (("from", payload.from_), ("to", payload.to)):
        if value:
            predicates.append(f"metadata->'{field}'->>'label' ILIKE %({field})s")
            params[field] = contains(value)
    for field, value in (("stocks", payload.stock), ("boards", payload.board)):
        if value:
            predicates.append(
                f"EXISTS (SELECT 1 FROM jsonb_array_elements(metadata->'{field}') p "  # noqa: S608 — fixed fields
                f"WHERE p->>'label' ILIKE %({field})s)"
            )
            params[field] = contains(value)
    if payload.status:
        if payload.status in ("draft", "draft_only"):
            root_predicates.append("r.id IS NULL AND dr.id IS NOT NULL")
        elif payload.status == "frozen":
            root_predicates.append("r.id IS NOT NULL")
        else:
            predicates.append("metadata->>'review' = %(review)s")
            params["review"] = payload.status
    if context:
        root_predicates.append(
            "EXISTS (SELECT 1 FROM access_projectreference pr "
            "LEFT JOIN design_revision rr ON rr.id = pr.revision_id "
            "WHERE pr.project_id = %(project)s AND pr.removed_at IS NULL "
            "AND (pr.definition_id = d.id OR rr.definition_id = d.id))"
        )
        params["project"] = str(context.id)
    if payload.after:
        created, record_id = _decode(payload.after, 2)
        try:
            params["created"], params["record"] = datetime.fromisoformat(created), UUID(record_id)
            if params["created"].tzinfo is None:
                raise ValueError
        except ValueError:
            raise ValidationFailed("Invalid cursor.") from None
        root_predicates.append("(d.created_at, d.id) < (%(created)s, %(record)s)")
    where = " AND ".join(predicates) or "TRUE"
    root_where = " AND ".join(root_predicates) or "TRUE"
    # With no metadata facets, resolve only this candidate page's closure. With a
    # metadata facet, PostgreSQL must filter candidates before choosing the page.
    root_limit = "ORDER BY d.created_at DESC,d.id DESC LIMIT %(limit)s" if not predicates else ""
    # Table names come only from installed Django models, never user input.
    tables = {
        "definition": Definition._meta.db_table,
        "revision": Revision._meta.db_table,
        "snapshot": Snapshot._meta.db_table,
        "draft": Draft._meta.db_table,
    }
    sql = """
    WITH RECURSIVE roots AS (
      SELECT d.id, d.name, d.kind, d.created_at, r.id revision_id, r.number,
             CASE WHEN r.id IS NULL THEN dr.id END draft_id,
             COALESCE(convert_from(s.canonical, 'UTF8')::jsonb->'content',
                      dr.content, '{{}}') content
      FROM {definition} d
      LEFT JOIN LATERAL (SELECT * FROM {revision} WHERE definition_id=d.id
                         ORDER BY number DESC LIMIT 1) r ON TRUE
      LEFT JOIN {snapshot} s ON s.id=r.snapshot_id
      LEFT JOIN LATERAL (SELECT id, content FROM {draft} WHERE definition_id=d.id
                         ORDER BY updated_at DESC, id DESC LIMIT 1) dr ON r.id IS NULL
      WHERE d.workspace_id=%(workspace)s AND d.kind IN ('cable','harness','assembly')
        AND {root_where}
      {root_limit}
    ), closure(root_id, revision_id, content) AS (
      SELECT id, revision_id, content FROM roots
      UNION
      SELECT c.root_id, r.id, convert_from(s.canonical, 'UTF8')::jsonb->'content'
      FROM closure c
      CROSS JOIN LATERAL jsonb_path_query(c.content,
        '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "revision_id$").value') pin
      JOIN {revision} r ON r.id::text = pin #>> '{{}}'
      JOIN {definition} d ON d.id=r.definition_id AND d.workspace_id=%(workspace)s
      JOIN {snapshot} s ON s.id=r.snapshot_id
    ), pins AS (
      SELECT DISTINCT c.root_id, d.kind, d.name, d.id definition_id, r.id, r.number
      FROM closure c JOIN {revision} r ON r.id=c.revision_id
      JOIN {definition} d ON d.id=r.definition_id
      WHERE d.kind IN ('wire_stock','board','pcb_population') AND d.id<>c.root_id
    ), projected AS (
      SELECT roots.*, jsonb_build_object(
        'basis', CASE WHEN roots.revision_id IS NOT NULL THEN 'latest_frozen'
                      WHEN roots.draft_id IS NOT NULL THEN 'newest_draft' ELSE 'unknown' END,
        'revision_id', roots.revision_id, 'revision', roots.number, 'draft_id', roots.draft_id,
        'review', CASE WHEN roots.content->roots.kind->>'review' IN ('reviewed','unreviewed')
                       THEN roots.content->roots.kind->>'review' ELSE 'unknown' END,
        'from', jsonb_build_object('label',
          COALESCE(f.name, roots.content->roots.kind->'endpoints'->0->>'label'),
          'basis', CASE WHEN f.kind='port' THEN 'intent_port'
                        WHEN f.id IS NOT NULL THEN 'intent_pinout'
                        WHEN roots.content->roots.kind->'endpoints'->0->>'label' IS NOT NULL
                        THEN 'endpoint_label' ELSE 'unknown' END,
          'revision_id', fr.id),
        'to', jsonb_build_object('label',
          COALESCE(t.name, roots.content->roots.kind->'endpoints'->1->>'label'),
          'basis', CASE WHEN t.kind='port' THEN 'intent_port'
                        WHEN t.id IS NOT NULL THEN 'intent_pinout'
                        WHEN roots.content->roots.kind->'endpoints'->1->>'label' IS NOT NULL
                        THEN 'endpoint_label' ELSE 'unknown' END,
          'revision_id', tr.id),
        'stocks', COALESCE((SELECT jsonb_agg(jsonb_build_object('definition_id', p.definition_id,
           'revision_id', p.id, 'revision', p.number, 'label', p.name) ORDER BY p.name,p.id)
           FROM pins p WHERE p.root_id=roots.id AND p.kind='wire_stock'), '[]'),
        'boards', COALESCE((SELECT jsonb_agg(jsonb_build_object('definition_id', p.definition_id,
           'revision_id', p.id, 'revision', p.number, 'label', p.name) ORDER BY p.name,p.id)
           FROM pins p WHERE p.root_id=roots.id AND p.kind IN ('board','pcb_population')), '[]'),
        'checks', 'not_evaluated') metadata
      FROM roots
      LEFT JOIN {revision} ir ON ir.id::text=roots.content->roots.kind->>'intent_revision_id'
      LEFT JOIN {definition} idef ON idef.id=ir.definition_id AND idef.workspace_id=%(workspace)s
      LEFT JOIN {snapshot} ins ON ins.id=ir.snapshot_id AND idef.id IS NOT NULL
      LEFT JOIN {revision} fr ON fr.id::text=
        convert_from(ins.canonical,'UTF8')::jsonb->'content'->'interface'->>'from_revision_id'
      LEFT JOIN {definition} f ON f.id=fr.definition_id AND f.workspace_id=%(workspace)s
      LEFT JOIN {revision} tr ON tr.id::text=
        convert_from(ins.canonical,'UTF8')::jsonb->'content'->'interface'->>'to_revision_id'
      LEFT JOIN {definition} t ON t.id=tr.definition_id AND t.workspace_id=%(workspace)s
    ) SELECT id,created_at,metadata FROM projected WHERE {where}
      ORDER BY created_at DESC,id DESC LIMIT %(limit)s
    """.format(**tables, where=where, root_where=root_where, root_limit=root_limit)  # noqa: S608 — fixed SQL; bound values
    with connection.cursor() as cursor:
        cursor.execute(sql, params)
        rows = cursor.fetchall()
    page = rows[: payload.limit]
    ids = [row[0] for row in page]
    query, referenced, render, loader = _definitions(workspace, ListLibrary(), context)
    if context:
        from specmate.workspace.queries import _referenced_flag

        query = query.annotate(referenced=_referenced_flag(referenced))
    definitions = {row.id: row for row in query.filter(id__in=ids)}
    records = _records([definitions[id] for id in ids], render, loader, context)
    results = [
        DesignRecord(**record.model_dump(), design=json.loads(row[2]))
        for record, row in zip(records, page, strict=True)
    ]
    next_after = (
        _encode([page[-1][1].isoformat(), str(page[-1][0])])
        if len(rows) > payload.limit and page
        else None
    )
    return DesignPage(
        workspace_id=workspace.id,
        project_id=context.id if context else None,
        results=results,
        next_after=next_after,
    ).model_dump(mode="json", by_alias=True)
