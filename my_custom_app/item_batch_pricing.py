
import frappe
from frappe import _
from frappe.utils import flt


@frappe.whitelist()
def get_default_batch_pricing_warehouse():
    """Resolve the current user's default POS Profile warehouse."""

    user = frappe.session.user

    # Find default POS Profiles assigned to this user.
    profiles = frappe.get_all(
        "POS Profile User",
        filters={
            "parenttype": "POS Profile",
            "parentfield": "applicable_for_users",
            "user": user,
            "default": 1,
        },
        fields=["parent"],
        limit_page_length=0,
    )

    for row in profiles:
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
            and _warehouse_is_available(profile.warehouse)
        ):
            return profile.warehouse

    # Fallback: the user's default Warehouse User Permission.
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

    for row in permissions:
        if row.for_value and _warehouse_is_available(row.for_value):
            return row.for_value

    return None


def _warehouse_is_available(warehouse):
    """Check warehouse existence and the current user's read access."""

    return bool(
        frappe.get_list(
            "Warehouse",
            filters={
                "name": warehouse,
                "is_group": 0,
                "disabled": 0,
            },
            fields=["name"],
            limit_page_length=1,
        )
    )


@frappe.whitelist()
def get_batch_pricing_warehouses():
    """Return active, non-group warehouses visible to the current user."""

    return frappe.get_list(
        "Warehouse",
        filters={
            "is_group": 0,
            "disabled": 0,
        },
        fields=["name"],
        order_by="name asc",
        limit_page_length=0,
    )


@frappe.whitelist()
def get_batch_pricing(item_code, warehouse):
    """Return positive-stock batches and their price-list rates."""

    if not item_code:
        frappe.throw(_("Item Code is required."))

    if not warehouse:
        frappe.throw(_("Please select a warehouse."))

    if not frappe.has_permission("Item", "read"):
        frappe.throw(
            _("You do not have permission to read Items."),
            frappe.PermissionError,
        )

    if not frappe.db.exists("Item", item_code):
        frappe.throw(_("Item does not exist."))

    if not _warehouse_is_available(warehouse):
        frappe.throw(
            _("Warehouse is invalid or you do not have access to it."),
            frappe.PermissionError,
        )

    item = frappe.get_cached_doc("Item", item_code)

    if not item.has_batch_no:
        return {"batches": [], "message": "This item is not batch-tracked."}

    # One stock-helper call for the entire item/warehouse combination.
    # ERPNext returns batch-wise quantities when batch_no is omitted.
    from erpnext.stock.doctype.batch.batch import get_batch_qty

    stock_rows = get_batch_qty(
        item_code=item_code,
        warehouse=warehouse,
    )

    qty_by_batch = {}

    for row in stock_rows or []:
        batch_no = row.get("batch_no")
        if batch_no:
            qty_by_batch[batch_no] = (
                qty_by_batch.get(batch_no, 0) + flt(row.get("qty"))
            )

    # Do not fetch batch details for batches without positive stock.
    positive_batches = {
        batch_no: qty
        for batch_no, qty in qty_by_batch.items()
        if qty > 0
    }

    if not positive_batches:
        return {
            "batches": [],
            "warehouse": warehouse,
            "message": "No batches with available stock.",
        }

    batch_names = list(positive_batches.keys())

    batch_details = frappe.get_all(
        "Batch",
        filters={
            "name": ["in", batch_names],
            "item": item_code,
        },
        fields=["name", "expiry_date"],
        order_by="expiry_date asc, name asc",
        limit_page_length=0,
    )

    price_fields = ["price_list", "price_list_rate"]

    has_batch_price = frappe.get_meta("Item Price").has_field("batch_no")
    if has_batch_price:
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

    # Group prices once, avoiding a full price scan for every batch.
    general_prices = []
    prices_by_batch = {}

    for price in prices:
        price_row = {
            "price_list": price.price_list,
            "rate": flt(price.price_list_rate),
        }

        price_batch = price.get("batch_no") if has_batch_price else None

        if price_batch:
            prices_by_batch.setdefault(price_batch, []).append(price_row)
        else:
            general_prices.append(price_row)

    result = []

    for batch in batch_details:
        batch_prices = list(general_prices)
        batch_prices.extend(prices_by_batch.get(batch.name, []))

        result.append({
            "batch_no": batch.name,
            "expiry_date": batch.expiry_date,
            "qty": positive_batches.get(batch.name, 0),
            "prices": batch_prices,
        })

    return {
        "warehouse": warehouse,
        "batches": result,
    }
