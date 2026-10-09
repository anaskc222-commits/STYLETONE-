
import frappe
from frappe.utils import flt


# ==============================================================
# AVAILABLE BATCHES
# ==============================================================

@frappe.whitelist()
def get_available_batches(item_code, warehouse=None):
    """Return positive-stock batches for a batch-tracked item."""

    if not item_code or not warehouse:
        return []

    item = frappe.get_cached_value(
        "Item",
        item_code,
        ["has_batch_no", "has_serial_no"],
        as_dict=True,
    )

    if not item or not item.has_batch_no:
        return []

    # Let ERPNext handle serial-tracked items.
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

    result = []

    for row in batches or []:
        batch_no = row.get("batch_no")
        qty = flt(row.get("qty"))

        if not batch_no or qty <= 0:
            continue

        result.append({
            "batch_no": batch_no,
            "expiry_date": frappe.db.get_value(
                "Batch", batch_no, "expiry_date"
            ),
            "qty": qty,
        })

    return result


# ==============================================================
# BARCODE / TEMPLATE / VARIANT LOOKUP
# ==============================================================

@frappe.whitelist()
def scan_barcode_with_variants(search_value, ctx=None):
    """Identify a normal item, variant, or template barcode."""

    if not search_value:
        return {}

    barcode_data = frappe.db.get_value(
        "Item Barcode",
        {"barcode": search_value},
        ["barcode", "parent as item_code", "uom"],
        as_dict=True,
    )

    if not barcode_data or not barcode_data.item_code:
        return {}

    item_code = barcode_data.item_code

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

    base_data = {
        "barcode": barcode_data.barcode,
        "item_code": item_code,
        "uom": barcode_data.uom,
        "item_name": item.item_name,
        "has_batch_no": item.has_batch_no,
        "has_serial_no": item.has_serial_no,
    }

    # ----------------------------------------------------------
    # Actual variant
    # ----------------------------------------------------------

    if item.variant_of:
        return {
            **base_data,
            "is_variant": 1,
            "has_variants": 0,
            "variants": [],
        }

    # ----------------------------------------------------------
    # Normal item
    # ----------------------------------------------------------

    if not item.has_variants:
        return {
            **base_data,
            "is_variant": 0,
            "has_variants": 0,
            "variants": [],
        }

    # ----------------------------------------------------------
    # Template: return all enabled variants
    # Do not filter by batch tracking.
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
        **base_data,
        "is_variant": 0,
        "has_variants": 1,
        "variants": variants,
    }
