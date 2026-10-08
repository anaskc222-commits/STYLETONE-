import frappe
from frappe.utils import flt


# ==============================================================
# AVAILABLE BATCHES
# ==============================================================

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


# ==============================================================
# BARCODE + VARIANT SELECTION
# ==============================================================

@frappe.whitelist()
def scan_barcode_with_variants(search_value, ctx=None):
    """
    Resolve a barcode for Sales Invoice processing.

    Cases:

    1. Barcode belongs directly to a Variant.
    2. Barcode belongs to an Item Template.
    3. Barcode does not exist.
    """

    if not search_value:
        return {}

    # ----------------------------------------------------------
    # BARCODE LOOKUP
    # ----------------------------------------------------------

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

    # ----------------------------------------------------------
    # ITEM DETAILS
    # ----------------------------------------------------------

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

    if not item:
        return {}

    if item.disabled:
        return {}

    # ----------------------------------------------------------
    # VARIANT BARCODE
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
    # NORMAL NON-VARIANT ITEM
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
    # FIND ITEM VARIANTS
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
        order_by="item_code asc",
    )

    result_variants = []

    for variant in variants:
        result_variants.append(
            {
                "item_code": variant.item_code,
                "item_name": variant.item_name,
                "has_batch_no": variant.has_batch_no,
                "has_serial_no": variant.has_serial_no,
            }
        )

    # ----------------------------------------------------------
    # RETURN TEMPLATE + VARIANTS
    # ----------------------------------------------------------

    return {
        "barcode": barcode_data.barcode,
        "item_code": item_code,
        "uom": barcode_data.uom,
        "item_name": item.item_name,
        "has_batch_no": item.has_batch_no,
        "has_serial_no": item.has_serial_no,
        "is_variant": 0,
        "has_variants": 1,
        "variants": result_variants,
    }