
import frappe
from frappe import _
from frappe.utils import flt, getdate


# ============================================================
# ITEM / BARCODE HELPERS
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


def _get_batch_qty_rows(item_code, warehouse):
    """Return positive available quantities using ERPNext's batch stock API."""
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
        # Some versions return a mapping of batch number to quantity.
        for batch_no, qty in result.items():
            if isinstance(qty, dict):
                batch_no = qty.get("batch_no") or batch_no
                qty = qty.get("qty", qty.get("actual_qty", 0))
            rows.append({"batch_no": batch_no, "qty": flt(qty)})

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
                rows.append({"batch_no": batch_no, "qty": flt(qty)})

    output = []
    for row in rows:
        batch_no = row.get("batch_no")
        qty = flt(row.get("qty"))

        if not batch_no or qty <= 0:
            continue

        expiry_date = frappe.db.get_value(
            "Batch", batch_no, "expiry_date"
        )

        output.append({
            "batch_no": batch_no,
            "expiry_date": expiry_date,
            "qty": qty,
        })

    output.sort(
        key=lambda row: (
            row.get("expiry_date") is None,
            row.get("expiry_date") or "9999-12-31",
            row["batch_no"],
        )
    )
    return output


def _get_non_batch_available_qty(item_code, warehouse):
    if not warehouse:
        return 0

    bin_row = frappe.db.get_value(
        "Bin",
        {"item_code": item_code, "warehouse": warehouse},
        ["actual_qty", "reserved_qty"],
        as_dict=True,
    )

    if not bin_row:
        return 0

    return max(
        0,
        flt(bin_row.actual_qty) - flt(bin_row.reserved_qty),
    )


def _get_item_stock_info(item_code, warehouse):
    item = frappe.db.get_value(
        "Item",
        item_code,
        [
            "item_name",
            "has_batch_no",
            "has_serial_no",
            "has_variants",
            "disabled",
            "is_stock_item",
        ],
        as_dict=True,
    )

    if not item or item.disabled:
        return None

    if not item.is_stock_item:
        return {
            "item_code": item_code,
            "item_name": item.item_name,
            "has_batch_no": bool(item.has_batch_no),
            "available_qty": 0,
            "batches": [],
        }

    # Serial + batch tracking needs a separate serial/batch selection flow.
    if item.has_batch_no and item.has_serial_no:
        return {
            "item_code": item_code,
            "item_name": item.item_name,
            "has_batch_no": True,
            "unsupported_serial_batch": True,
            "available_qty": 0,
            "batches": [],
        }

    if item.has_batch_no:
        batches = _get_batch_qty_rows(item_code, warehouse)
        return {
            "item_code": item_code,
            "item_name": item.item_name,
            "has_batch_no": True,
            "available_qty": sum(flt(b["qty"]) for b in batches),
            "batches": batches,
        }

    qty = _get_non_batch_available_qty(item_code, warehouse)
    return {
        "item_code": item_code,
        "item_name": item.item_name,
        "has_batch_no": False,
        "available_qty": qty,
        "batches": [],
    }


# ============================================================
# WHITELISTED BARCODE LOOKUP
# ============================================================

@frappe.whitelist()
def scan_barcode_with_variants(barcode, warehouse=None):
    """Resolve a barcode and return its item or available template variants."""
    if not barcode:
        frappe.throw(_("Please scan a barcode."))

    item_code = _get_item_by_barcode(barcode)
    if not item_code:
        return {"found": False, "message": _("Barcode not found.")}

    item = frappe.db.get_value(
        "Item",
        item_code,
        ["has_variants", "disabled"],
        as_dict=True,
    )

    if not item or item.disabled:
        return {"found": False, "message": _("Item is disabled or unavailable.")}

    # If the scanned item is a template, present its variants.
    variants = frappe.get_all(
        "Item",
        filters={
            "variant_of": item_code,
            "disabled": 0,
        },
        fields=["name", "item_name"],
        order_by="item_name asc",
    )

    if variants:
        variant_rows = []
        for variant in variants:
            info = _get_item_stock_info(variant.name, warehouse)
            if info:
                variant_rows.append(info)

        return {
            "found": True,
            "is_template": True,
            "item_code": item_code,
            "variants": variant_rows,
        }

    info = _get_item_stock_info(item_code, warehouse)
    if not info:
        return {"found": False, "message": _("Item is unavailable.")}

    return {"found": True, "is_template": False, "item": info}


# ============================================================
# WHITELISTED AVAILABLE BATCHES
# ============================================================

@frappe.whitelist()
def get_available_batches(item_code, warehouse):
    if not item_code or not warehouse:
        return []

    if not frappe.db.exists("Item", item_code):
        return []

    item = frappe.db.get_value(
        "Item",
        item_code,
        ["has_batch_no", "has_serial_no", "disabled"],
        as_dict=True,
    )

    if not item or item.disabled or not item.has_batch_no:
        return []

    if item.has_serial_no:
        return []

    return _get_batch_qty_rows(item_code, warehouse)


# ============================================================
# WHITELISTED BATCH-SPECIFIC ITEM PRICE LOOKUP
# Item Price.batch_no -> Quotation Item.custom_batch_no
# ============================================================

@frappe.whitelist()
def get_batch_item_price(
    item_code,
    batch_no,
    price_list,
    transaction_date=None,
    customer=None,
    uom=None,
):
    """Find the Item Price matching the exact selected batch."""
    if not item_code or not batch_no or not price_list:
        return {"found": False, "reason": "missing_required_value"}

    meta = frappe.get_meta("Item Price")

    if not meta.has_field("batch_no"):
        frappe.log_error(
            "Item Price has no batch_no field.",
            "Quotation Batch Price Lookup",
        )
        return {"found": False, "reason": "missing_batch_no_field"}

    conditions = [
        "item_code = %(item_code)s",
        "price_list = %(price_list)s",
        "batch_no = %(batch_no)s",
    ]

    values = {
        "item_code": item_code,
        "price_list": price_list,
        "batch_no": batch_no,
    }

    date_value = getdate(transaction_date) if transaction_date else getdate()

    if meta.has_field("valid_from"):
        conditions.append(
            "(valid_from IS NULL OR valid_from <= %(transaction_date)s)"
        )
        values["transaction_date"] = date_value

    if meta.has_field("valid_upto"):
        conditions.append(
            "(valid_upto IS NULL OR valid_upto >= %(transaction_date)s)"
        )
        values["transaction_date"] = date_value

    if meta.has_field("customer") and customer:
        conditions.append(
            "(customer = %(customer)s OR customer IS NULL OR customer = '')"
        )
        values["customer"] = customer

    if meta.has_field("uom") and uom:
        conditions.append(
            "(uom = %(uom)s OR uom IS NULL OR uom = '')"
        )
        values["uom"] = uom

    order_by = []
    if meta.has_field("customer") and customer:
        order_by.append(
            "CASE WHEN customer = %(customer)s THEN 0 ELSE 1 END"
        )
    if meta.has_field("uom") and uom:
        order_by.append(
            "CASE WHEN uom = %(uom)s THEN 0 ELSE 1 END"
        )
    order_by.append("modified DESC")

    query = """
        SELECT name, price_list_rate
        FROM `tabItem Price`
        WHERE {conditions}
        ORDER BY {order_by}
        LIMIT 1
    """.format(
        conditions=" AND ".join(conditions),
        order_by=", ".join(order_by),
    )

    rows = frappe.db.sql(query, values, as_dict=True)

    if not rows:
        return {"found": False, "reason": "no_exact_batch_price"}

    return {
        "found": True,
        "item_price": rows[0].name,
        "rate": flt(rows[0].price_list_rate),
        "batch_no": batch_no,
    }
