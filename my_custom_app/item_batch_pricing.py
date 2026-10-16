
import frappe
from frappe import _
from frappe.utils import flt


@frappe.whitelist()
def get_batch_pricing(item_code, warehouse=None):
    """Return all batches for an item, including zero-stock batches."""

    if not item_code:
        frappe.throw(_("Item Code is required."))

    if not frappe.has_permission("Item", "read"):
        frappe.throw(_("You do not have permission to read Items."), frappe.PermissionError)

    item = frappe.get_doc("Item", item_code)
    if not item.has_batch_no:
        return {"batches": [], "price_lists": [], "message": "This item is not batch-tracked."}

    if warehouse:
        if not frappe.db.exists("Warehouse", warehouse):
            frappe.throw(_("Invalid Warehouse."))

        if not frappe.has_permission("Warehouse", "read"):
            frappe.throw(_("You do not have permission to read Warehouses."), frappe.PermissionError)

    # Load all batches, not just batches with available stock.
    batches = frappe.get_all(
        "Batch",
        filters={"item": item_code},
        fields=["name", "expiry_date"],
        order_by="expiry_date asc, name asc",
        limit_page_length=0,
    )

    # Retrieve prices once, instead of querying once per batch.
    price_fields = ["price_list", "price_list_rate"]
    if frappe.get_meta("Item Price").has_field("batch_no"):
        price_fields.append("batch_no")

    price_filters = {
        "item_code": item_code,
        "price_list": ["!=", "Standard Buying"],
    }

    prices = frappe.get_all(
        "Item Price",
        filters=price_filters,
        fields=price_fields,
        order_by="price_list asc",
        limit_page_length=0,
    )

    # Calculate batch quantity using ERPNext's batch-stock helper.
    # This also supports newer versions using Serial and Batch Bundles.
    from erpnext.stock.doctype.batch.batch import get_batch_qty

    price_lists = sorted({p.price_list for p in prices if p.price_list})

    batch_rows = []
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

        matching_prices = [
            {
                "price_list": p.price_list,
                "rate": flt(p.price_list_rate),
            }
            for p in prices
            if not p.get("batch_no") or p.get("batch_no") == batch.name
        ]

        # Keep the batch visible even when qty is zero.
        batch_rows.append(
            {
                "batch_no": batch.name,
                "expiry_date": batch.expiry_date,
                "qty": qty,
                "prices": matching_prices,
            }
        )

    return {
        "batches": batch_rows,
        "price_lists": price_lists,
        "warehouse": warehouse,
    }


@frappe.whitelist()
def get_batch_pricing_warehouses():
    """Return warehouses available to the current user."""

    if not frappe.has_permission("Warehouse", "read"):
        frappe.throw(_("You do not have permission to read Warehouses."), frappe.PermissionError)

    return frappe.get_list(
        "Warehouse",
        filters={"is_group": 0},
        fields=["name"],
        order_by="name asc",
        limit_page_length=0,
    )
