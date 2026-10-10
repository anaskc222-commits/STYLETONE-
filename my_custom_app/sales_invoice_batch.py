
import frappe
from frappe import _
from frappe.utils import flt


# ============================================================
# BARCODE LOOKUP HELPERS
# ============================================================

def _get_item_by_barcode(barcode):
    """Find an item using its barcode or exact item code."""

    if not barcode:
        return None

    barcode = str(barcode).strip()
    if not barcode:
        return None

    # First: ERPNext Item Barcode child table.
    barcode_rows = frappe.get_all(
        "Item Barcode",
        filters={"barcode": barcode, "parenttype": "Item"},
        fields=["parent", "uom"],
        limit=2,
    )

    if barcode_rows:
        item_code = barcode_rows[0].get("parent")
        item = frappe.db.get_value(
            "Item",
            item_code,
            [
                "name",
                "item_name",
                "stock_uom",
                "has_batch_no",
                "has_serial_no",
                "is_stock_item",
                "disabled",
                "has_variants",
                "variant_of",
            ],
            as_dict=True,
        )

        if item and not item.disabled:
            item["barcode_uom"] = barcode_rows[0].get("uom")
            return item

    # Second: legacy Item.barcode field.
    item_code = frappe.db.get_value(
        "Item",
        {"barcode": barcode, "disabled": 0},
        "name",
    )

    if item_code:
        item = frappe.db.get_value(
            "Item",
            item_code,
            [
                "name",
                "item_name",
                "stock_uom",
                "has_batch_no",
                "has_serial_no",
                "is_stock_item",
                "disabled",
                "has_variants",
                "variant_of",
            ],
            as_dict=True,
        )

        if item:
            item["barcode_uom"] = None
            return item

    # Third: exact item code.
    item = frappe.db.get_value(
        "Item",
        {"name": barcode, "disabled": 0},
        [
            "name",
            "item_name",
            "stock_uom",
            "has_batch_no",
            "has_serial_no",
            "is_stock_item",
            "disabled",
            "has_variants",
            "variant_of",
        ],
        as_dict=True,
    )

    if item:
        item["barcode_uom"] = None
        return item

    return None


def _format_item(item):
    """Return the item fields required by the scanner JavaScript."""

    return {
        "item_code": item.name,
        "item_name": item.item_name,
        "stock_uom": item.stock_uom,
        "has_batch_no": int(item.has_batch_no or 0),
        "has_serial_no": int(item.has_serial_no or 0),
        "is_stock_item": int(item.is_stock_item or 0),
        "is_variant": 1 if item.variant_of else 0,
        "has_variants": int(item.has_variants or 0),
        "variant_of": item.variant_of,
    }


# ============================================================
# BARCODE LOOKUP WITH TEMPLATE VARIANTS
# ============================================================

@frappe.whitelist()
def scan_barcode_with_variants(
    barcode=None,
    search_value=None,
    ctx=None,
    warehouse=None,
):
    """
    Resolve a barcode or item code.

    For an item template, return its variants so the client can
    display a variant-selection dialog before batch selection.

    This endpoint does not calculate selling prices and does not
    modify ERPNext core behavior.
    """

    search_value = barcode or search_value

    if not search_value:
        frappe.throw(_("Please provide a barcode or item code."))

    item = _get_item_by_barcode(search_value)

    if not item:
        return {
            "found": False,
            "barcode": str(search_value).strip(),
            "variants": [],
        }

    result = _format_item(item)
    result.update({
        "found": True,
        "barcode": str(search_value).strip(),
        "barcode_uom": item.get("barcode_uom"),
        "variants": [],
    })

    # If this is a template, return its active variants.
    if item.has_variants:
        variant_rows = frappe.get_all(
            "Item",
            filters={
                "variant_of": item.name,
                "disabled": 0,
            },
            fields=[
                "name",
                "item_name",
                "stock_uom",
                "has_batch_no",
                "has_serial_no",
                "is_stock_item",
                "variant_of",
            ],
            order_by="item_name asc, name asc",
        )

        result["variants"] = [
            {
                "item_code": row.name,
                "item_name": row.item_name,
                "stock_uom": row.stock_uom,
                "has_batch_no": int(row.has_batch_no or 0),
                "has_serial_no": int(row.has_serial_no or 0),
                "is_stock_item": int(row.is_stock_item or 0),
                "is_variant": 1,
                "variant_of": row.variant_of,
            }
            for row in variant_rows
        ]

    return result


# ============================================================
# WAREHOUSE-SPECIFIC BATCH STOCK
# ============================================================

def _get_batch_qty_rows(item_code, warehouse):
    """
    Return positive available quantities for an item in one warehouse.

    IMPORTANT:
    get_batch_qty() receives item_code and warehouse by keyword.
    Do not pass item_code as the first positional argument because
    the first argument is batch_no in ERPNext v16.
    """

    if not item_code or not warehouse:
        return []

    from erpnext.stock.doctype.batch.batch import get_batch_qty

    rows = get_batch_qty(
        item_code=item_code,
        warehouse=warehouse,
        for_stock_levels=True,
        consider_negative_batches=False,
        ignore_reserved_stock=False,
    )

    output = []

    for row in rows or []:
        if not isinstance(row, dict):
            continue

        batch_no = row.get("batch_no")
        qty = flt(row.get("qty", row.get("batch_qty", 0)))

        if not batch_no or qty <= 0:
            continue

        batch = frappe.db.get_value(
            "Batch",
            batch_no,
            ["expiry_date", "disabled", "item"],
            as_dict=True,
        )

        if not batch:
            continue

        if batch.disabled:
            continue

        if batch.item != item_code:
            continue

        output.append({
            "batch_no": batch_no,
            "expiry_date": batch.expiry_date,
            "qty": qty,
        })

    # Display batches with known expiry dates first.
    output.sort(
        key=lambda row: (
            row["expiry_date"] is None,
            str(row["expiry_date"] or "9999-12-31"),
            row["batch_no"],
        )
    )

    return output


# ============================================================
# AVAILABLE BATCHES FOR SALES INVOICE
# ============================================================

@frappe.whitelist()
def get_available_batches(item_code, warehouse=None):
    """
    Return positive-quantity batches for the selected warehouse.

    Only batch-tracked stock items are eligible.
    Serial-and-batch-tracked items are excluded from this
    batch-only popup because they require serial-number handling.
    """

    if not item_code:
        return []

    if not warehouse:
        return []

    item = frappe.db.get_value(
        "Item",
        item_code,
        [
            "name",
            "has_batch_no",
            "has_serial_no",
            "is_stock_item",
            "disabled",
        ],
        as_dict=True,
    )

    if not item or item.disabled:
        return []

    if not item.is_stock_item:
        return []

    if not item.has_batch_no:
        return []

    if item.has_serial_no:
        return []

    return _get_batch_qty_rows(
        item_code=item_code,
        warehouse=warehouse,
    )
