"""Conductor conventions: closure validation, readable rows and the stock-side lookup.

A convention is a preference, never evidence. Nothing here evaluates a cable: rows only
say what the shop usually does, and a conductor with no rule reads unknown.
"""

import json

from pydantic import ValidationError

from specmate.access.permissions import Perm, authorize
from specmate.catalog_matching.queries import current_actor
from specmate.catalog_packs.authoring import authorize_origin
from specmate.design.models import Revision
from specmate.interfaces.contracts import ConductorConvention
from specmate.interfaces.signal_contracts import RETURN_TYPES, SignalSet
from specmate.operations import NotFound, PermissionDenied, ValidationFailed
from specmate.wire_stock.schemas import StockSpecification

CONDUCTIVE = {"conductor", "shield", "drain"}
EFFECT = (
    "A convention ranks proposals and flags deviations. It is a preference: it never makes "
    "a check pass, and a conductor without a rule stays unknown."
)


def stock_elements(spec):
    """Conductive leaf elements by dot path, each with its readable label chain."""
    found = {}

    def visit(node, path, labels):
        labels = [*labels, node.label]
        if node.kind == "group":
            for child in node.children:
                visit(child, f"{path}.{child.id}", labels)
        elif node.kind in CONDUCTIVE:
            found[path] = (node, " / ".join(labels[1:]) or node.label)

    visit(spec.structure, spec.structure.id, [])
    return found


def parse_stock(closure, revision_id):
    revision = closure.revisions.get(revision_id)
    content = closure.contents.get(revision_id) or {}
    if revision is None or revision.definition.kind != "wire_stock" or "stock" not in content:
        raise ValidationFailed("A stock convention pins an exact wire stock revision.")
    try:
        return StockSpecification.model_validate(content["stock"])
    except ValidationError:
        raise ValidationFailed("The pinned stock revision is not valid stock.") from None


def validate_convention(closure, convention):
    signals = closure.values.get(convention.signal_set_revision_id)
    if not isinstance(signals, SignalSet):
        raise ValidationFailed("A convention requires an exact signal set revision.")
    by_key = {s.key: s for s in signals.signals}
    elements = {}
    if convention.scope == "stock":
        elements = stock_elements(parse_stock(closure, convention.stock_revision_id))
    for rule in convention.rules:
        use = rule.use
        if use.signal_key is not None:
            target = by_key.get(use.signal_key)
            if target is None:
                raise ValidationFailed("The signal is not declared in the pinned signal set.")
            if use.kind == "return_of" and target.type in RETURN_TYPES:
                raise ValidationFailed("A return is the return of a signal, not of another return.")
        if convention.scope == "stock":
            if rule.element_path not in elements:
                raise ValidationFailed(
                    "The element does not exist as a conductor, screen or drain "
                    "in the pinned stock revision."
                )


def describe_use(use, closure, set_ref):
    signal = None
    if use.signal_key is not None:
        signal = closure.describe(set_ref(use.signal_key))
    return {**use.model_dump(mode="json"), "signal": signal}


def convention_view(convention, closure):
    """Readable rows by element label and signal name; unmapped stock elements read unknown."""
    from specmate.interfaces.signal_contracts import SignalRef

    def ref(key):
        return SignalRef(signal_set_revision_id=convention.signal_set_revision_id, key=key)

    elements = {}
    stock = None
    if convention.scope == "stock":
        revision = closure.revisions[convention.stock_revision_id]
        elements = stock_elements(parse_stock(closure, convention.stock_revision_id))
        stock = {
            "revision_id": str(revision.id),
            "definition_id": str(revision.definition_id),
            "name": revision.definition.name,
            "number": revision.number,
        }
    rows = []
    for rule in convention.rules:
        element = elements.get(rule.element_path)
        rows.append(
            {
                "element_path": rule.element_path,
                "element_label": element[1] if element else None,
                "element_kind": element[0].kind if element else rule.element_kind,
                "color": rule.color,
                "color_hex": rule.color_hex,
                "use": describe_use(rule.use, closure, ref),
                "preference": rule.preference,
                "basis": rule.basis,
            }
        )
    mapped = {r.element_path for r in convention.rules}
    set_revision = closure.revisions[convention.signal_set_revision_id]
    return {
        "scope": convention.scope,
        "effect": "preference",
        "effect_note": EFFECT,
        "stock": stock,
        "signal_set": {
            "revision_id": str(set_revision.id),
            "name": set_revision.definition.name,
            "number": set_revision.number,
        },
        "rows": rows,
        "unmapped": [
            {"element_path": path, "element_label": label, "element_kind": node.kind}
            for path, (node, label) in elements.items()
            if path not in mapped
        ],
    }


def stock_conventions(user, stock_revision_id):
    """Frozen conventions that apply to one frozen stock revision, read-only.

    Stock conventions pinned to this exact revision rank first; ones pinned to another
    revision of the same stock are listed as such and carry no rows. Color codes appear
    only where a rule's exact display color matches an element of this stock.
    """
    from specmate.interfaces.queries import read_revision

    user = current_actor(user)
    stock = (
        Revision.objects.select_related("definition", "snapshot")
        .filter(id=stock_revision_id, definition__kind="wire_stock")
        .first()
    )
    if stock is None:
        raise NotFound("Stock revision unavailable.")
    authorize(user, stock.definition.workspace_id, Perm.WORKSPACE_READ)
    authorize_origin(user, stock.definition)
    spec = StockSpecification.model_validate(
        json.loads(bytes(stock.snapshot.canonical))["content"]["stock"]
    )
    elements = stock_elements(spec)
    pinned, coded = {}, {}
    for revision in (
        Revision.objects.select_related("definition", "snapshot")
        .filter(
            definition__kind="conductor_convention",
            definition__workspace_id=stock.definition.workspace_id,
        )
        .order_by("definition_id", "-number")
    ):
        try:
            authorize_origin(user, revision.definition)
        except (NotFound, PermissionDenied):
            continue
        content = json.loads(bytes(revision.snapshot.canonical))["content"]
        value = ConductorConvention.model_validate(content["interface"])
        if value.scope == "color_code":
            coded.setdefault(revision.definition_id, revision)
        else:
            pinned.setdefault(revision.definition_id, []).append((revision, value))
    found = []
    for revision, value in (_pick(items, stock) for items in pinned.values()):
        if revision is None:
            continue
        entry = _entry(revision, value)
        if value.stock_revision_id == stock.id:
            _, closure = read_revision(user, revision.id)
            entry["convention"] = convention_view(value, closure)
            entry["exact"] = True
        else:
            entry["exact"] = False
        found.append(entry)
    for revision in coded.values():
        content = json.loads(bytes(revision.snapshot.canonical))["content"]
        value = ConductorConvention.model_validate(content["interface"])
        matches = _color_matches(value, elements)
        if not matches:
            continue
        _, closure = read_revision(user, revision.id)
        entry = _entry(revision, value)
        view = convention_view(value, closure)
        by_color = {(r["color"], r["color_hex"], r["element_kind"]): r for r in view["rows"]}
        entry["exact"] = False
        entry["matches"] = [
            {"element_path": path, "element_label": label, "rule": by_color[key]}
            for path, label, key in matches
        ]
        found.append(entry)
    found.sort(key=lambda e: (not e["exact"], e["name"].casefold(), e["definition_id"]))
    return {
        "stock_revision_id": str(stock.id),
        "effect": "preference",
        "effect_note": EFFECT,
        "conventions": found,
    }


def _pick(items, stock):
    """The newest revision pinned to this exact stock, else the newest on its stock lineage."""
    exact = [i for i in items if i[1].stock_revision_id == stock.id]
    if exact:
        return exact[0]
    lineage = set(
        Revision.objects.filter(definition_id=stock.definition_id).values_list("id", flat=True)
    )
    same = [i for i in items if i[1].stock_revision_id in lineage]
    return same[0] if same else (None, None)


def _entry(revision, value):
    return {
        "definition_id": str(revision.definition_id),
        "name": revision.definition.name,
        "revision_id": str(revision.id),
        "number": revision.number,
        "scope": value.scope,
        "review": value.review,
        "rule_count": len(value.rules),
    }


def _color_matches(convention, elements):
    matches = []
    for rule in convention.rules:
        if not rule.color_hex:
            continue
        for path, (node, label) in elements.items():
            if (node.color or "").casefold() != rule.color_hex.casefold():
                continue
            if rule.element_kind and rule.element_kind != node.kind:
                continue
            matches.append((path, label, (rule.color, rule.color_hex, rule.element_kind)))
    return matches
