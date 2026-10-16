"""Declared electrical construction facts, independent of layout or display geometry."""


def impedance_fact(stock, element_path):
    """Nearest explicit feature/ancestor impedance fact, then explicit stockwide scope.

    A closer unknown declaration takes precedence. Facts on sibling coax groups do not
    apply to power cores. Missing or unsupported units remain unknown to the caller.
    """
    parts = element_path.split(".")
    node = stock.structure
    if not parts or parts[0] != node.id:
        return None
    ancestors = [node]
    for part in parts[1:]:
        node = next((child for child in getattr(node, "children", []) if child.id == part), None)
        if node is None:
            return None
        ancestors.append(node)
    for node in reversed(ancestors):
        if "impedance" in node.facts:
            return node.facts["impedance"]
    return stock.facts.get("impedance")


def ohm_value(fact):
    if fact is None or fact.status == "unknown" or not isinstance(fact.value, float | int):
        return None
    if not fact.unit or fact.unit.casefold() not in {"ohm", "ohms", "ω"}:
        return None
    return float(fact.value)
