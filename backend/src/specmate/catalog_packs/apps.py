from django.apps import AppConfig


class CatalogPacksConfig(AppConfig):
    name = "specmate.catalog_packs"
    label = "catalog_packs"

    def ready(self):
        from specmate.catalog_packs import operations  # noqa: F401
        from specmate.catalog_packs.contracts import (
            AdoptPack,
            DisablePack,
            InstallPack,
            PackManifest,
            PackResult,
            RegisterPackVersion,
            VersionResult,
        )
        from specmate.contracts import SCHEMAS

        SCHEMAS.update(
            {
                "catalog-pack-manifest": PackManifest,
                "catalog-pack-register": RegisterPackVersion,
                "catalog-pack-install": InstallPack,
                "catalog-pack-disable": DisablePack,
                "catalog-pack-adopt": AdoptPack,
                "catalog-pack-state": PackResult,
                "catalog-pack-version": VersionResult,
            }
        )
