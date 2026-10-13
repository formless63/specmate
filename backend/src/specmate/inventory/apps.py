from django.apps import AppConfig


class InventoryConfig(AppConfig):
    name = "specmate.inventory"
    label = "inventory"

    def ready(self):
        from specmate.contracts import SCHEMAS
        from specmate.inventory import operations  # noqa: F401
        from specmate.inventory.contracts import AccountResult, Quantity, ReservationResult

        SCHEMAS.update(
            {
                "inventory-account": AccountResult,
                "inventory-quantity": Quantity,
                "inventory-reservation": ReservationResult,
            }
        )
