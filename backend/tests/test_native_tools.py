"""OPS-003: optional native tool catalog, explicit enablement, architecture and diagnostics."""

import json
import subprocess
from pathlib import Path

import pytest

from specmate.builds import tools
from specmate.builds.recipes import ToolNotEnabled, approved_recipe
from specmate.operations import Unsupported

KICAD = next(t for t in tools.load_catalog() if t["id"] == "kicad-10.0.6")
LIMITS = {
    "cpus": 1,
    "memory_bytes": 64 * 1024**2,
    "timeout_seconds": 60,
    "pids": 16,
    "max_output_bytes": 1024,
}


def recipe(recipe_id, image):
    return {
        "id": recipe_id,
        "image": image,
        "argv": ["/tool"],
        "limits": LIMITS,
        "outputs": [{"path": "r.txt", "media_type": "text/plain", "rights": "original"}],
    }


class FakeDocker:
    """Stands in for the docker CLI; records argv, never touches a daemon."""

    def __init__(self, cached=None, arch="amd64", broken=False):
        self.cached = set(cached or [])
        self.arch = arch
        self.broken = broken
        self.calls = []

    def __call__(self, argv, **kwargs):
        self.calls.append(argv)
        if self.broken:
            raise OSError("no docker")
        if argv[:3] == ["docker", "image", "inspect"]:
            image = argv[-1]
            if image not in self.cached:
                return subprocess.CompletedProcess(argv, 1, "", "Error: No such image: x")
            info = {"Architecture": self.arch, "Os": "linux", "Size": 123}
            return subprocess.CompletedProcess(argv, 0, json.dumps(info), "")
        if argv[:2] == ["docker", "pull"]:
            self.cached.add(argv[-1])
            return subprocess.CompletedProcess(argv, 0, "", "")
        raise AssertionError(argv)


@pytest.fixture
def stack(tmp_path):
    (tmp_path / "recipes.json").write_text("{}")
    return tmp_path


@pytest.fixture(autouse=True)
def amd64(monkeypatch):
    monkeypatch.setattr(tools, "host_architecture", lambda: "amd64")


def by_id(reports):
    return {r["id"]: r for r in reports}


def test_catalog_declares_capability_architecture_and_size_for_every_tool():
    catalog = tools.load_catalog()
    assert {"kicad-10.0.6", "avr-gcc-5.4.0"} <= {t["id"] for t in catalog}
    for tool in catalog:
        assert tool["capabilities"] and tool["platforms"]
        # Only a never-built, unpinned local tool may leave its installed size unknown.
        assert tool["installed_bytes"] or tool["image"] is None
        assert tool["download_bytes"] is None or tool["download_bytes"] > 0
        assert tool["size_note"]
    assert KICAD["download_bytes"] > 0 and KICAD["platforms"] == ["linux/amd64"]


def test_catalog_images_match_the_pinned_pack_images():
    from specmate.pcb.pack import IMAGE

    assert KICAD["image"] == IMAGE


def test_list_shows_missing_available_and_enabled_without_pulling(stack):
    docker = FakeDocker()
    assert by_id(tools.build_reports(stack, docker))["kicad-10.0.6"]["state"] == "missing"
    docker.cached.add(KICAD["image"])
    assert by_id(tools.build_reports(stack, docker))["kicad-10.0.6"]["state"] == "available"
    tools.enable_tool(stack, "kicad-10.0.6", run=docker)
    report = by_id(tools.build_reports(stack, docker))["kicad-10.0.6"]
    assert report["state"] == "enabled" and report["enabled"]
    assert report["architecture_supported"] is True and report["host_architecture"] == "amd64"
    assert not [c for c in docker.calls if c[:2] == ["docker", "pull"]]


def test_enabled_tool_with_missing_image_is_reported_not_healthy(stack):
    tools.write_enabled(stack / "tools-enabled.json", {"kicad-10.0.6": {}})
    report = by_id(tools.build_reports(stack, FakeDocker()))["kicad-10.0.6"]
    assert report["state"] == "enabled_image_missing"
    report = by_id(tools.build_reports(stack, FakeDocker(broken=True)))["kicad-10.0.6"]
    assert report["state"] == "enabled_unverified" and report["image_state"] == "docker_unavailable"


def test_unsupported_architecture_is_named(stack, monkeypatch):
    monkeypatch.setattr(tools, "host_architecture", lambda: "arm64")
    docker = FakeDocker(cached=[KICAD["image"]], arch="arm64")
    assert by_id(tools.build_reports(stack, docker))["kicad-10.0.6"]["state"] == (
        "unsupported_architecture"
    )
    with pytest.raises(tools.ToolError, match="linux/arm64"):
        tools.enable_tool(stack, "kicad-10.0.6", run=docker)
    assert tools.read_enabled(stack / "tools-enabled.json") == {}


def test_enable_requires_cached_image_and_explains_the_download(stack):
    docker = FakeDocker()
    with pytest.raises(tools.ToolError, match="809 MB") as info:
        tools.enable_tool(stack, "kicad-10.0.6", run=docker)
    assert "docker pull kicad/kicad" in str(info.value)
    assert tools.read_enabled(stack / "tools-enabled.json") == {}
    assert not [c for c in docker.calls if c[:2] == ["docker", "pull"]]


def test_enable_with_explicit_pull_then_disable_keeps_images_and_recipes(stack):
    docker = FakeDocker()
    tools.enable_tool(stack, "kicad-10.0.6", pull=True, run=docker)
    assert ["docker", "pull", KICAD["image"]] in docker.calls
    assert "kicad-10.0.6" in tools.read_enabled(stack / "tools-enabled.json")
    (stack / "recipes.json").write_text(json.dumps({"r1": recipe("r1", KICAD["image"])}))
    assert tools.disable_tool(stack, "kicad-10.0.6") is True
    assert tools.disable_tool(stack, "kicad-10.0.6") is False
    assert json.loads((stack / "recipes.json").read_text())["r1"]
    assert KICAD["image"] in docker.cached
    assert by_id(tools.build_reports(stack, docker))["kicad-10.0.6"]["approved_recipe_ids"] == [
        "r1"
    ]


def test_locally_built_tool_is_never_pulled(stack):
    with pytest.raises(tools.ToolError, match="built locally"):
        tools.enable_tool(stack, "avr-gcc-5.4.0", pull=True, run=FakeDocker())


def test_docker_unavailable_changes_nothing(stack):
    with pytest.raises(tools.ToolError, match="no change"):
        tools.enable_tool(stack, "kicad-10.0.6", run=FakeDocker(broken=True))
    with pytest.raises(tools.ToolError, match="Unknown tool"):
        tools.disable_tool(stack, "nope")


def test_cli_list_json_and_exit_codes(stack, capsys):
    docker = FakeDocker(cached=[KICAD["image"]])
    assert tools.main(["--stack-dir", str(stack), "list", "--json"], run=docker) == 0
    assert by_id(json.loads(capsys.readouterr().out))["kicad-10.0.6"]["state"] == "available"
    assert tools.main(["--stack-dir", str(stack), "enable", "kicad-10.0.6"], run=docker) == 0
    assert tools.main(["--stack-dir", str(stack), "list"], run=docker) == 0
    assert "[enabled]" in capsys.readouterr().out
    assert tools.main(["--stack-dir", str(stack), "enable", "bogus"], run=docker) == 1


def test_recipe_for_a_disabled_catalog_tool_is_unsupported(settings):
    settings.SPECMATE_APPROVED_RECIPES = {
        "r1": recipe("r1", KICAD["image"]),
        "own": recipe("own", "example.invalid/own@sha256:" + "2" * 64),
    }
    settings.SPECMATE_ENABLED_TOOLS = []
    with pytest.raises(ToolNotEnabled) as info:
        approved_recipe("r1")
    assert isinstance(info.value, Unsupported)
    assert approved_recipe("own").id == "own"  # images outside the catalog are not gated
    settings.SPECMATE_ENABLED_TOOLS = ["kicad-10.0.6"]
    assert approved_recipe("r1").id == "r1"
    settings.SPECMATE_ENABLED_TOOLS = None  # no gate configured
    assert approved_recipe("r1").id == "r1"


def test_settings_reads_enabled_tools_file(tmp_path):
    path = tmp_path / "tools-enabled.json"
    tools.write_enabled(path, {"kicad-10.0.6": {"image": KICAD["image"]}})
    assert sorted(tools.read_enabled(path)) == ["kicad-10.0.6"]
    path.write_text("not json")
    assert tools.read_enabled(path) == {}
    assert tools.read_enabled(Path(tmp_path / "absent.json")) == {}


def test_unpinned_local_tool_reports_not_pinned_and_cannot_be_enabled(stack):
    """An optional pack listed before any build: unknown sizes, no digest, never pulled."""
    slicer = next(t for t in tools.load_catalog() if t["id"] == "prusaslicer-2.5.0")
    assert slicer["image"] is None and slicer["source"] == "local-build"
    assert slicer["download_bytes"] is None and slicer["installed_bytes"] is None
    docker = FakeDocker()
    (stack / "recipes.json").write_text(
        json.dumps({"own": recipe("own", "specmate-slicer-check@sha256:" + "3" * 64)})
    )
    report = by_id(tools.build_reports(stack, docker))["prusaslicer-2.5.0"]
    assert report["state"] == report["image_state"] == "not_pinned"
    assert report["approved_recipe_ids"] == []
    assert not [c for c in docker.calls if c[-1] is None]
    with pytest.raises(tools.ToolError, match="no pinned image"):
        tools.enable_tool(stack, "prusaslicer-2.5.0", pull=True, run=docker)
    assert tools.read_enabled(stack / "tools-enabled.json") == {}
    assert tools.tool_for_image("specmate-slicer-check@sha256:" + "3" * 64) is None


def test_catalog_rejects_an_unpinned_registry_tool(tmp_path):
    entry = {**KICAD, "image": None}
    path = tmp_path / "catalog.json"
    path.write_text(json.dumps({"format_version": 1, "tools": [entry]}))
    with pytest.raises(tools.ToolError):
        tools.load_catalog(path)
