import frappe
from frappe.utils import flt


@frappe.whitelist()
def get_available_batches(item_code, warehouse=None):
    """
    Return batches with available quantity > 0.

    Used only by the normal ERPNext Sales Invoice
    custom batch selector.

    No FEFO.
    No automatic batch selection.
    """

    if not item_code:
        return []

    # ------------------------------------------------------------
    # ITEM
    # ------------------------------------------------------------

    item = frappe.get_cached_value(
        "Item",
        item_code,
        ["has_batch_no", "has_serial_no"],
        as_dict=True,
    )

    if not item:
        return []

    # Not a batch item.
    if not item.has_batch_no:
        return []

    # Let ERPNext handle serial + batch items.
    if item.has_serial_no:
        return []

    # ------------------------------------------------------------
    # WAREHOUSE IS REQUIRED FOR OUTWARD STOCK
    # ------------------------------------------------------------

    if not warehouse:
        return []

    # ------------------------------------------------------------
    # ERPNext'S OWN BATCH STOCK CALCULATION
    # ------------------------------------------------------------

    from erpnext.stock.doctype.batch.batch import get_batch_qty

    batches = get_batch_qty(
        item_code=item_code,
        warehouse=warehouse,
        for_stock_levels=True,
        consider_negative_batches=False,
        ignore_reserved_stock=False,
    )

    if not batches:
        return []

    result = []

    for row in batches:

        batch_no = row.get("batch_no")
        qty = flt(row.get("qty"))

        if not batch_no:
            continue

        if qty <= 0:
            continue

        result.append(
            {
                "batch_no": batch_no,
                "qty": qty,
            }
        )

    return result