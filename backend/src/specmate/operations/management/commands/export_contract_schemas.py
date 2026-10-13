import json
from pathlib import Path

from django.core.management.base import BaseCommand

from specmate.contracts import SCHEMAS


def render(model) -> str:
    return json.dumps(model.model_json_schema(), indent=2, sort_keys=True) + "\n"


class Command(BaseCommand):
    help = "Write JSON Schema files generated from the authoritative Pydantic contracts."

    def add_arguments(self, parser):
        parser.add_argument("output", type=Path, help="Directory, e.g. ../contracts/schema")

    def handle(self, *args, output: Path, **options):
        output.mkdir(parents=True, exist_ok=True)
        for name, model in SCHEMAS.items():
            (output / f"{name}.json").write_text(render(model))
            self.stdout.write(f"wrote {name}.json")
