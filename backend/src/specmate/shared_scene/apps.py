from django.apps import AppConfig


class SharedSceneConfig(AppConfig):
    name = "specmate.shared_scene"
    label = "shared_scene"

    def ready(self):
        from specmate.assemblies.contracts import ReadAssembly
        from specmate.contracts import SCHEMAS
        from specmate.shared_scene import (
            drawing_operations,  # noqa: F401
            operations,  # noqa: F401
        )
        from specmate.shared_scene.drawing_contracts import (
            CreateDrawing,
            ReadDrawing,
            ReadDrawingScene,
        )
        from specmate.shared_scene.operations import ListScenes

        SCHEMAS["shared-scene-list"] = ListScenes
        SCHEMAS["shared-scene-read"] = ReadAssembly
        SCHEMAS["shared-scene-preview-captured"] = ReadAssembly
        SCHEMAS["shared-scene-create-drawing"] = CreateDrawing
        SCHEMAS["shared-scene-read-drawing"] = ReadDrawing
        SCHEMAS["shared-scene-read-drawing-scene"] = ReadDrawingScene
