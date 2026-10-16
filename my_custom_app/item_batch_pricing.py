
import frappe
from frappe import _
from frappe.utils import flt


@frappe.whitelist()
def get_default_batch_pricing_warehouse():
    """Get the logged-in user's default POS Profile warehouse."""

    user = frappe.session.user

    # 1. Find the user's default POS Profile.
    if frappe.db.exists("DocType", "POS Profile User"):
        profile_users = frappe.get_all(
            "POS Profile User",
            filters={"user": user, "default": 1},
            fields=["parent"],
            order_by="modified desc",
            limit_page_length=0,
        )

        for row in profile_users:
            profile = frappe.db.get_value(
                "POS Profile",
                row.parent,
                ["warehouse", "disabled"],
                as_dict=True,
            )

            if (
                profile
                and not profile.disabled
                and profile.warehouse
                and frappe.db.exists("Warehouse", profile.warehouse)
            ):
                return profile.warehouse

    # 2. Fall back to a default Warehouse User Permission.
    permissions = frappe.get_all(
        "User Permission",
        filters={
            "user": user,
            "allow": "Warehouse",
            "is_default": 1,
        },
        fields=["for_value"],
        limit_page_length=0,
    )

    for permission in permissions:
        warehouse = permission.for_value
        if warehouse and frappe.db.exists("Warehouse", warehouse):
            return warehouse

    return None


@frappe.whitelist()
def get_batch_pricing_warehouses():
    """List warehouses the current user can access."""

    if not frappe.has_permission("Warehouse", "read"):
        frappe.throw(
            _("You do not have permission to read Warehouses."),
            frappe.PermissionError,
        )

    return frappe.get_list(
        "Warehouse",
        filters={"is_group": 0, "disabled": 0},
        fields=["name"],
        order_by="name asc",
        limit_page_length=0,
    )


@frappe.whitelist()
def get_batch_pricing(item_code, warehouse=None):
    """Get batch expiry, warehouse quantity and Item Price rates."""

    if not item_code:
        frappe.throw(_("Item Code is required."))

    if not frappe.has_permission("Item", "read"):
        frappe.throw(
            _("You do not have permission to read Items."),
            frappe.PermissionError,
        )

    if not frappe.db.exists("Item", item_code):
        frappe.throw(_("Item does not exist."))

    item = frappe.get_doc("Item", item_code)

    if not item.has_batch_no:
        return {
            "batches": [],
            "message": "This item is not batch-tracked.",
        }

    if warehouse:
        if not frappe.db.exists(
            "Warehouse", {"name": warehouse, "is_group": 0, "disabled": 0}
        ):
            frappe.throw(_("Please select a valid active warehouse."))

        if not frappe.has_permission("Warehouse", "read"):
            frappe.throw(
                _("You do not have permission to read Warehouses."),
                frappe.PermissionError,
            )

    batches = frappe.get_all(
        "Batch",
        filters={"item": item_code},
        fields=["name", "expiry_date"],
        order_by="expiry_date asc, name asc",
        limit_page_length=0,
    )

    price_fields = ["price_list", "price_list_rate"]

    if frappe.get_meta("Item Price").has_field("batch_no"):
        price_fields.append("batch_no")

    prices = frappe.get_all(
        "Item Price",
        filters={
            "item_code": item_code,
            "price_list": ["!=", "Standard Buying"],
        },
        fields=price_fields,
        order_by="price_list asc",
        limit_page_length=0,
    )

    from erpnext.stock.doctype.batch.batch import get_batch_qty

    result = []

    for batch in batches:
        qty = None

        if warehouse:
            qty = flt(
                get_batch_qty(
                    batch_no=batch.name,
                    warehouse=warehouse,
                    item_code=item_code,
                )
            )

        batch_prices = []

        for price in prices:
            # If Item Price has batch_no, show batch-specific rates
            # and general rates without a batch number.
            if (
                price.get("batch_no")
                and price.get("batch_no") != batch.name
            ):
                continue

            batch_prices.append(
                {
                    "price_list": price.price_list,
                    "rate": flt(price.price_list_rate),
                }
            )

        # Keep every batch, including batches with zero stock.
        result.append(
            {
                "batch_no": batch.name,
                "expiry_date": batch.expiry_date,
                "qty": qty,
                "prices": batch_prices,
            }
        )

    return {
        "warehouse": warehouse,
        "batches": result,
    }
