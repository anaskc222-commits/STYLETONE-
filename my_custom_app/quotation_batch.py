
import frappe
from frappe import _
from frappe.utils import cint, flt


# ============================================================
# BARCODE LOOKUP
# ============================================================

def _get_item_by_barcode(barcode):
    """Resolve an Item Barcode, Item Code, or exact Item name."""
    barcode = (barcode or "").strip()

    if not barcode:
        return None

    rows = frappe.get_all(
        "Item Barcode",
        filters={"barcode": barcode},
        fields=["parent"],
        limit=2,
    )

    if rows:
        item_codes = list(
            dict.fromkeys(
                row.parent for row in rows if row.parent
            )
        )

        if len(item_codes) > 1:
            frappe.throw(
                _("Barcode {0} is assigned to multiple items.").format(
                    barcode
                )
            )

        return item_codes[0] if item_codes else None

    return frappe.db.get_value("Item", barcode, "name")


# ============================================================
# BATCH STOCK HELPERS
# ============================================================

def _get_batch_qty_rows(item_code, warehouse):
    """Get positive batch quantities from ERPNext."""
    from erpnext.stock.doctype.batch.batch import get_batch_qty

    try:
        result = get_batch_qty(
            item_code=item_code,
            warehouse=warehouse,
            for_stock_levels=True,
            consider_negative_batches=False,
            ignore_reserved_stock=False,
        )
    except TypeError:
        result = get_batch_qty(item_code, warehouse)

    normalized = []

    if isinstance(result, dict):
        for batch_no, value in result.items():
            if isinstance(value, dict):
                name = (
                    value.get("batch_no")
                    or value.get("name")
                    or batch_no
                )
                qty = value.get("qty")

                if qty is None:
                    qty = value.get("available_qty")

                if qty is None:
                    qty = value.get("actual_qty", 0)
            else:
                name = batch_no
                qty = value

            if name:
                normalized.append({
                    "batch_no": str(name),
                    "qty": flt(qty),
                })

    elif isinstance(result, (list, tuple)):
        for row in result:
            if isinstance(row, dict):
                name = row.get("batch_no") or row.get("name")
                qty = row.get("qty")

                if qty is None:
                    qty = row.get("available_qty")

                if qty is None:
                    qty = row.get("actual_qty", 0)
            else:
                name = (
                    getattr(row, "batch_no", None)
                    or getattr(row, "name", None)
                )
                qty = getattr(row, "qty", 0)

            if name:
                normalized.append({
                    "batch_no": str(name),
                    "qty": flt(qty),
                })

    # Merge duplicate batch entries.
    merged = {}

    for row in normalized:
        batch_no = row["batch_no"]
        merged[batch_no] = (
            merged.get(batch_no, 0) + flt(row["qty"])
        )

    return [
        {
            "batch_no": batch_no,
            "qty": qty,
            "available_qty": qty,
        }
        for batch_no, qty in merged.items()
        if qty > 0
    ]


def _get_available_batches(item_code, warehouse):
    """Return positive-quantity batches with their expiry dates."""
    rows = _get_batch_qty_rows(item_code, warehouse)

    if not rows:
        return []

    batch_names = [row["batch_no"] for row in rows]
    expiry_map = {}

    # Fetch expiry dates in chunks.
    for start in range(0, len(batch_names), 500):
        chunk = batch_names[start:start + 500]

        expiry_rows = frappe.get_all(
            "Batch",
            filters={"name": ["in", chunk]},
            fields=["name", "expiry_date"],
        )

        for expiry in expiry_rows:
            expiry_map[expiry.name] = expiry.expiry_date

    for row in rows:
        row["expiry_date"] = expiry_map.get(row["batch_no"])

    # Expiring batches first; batches without dates last.
    return sorted(
        rows,
        key=lambda row: (
            row["expiry_date"] is None,
            str(row["expiry_date"] or "9999-12-31"),
            row["batch_no"],
        ),
    )


# ============================================================
# NON-BATCH STOCK
# ============================================================

def _get_non_batch_available_qty(item_code, warehouse):
    """Estimate unreserved non-batch stock from Bin."""
    bin_row = frappe.db.get_value(
        "Bin",
        {
            "item_code": item_code,
            "warehouse": warehouse,
        },
        ["actual_qty", "reserved_qty"],
        as_dict=True,
    )

    if not bin_row:
        return 0.0

    return max(
        0.0,
        flt(bin_row.actual_qty) - flt(bin_row.reserved_qty),
    )


# ============================================================
# ITEM STOCK INFORMATION
# ============================================================

def _get_item_stock_info(item_code, warehouse):
    item = frappe.db.get_value(
        "Item",
        item_code,
        [
            "name",
            "item_name",
            "variant_of",
            "has_variants",
            "has_batch_no",
            "has_serial_no",
            "disabled",
            "is_stock_item",
        ],
        as_dict=True,
    )

    if not item:
        return None

    if cint(item.disabled) or not cint(item.is_stock_item):
        return None

    if cint(item.has_batch_no) and cint(item.has_serial_no):
        return {
            "item_code": item.name,
            "item_name": item.item_name,
            "has_batch_no": cint(item.has_batch_no),
            "has_serial_no": cint(item.has_serial_no),
            "qty": 0,
            "available_qty": 0,
            "unsupported_serial_batch": True,
        }

    if cint(item.has_batch_no):
        batches = _get_available_batches(item.name, warehouse)
        qty = sum(
            flt(batch["available_qty"])
            for batch in batches
        )
    else:
        batches = []
        qty = _get_non_batch_available_qty(
            item.name,
            warehouse,
        )

    return {
        "item_code": item.name,
        "item_name": item.item_name,
        "variant_of": item.variant_of,
        "has_batch_no": cint(item.has_batch_no),
        "has_serial_no": cint(item.has_serial_no),
        "qty": qty,
        "available_qty": qty,
        "batches": batches,
    }


# ============================================================
# PUBLIC API: AVAILABLE BATCHES
# ============================================================

@frappe.whitelist()
def get_available_batches(item_code, warehouse):
    """Return positive-quantity batches for the selected item."""
    item_code = (item_code or "").strip()
    warehouse = (warehouse or "").strip()

    if not item_code:
        frappe.throw(_("Item Code is required."))

    if not warehouse:
        frappe.throw(
            _("Select a Warehouse before selecting a batch.")
        )

    item = frappe.db.get_value(
        "Item",
        item_code,
        [
            "has_batch_no",
            "has_serial_no",
            "disabled",
            "is_stock_item",
        ],
        as_dict=True,
    )

    if not item:
        frappe.throw(
            _("Item {0} was not found.").format(item_code)
        )

    if cint(item.disabled):
        frappe.throw(
            _("Item {0} is disabled.").format(item_code)
        )

    if not cint(item.is_stock_item):
        frappe.throw(
            _("Item {0} is not a stock item.").format(item_code)
        )

    if not cint(item.has_batch_no):
        return []

    if cint(item.has_serial_no):
        frappe.throw(
            _(
                "Item {0} uses serial numbers and batches; "
                "this selector does not support serial selection."
            ).format(item_code)
        )

    return _get_available_batches(item_code, warehouse)


# ============================================================
# PUBLIC API: BARCODE AND VARIANT LOOKUP
# ============================================================

@frappe.whitelist()
def scan_barcode_with_variants(barcode, warehouse=None):
    """Resolve a barcode to a stocked item or stocked variants."""
    barcode = (barcode or "").strip()
    warehouse = (warehouse or "").strip()

    if not barcode:
        frappe.throw(_("Scan or enter a barcode."))

    if not warehouse:
        frappe.throw(
            _("Select the Warehouse before scanning.")
        )

    item_code = _get_item_by_barcode(barcode)

    if not item_code:
        frappe.throw(
            _("No Item was found for barcode {0}.").format(
                barcode
            )
        )

    scanned_item = frappe.db.get_value(
        "Item",
        item_code,
        [
            "name",
            "item_name",
            "has_variants",
            "variant_of",
            "disabled",
            "is_stock_item",
        ],
        as_dict=True,
    )

    if not scanned_item:
        frappe.throw(
            _("Item {0} was not found.").format(item_code)
        )

    if cint(scanned_item.disabled):
        frappe.throw(
            _("Item {0} is disabled.").format(item_code)
        )

    if not cint(scanned_item.is_stock_item) and not cint(
        scanned_item.has_variants
    ):
        frappe.throw(
            _("Item {0} is not a stock item.").format(item_code)
        )

    # Find actual child variants. Do not query a nonexistent
    # database field named "is_template".
    variant_codes = frappe.get_all(
        "Item",
        filters={
            "variant_of": scanned_item.name,
            "disabled": 0,
            "is_stock_item": 1,
        },
        pluck="name",
        order_by="name asc",
    )

    is_template = bool(
        cint(scanned_item.has_variants) or variant_codes
    )

    if is_template:
        variants = []

        for variant_code in variant_codes:
            info = _get_item_stock_info(
                variant_code,
                warehouse,
            )

            if not info:
                continue

            if info.get("unsupported_serial_batch"):
                continue

            if flt(info["available_qty"]) <= 0:
                continue

            variants.append({
                "item_code": info["item_code"],
                "item_name": (
                    info["item_name"] or info["item_code"]
                ),
                "has_batch_no": info["has_batch_no"],
                "qty": info["available_qty"],
                "available_qty": info["available_qty"],
            })

        return {
            "item_code": scanned_item.name,
            "item_name": (
                scanned_item.item_name or scanned_item.name
            ),
            "is_template": True,
            "variants": variants,
        }

    info = _get_item_stock_info(
        scanned_item.name,
        warehouse,
    )

    if not info:
        frappe.throw(
            _(
                "Item {0} is disabled or is not a stock item."
            ).format(item_code)
        )

    if info.get("unsupported_serial_batch"):
        frappe.throw(
            _(
                "Item {0} uses serial numbers and batches; "
                "this selector does not support serial selection."
            ).format(item_code)
        )

    if flt(info["available_qty"]) <= 0:
        frappe.throw(
            _(
                "No positive available stock for item {0} "
                "in warehouse {1}."
            ).format(item_code, warehouse)
        )

    return {
        "item_code": info["item_code"],
        "item_name": info["item_name"] or info["item_code"],
        "is_template": False,
        "has_batch_no": info["has_batch_no"],
        "qty": info["available_qty"],
        "available_qty": info["available_qty"],
    }
