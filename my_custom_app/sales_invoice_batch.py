import frappe
from frappe.utils import flt


@frappe.whitelist()
def get_available_batches(item_code, warehouse=None):
    """
    Return available batches for a Sales Invoice.
    """

    if not item_code:
        return []

    item = frappe.get_cached_value(
        "Item",
        item_code,
        ["has_batch_no", "has_serial_no"],
        as_dict=True,
    )

    if not item:
        return []

    if not item.has_batch_no:
        return []

    if item.has_serial_no:
        return []

    if not warehouse:
        return []

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

        expiry_date = frappe.db.get_value(
            "Batch",
            batch_no,
            "expiry_date",
        )

        result.append(
            {
                "batch_no": batch_no,
                "qty": qty,
                "expiry_date": expiry_date,
            }
        )

    return result