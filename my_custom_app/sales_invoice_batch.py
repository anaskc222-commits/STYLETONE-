
import frappe
from frappe import _
from frappe.utils import flt


# ============================================================
# BARCODE LOOKUP
# ============================================================

def _get_item_by_barcode(barcode):
    barcode = (barcode or "").strip()

    if not barcode:
        return None

    rows = frappe.get_all(
        "Item Barcode",
        filters={"barcode": barcode},
        fields=["parent"],
        limit=1,
    )

    if rows:
        return rows[0].parent

    if frappe.db.exists("Item", barcode):
        return barcode

    return None


# ============================================================
# ITEM INFORMATION
# ============================================================

def _get_item_info(item_code):
    item = frappe.db.get_value(
        "Item",
        item_code,
        [
            "name",
            "item_name",
            "stock_uom",
            "has_batch_no",
            "has_serial_no",
            "has_variants",
            "variant_of",
            "disabled",
            "is_stock_item",
        ],
        as_dict=True,
    )

    if not item or item.disabled:
        return None

    return {
        "item_code": item.name,
        "item_name": item.item_name,
        "stock_uom": item.stock_uom,
        "has_batch_no": bool(item.has_batch_no),
        "has_serial_no": bool(item.has_serial_no),
        "has_variants": bool(item.has_variants),
        "variant_of": item.variant_of,
        "is_stock_item": bool(item.is_stock_item),
    }


# ============================================================
# AVAILABLE BATCHES
# Uses ERPNext's batch stock API.
# ============================================================

def _get_batch_qty_rows(item_code, warehouse):
    if not item_code or not warehouse:
        return []

    from erpnext.stock.doctype.batch.batch import get_batch_qty

    try:
        result = get_batch_qty(
            item_code,
            warehouse,
            for_stock_levels=True,
            consider_negative_batches=False,
            ignore_reserved_stock=False,
        )
    except TypeError:
        result = get_batch_qty(item_code, warehouse)

    rows = []

    if isinstance(result, dict):
        for batch_no, value in result.items():
            if isinstance(value, dict):
                batch_no = (
                    value.get("batch_no")
                    or value.get("name")
                    or batch_no
                )
                qty = value.get(
                    "qty",
                    value.get("actual_qty", value.get("batch_qty", 0)),
                )
            else:
                qty = value

            if batch_no:
                rows.append({
                    "batch_no": batch_no,
                    "qty": flt(qty),
                })

    elif isinstance(result, (list, tuple)):
        for entry in result:
            if isinstance(entry, dict):
                batch_no = entry.get("batch_no") or entry.get("name")
                qty = entry.get(
                    "qty",
                    entry.get("actual_qty", entry.get("batch_qty", 0)),
                )
            elif isinstance(entry, (list, tuple)) and len(entry) >= 2:
                batch_no, qty = entry[0], entry[1]
            else:
                continue

            if batch_no:
                rows.append({
                    "batch_no": batch_no,
                    "qty": flt(qty),
                })

    output = []

    for row in rows:
        batch_no = row["batch_no"]
        qty = flt(row["qty"])

        if qty <= 0:
            continue

        batch = frappe.db.get_value(
            "Batch",
            batch_no,
            ["expiry_date", "disabled", "item"],
            as_dict=True,
        )

        if not batch or batch.disabled:
            continue

        if batch.item != item_code:
            continue

        output.append({
            "batch_no": batch_no,
            "expiry_date": batch.expiry_date,
            "qty": qty,
        })

    output.sort(
        key=lambda row: (
            row["expiry_date"] is None,
            str(row["expiry_date"] or "9999-12-31"),
            row["batch_no"],
        )
    )

    return output


# ============================================================
# WHITELISTED BARCODE LOOKUP
# ============================================================

@frappe.whitelist()
def scan_barcode_with_variants(barcode, warehouse=None):
    barcode = (barcode or "").strip()

    if not barcode:
        return {
            "found": False,
            "message": _("Please scan a barcode."),
        }

    item_code = _get_item_by_barcode(barcode)

    if not item_code:
        return {
            "found": False,
            "message": _("Barcode not found."),
        }

    info = _get_item_info(item_code)

    if not info:
        return {
            "found": False,
            "message": _("Item is disabled or unavailable."),
        }

    # Item template: return concrete variants for selection.
    if info["has_variants"] and not info["variant_of"]:
        variants = frappe.get_all(
            "Item",
            filters={
                "variant_of": item_code,
                "disabled": 0,
            },
            fields=[
                "name",
                "item_name",
                "stock_uom",
                "has_batch_no",
                "has_serial_no",
            ],
            order_by="item_name asc",
        )

        return {
            "found": True,
            "has_variants": True,
            "item_code": item_code,
            "item_name": info["item_name"],
            "variants": [
                {
                    "item_code": row.name,
                    "item_name": row.item_name,
                    "stock_uom": row.stock_uom,
                    "has_batch_no": bool(row.has_batch_no),
                    "has_serial_no": bool(row.has_serial_no),
                }
                for row in variants
            ],
        }

    return {
        "found": True,
        "has_variants": False,
        "item": info,
    }


# ============================================================
# WHITELISTED AVAILABLE BATCHES
# ============================================================

@frappe.whitelist()
def get_available_batches(item_code, warehouse):
    if not item_code or not warehouse:
        return []

    info = _get_item_info(item_code)

    if not info or not info["has_batch_no"]:
        return []

    # Serial + batch items need a separate serial selection workflow.
    if info["has_serial_no"]:
        return []

    return _get_batch_qty_rows(item_code, warehouse)
