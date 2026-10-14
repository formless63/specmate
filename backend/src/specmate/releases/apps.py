from django.apps import AppConfig


class ReleasesConfig(AppConfig):
    name = "specmate.releases"
    label = "releases"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.releases import operations, warnings  # noqa: F401
        from specmate.releases.contracts import (
            CreateRelease,
            ListReleases,
            ReleaseRef,
            ReleaseReview,
            WarnRelease,
            WithdrawWarning,
        )

        SCHEMAS.update(
            {
                "release-review-request": ReleaseReview,
                "release-create": CreateRelease,
                "release-ref": ReleaseRef,
                "release-list-query": ListReleases,
                "release-warn": WarnRelease,
                "release-withdraw-warning": WithdrawWarning,
            }
        )
