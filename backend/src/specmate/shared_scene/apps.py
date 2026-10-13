from django.apps import AppConfig


class SharedSceneConfig(AppConfig):
    name = "specmate.shared_scene"
    label = "shared_scene"

    def ready(self):
        from specmate.shared_scene import operations  # noqa: F401
