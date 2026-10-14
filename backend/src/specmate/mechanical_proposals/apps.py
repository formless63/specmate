from django.apps import AppConfig


class MechanicalProposalsConfig(AppConfig):
    name = "specmate.mechanical_proposals"
    label = "mechanical_proposals"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.mechanical_proposals import operations  # noqa: F401
        from specmate.mechanical_proposals.contracts import (
            BoardInputs,
            CreateProposal,
            DraftRef,
            ListProposals,
            RetainedRef,
            RetainProposal,
            UpdateProposal,
        )

        SCHEMAS["mechanical-proposal-create"] = CreateProposal
        SCHEMAS["mechanical-proposal-update"] = UpdateProposal
        SCHEMAS["mechanical-proposal-retain"] = RetainProposal
        SCHEMAS["mechanical-proposal-read"] = DraftRef
        SCHEMAS["mechanical-proposal-read-retained"] = RetainedRef
        SCHEMAS["mechanical-proposal-list"] = ListProposals
        SCHEMAS["mechanical-proposal-board-inputs"] = BoardInputs
