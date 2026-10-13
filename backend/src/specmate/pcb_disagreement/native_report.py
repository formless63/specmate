"""Canonical extracted evidence, distinct from editable human assertions."""

import hashlib
import json
from typing import Literal
from uuid import UUID

from pydantic import Field, model_validator

from specmate.assemblies.contracts import StrictModel
from specmate.pcb_disagreement.contracts import Digest, TerminalAssertion, Text


class ExtractedTerminal(TerminalAssertion):
    sheet_path: Literal["/"]
    unit: Text
    native_component_id: Text
    native_terminal_id: None = None
    net_state: Literal["assigned", "unknown"] = "unknown"


class NativeReport(StrictModel):
    format_version: Literal[1] = 1
    adapter: Literal["kicad-net-assertions-v1"]
    tool_version: Literal["10.0.6"]
    source_role: Literal["schematic", "netlist"]
    method: Literal["native_schematic_export", "preserved_netlist_parser"]
    source_sha256: Digest
    xml_sha256: Digest
    native_format_version: Literal["20250114", "E"]
    xml_version: Literal["E"]
    reported_source_tool: Text | None
    coverage: Literal["root_unit_pin_inventory"]
    terminals: list[ExtractedTerminal] = Field(max_length=2000)
    unsupported: list[Text] = Field(max_length=200)
    physical_qualification: Literal[False] = False

    @model_validator(mode="after")
    def source_method(self):
        expected = {
            "schematic": ("native_schematic_export", "20250114"),
            "netlist": ("preserved_netlist_parser", "E"),
        }
        if (self.method, self.native_format_version) != expected[self.source_role]:
            raise ValueError("Extraction method and native format must match the source role")
        if len({t.local_id for t in self.terminals}) != len(self.terminals):
            raise ValueError("Extracted terminal occurrence IDs must be unique")
        for terminal in self.terminals:
            if str(UUID(terminal.native_component_id)) != terminal.native_component_id:
                raise ValueError("Native component ID must be a canonical UUID")
            identity = (
                self.source_sha256,
                terminal.native_component_id,
                terminal.sheet_path,
                terminal.unit,
                terminal.pin,
            )
            expected = "terminal-" + hashlib.sha256(json.dumps(identity).encode()).hexdigest()
            if terminal.local_id != expected:
                raise ValueError(
                    "Terminal identity differs from exact source/native occurrence fields"
                )
        return self
