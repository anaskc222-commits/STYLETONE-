import frappe
from frappe.utils import flt


# ==============================================================
# AVAILABLE BATCHES
# ==============================================================

@frappe.whitelist()
def get_available_batches(item_code, warehouse=None):
    """
    Return positive-stock batches for an item in a warehouse.

    Returns:
        batch_no
        expiry_date
    """

    if not item_code or not warehouse:
        return []

    item = frappe.get_cached_value(
        "Item",
        item_code,
        ["has_batch_no", "has_serial_no"],
        as_dict=True,
    )

    if not item:
        return []

    # Batch-controlled items only
    if not item.has_batch_no:
        return []

    # Serial + batch combination is left to ERPNext
    if item.has_serial_no:
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

        if not batch_no or qty <= 0:
            continue

        expiry_date = frappe.db.get_value(
            "Batch",
            batch_no,
            "expiry_date",
        )

        result.append(
            {
                "batch_no": batch_no,
                "expiry_date": expiry_date,
            }
        )

    return result


# ==============================================================
# BARCODE / TEMPLATE / VARIANT LOOKUP
# ==============================================================

@frappe.whitelist()
def scan_barcode_with_variants(search_value, ctx=None):
    """
    Custom barcode lookup used only to detect whether the scanned
    barcode belongs to:

        1. A normal Item
        2. An Item Variant
        3. An Item Template with multiple Variants

    The client-side code subsequently uses ERPNext's normal
    barcode/item processing.
    """

    if not search_value:
        return {}

    barcode_data = frappe.db.get_value(
        "Item Barcode",
        {"barcode": search_value},
        [
            "barcode",
            "parent as item_code",
            "uom",
        ],
        as_dict=True,
    )

    if not barcode_data:
        return {}

    item_code = barcode_data.item_code

    if not item_code:
        return {}

    item = frappe.get_cached_value(
        "Item",
        item_code,
        [
            "item_name",
            "variant_of",
            "has_variants",
            "has_batch_no",
            "has_serial_no",
            "disabled",
        ],
        as_dict=True,
    )

    if not item or item.disabled:
        return {}

    # ----------------------------------------------------------
    # Actual Variant
    # ----------------------------------------------------------

    if item.variant_of:
        return {
            "barcode": barcode_data.barcode,
            "item_code": item_code,
            "uom": barcode_data.uom,
            "item_name": item.item_name,
            "has_batch_no": item.has_batch_no,
            "has_serial_no": item.has_serial_no,
            "is_variant": 1,
            "has_variants": 0,
            "variants": [],
        }

    # ----------------------------------------------------------
    # Normal Item
    # ----------------------------------------------------------

    if not item.has_variants:
        return {
            "barcode": barcode_data.barcode,
            "item_code": item_code,
            "uom": barcode_data.uom,
            "item_name": item.item_name,
            "has_batch_no": item.has_batch_no,
            "has_serial_no": item.has_serial_no,
            "is_variant": 0,
            "has_variants": 0,
            "variants": [],
        }

    # ----------------------------------------------------------
    # Template
    # ----------------------------------------------------------

    variants = frappe.get_all(
        "Item",
        filters={
            "variant_of": item_code,
            "disabled": 0,
        },
        fields=[
            "name as item_code",
            "item_name",
            "has_batch_no",
            "has_serial_no",
        ],
        order_by="name asc",
    )

    return {
        "barcode": barcode_data.barcode,
        "item_code": item_code,
        "uom": barcode_data.uom,
        "item_name": item.item_name,
        "has_batch_no": item.has_batch_no,
        "has_serial_no": item.has_serial_no,
        "is_variant": 0,
        "has_variants": 1,
        "variants": variants,
    }
