import frappe
from frappe import _
from frappe.utils import flt, cint


# ============================================================
# BARCODE LOOKUP
# ============================================================

def _resolve_item_code(barcode):
    barcode = str(barcode or "").strip()

    if not barcode:
        return None

    item_code = frappe.db.get_value(
        "Item Barcode",
        {"barcode": barcode},
        "parent",
    )

    if not item_code and frappe.db.exists("Item", barcode):
        item_code = barcode

    return item_code


# ============================================================
# BULK BATCH EXPIRY LOOKUP
# ============================================================

def _get_expiry_dates(batch_numbers):
    batch_numbers = list(set(
        batch_no for batch_no in batch_numbers if batch_no
    ))

    if not batch_numbers:
        return {}

    rows = frappe.get_all(
        "Batch",
        filters={"name": ["in", batch_numbers]},
        fields=["name", "expiry_date"],
    )

    return {
        row.name: row.expiry_date
        for row in rows
    }


# ============================================================
# BATCH QUANTITY
# ============================================================

def _get_batch_quantities(item_code, warehouse):
    if not item_code or not warehouse:
        return []

    from erpnext.stock.doctype.batch.batch import get_batch_qty

    result = get_batch_qty(
        item_code=item_code,
        warehouse=warehouse,
        for_stock_levels=True,
        consider_negative_batches=False,
        ignore_reserved_stock=False,
    )

    batches = []

    for batch in result or []:
        batch_no = batch.get("batch_no") or batch.get("name")
        qty = flt(
            batch.get("qty", batch.get("batch_qty", 0))
        )

        if not batch_no or qty <= 0:
            continue

        batches.append({
            "name": batch_no,
            "batch_no": batch_no,
            "available_qty": qty,
            "qty": qty,
        })

    return batches


def _attach_batch_expiry(batches, expiry_dates):
    for batch in batches:
        batch["expiry_date"] = expiry_dates.get(
            batch["batch_no"]
        )

    return batches


def _get_available_batches(item_code, warehouse):
    batches = _get_batch_quantities(item_code, warehouse)

    if batches:
        expiry_dates = _get_expiry_dates([
            batch["batch_no"] for batch in batches
        ])
        _attach_batch_expiry(batches, expiry_dates)

    return batches


@frappe.whitelist()
def get_available_batches(item_code=None, warehouse=None):
    """Return positive-quantity batches for a Quotation item."""

    if not item_code or not warehouse:
        return []

    item = frappe.db.get_value(
        "Item",
        item_code,
        ["has_batch_no", "disabled", "is_stock_item"],
        as_dict=True,
    )

    if not item:
        return []

    if cint(item.disabled) or not cint(item.is_stock_item):
        return []

    if not cint(item.has_batch_no):
        return []

    return _get_available_batches(item_code, warehouse)


# ============================================================
# BULK STOCK INFORMATION
# ============================================================

def _get_non_batch_quantities(item_codes, warehouse):
    if not item_codes or not warehouse:
        return {}

    rows = frappe.get_all(
        "Bin",
        filters={
            "item_code": ["in", list(item_codes)],
            "warehouse": warehouse,
        },
        fields=[
            "item_code",
            "actual_qty",
            "reserved_qty",
        ],
    )

    return {
        row.item_code: max(
            0,
            flt(row.actual_qty) - flt(row.reserved_qty),
        )
        for row in rows
    }


def _get_items_stock_info(item_codes, warehouse):
    """
    Fetch item details and non-batch stock in bulk.
    Batch quantities still use ERPNext's batch calculation.
    """

    if not item_codes or not warehouse:
        return {}

    item_codes = list(dict.fromkeys(item_codes))

    items = frappe.get_all(
        "Item",
        filters={"name": ["in", item_codes]},
        fields=[
            "name",
            "item_name",
            "variant_of",
            "has_batch_no",
            "has_serial_no",
            "disabled",
            "is_stock_item",
        ],
    )

    valid_items = {
        item.name: item
        for item in items
        if not cint(item.disabled)
        and cint(item.is_stock_item)
        and not (
            cint(item.has_serial_no)
            and cint(item.has_batch_no)
        )
    }

    non_batch_codes = [
        code
        for code, item in valid_items.items()
        if not cint(item.has_batch_no)
    ]

    non_batch_qty = _get_non_batch_quantities(
        non_batch_codes,
        warehouse,
    )

    result = {}
    all_batch_rows = []

    for code, item in valid_items.items():
        if cint(item.has_batch_no):
            batches = _get_batch_quantities(
                code,
                warehouse,
            )

            available_qty = sum(
                flt(batch["available_qty"])
                for batch in batches
            )

            all_batch_rows.extend(batches)
        else:
            batches = []
            available_qty = non_batch_qty.get(code, 0)

        if available_qty <= 0:
            continue

        result[code] = {
            "item_code": code,
            "item_name": item.item_name,
            "variant_of": item.variant_of,
            "has_batch_no": cint(item.has_batch_no),
            "available_qty": available_qty,
            "has_stock": True,
            "batches": batches,
        }

    # One expiry-date query for batches across all variants.
    expiry_dates = _get_expiry_dates([
        batch["batch_no"] for batch in all_batch_rows
    ])

    for stock_info in result.values():
        _attach_batch_expiry(
            stock_info["batches"],
            expiry_dates,
        )

    return result


def _get_item_stock_info(item_code, warehouse):
    stock_info = _get_items_stock_info(
        [item_code],
        warehouse,
    )

    return stock_info.get(item_code)


# ============================================================
# TEMPLATE / VARIANT IDENTIFICATION
# ============================================================

def _get_variant_codes(template_code):
    if not template_code:
        return []

    return frappe.get_all(
        "Item",
        filters={
            "variant_of": template_code,
            "disabled": 0,
            "is_stock_item": 1,
        },
        pluck="name",
        order_by="name asc",
    )


# ============================================================
# BARCODE SCANNER
# ============================================================

@frappe.whitelist()
def scan_barcode_with_variants(barcode, warehouse=None):
    barcode = str(barcode or "").strip()

    if not barcode:
        frappe.throw(_("Please scan a barcode."))

    if not warehouse:
        frappe.throw(
            _("Please select the Quotation warehouse first.")
        )

    item_code = _resolve_item_code(barcode)

    if not item_code:
        return {
            "item_code": None,
            "item_name": None,
            "is_template": False,
            "has_batch_no": 0,
            "available_qty": 0,
            "variants": [],
            "no_stock": True,
            "message": _(
                "No item was found for barcode {0}."
            ).format(barcode),
        }

    item = frappe.db.get_value(
        "Item",
        item_code,
        [
            "name",
            "item_name",
            "is_template",
            "has_variants",
            "has_batch_no",
            "has_serial_no",
            "disabled",
            "is_stock_item",
        ],
        as_dict=True,
    )

    if not item:
        return {
            "item_code": item_code,
            "variants": [],
            "no_stock": True,
        }

    if cint(item.disabled) or not cint(item.is_stock_item):
        return {
            "item_code": item_code,
            "item_name": item.item_name,
            "is_template": bool(item.is_template),
            "has_batch_no": cint(item.has_batch_no),
            "available_qty": 0,
            "variants": [],
            "no_stock": True,
        }

    # --------------------------------------------------------
    # TEMPLATE: FETCH VARIANTS AND THEIR STOCK
    # --------------------------------------------------------

    variant_codes = _get_variant_codes(item_code)

    is_template = bool(
        cint(item.is_template)
        or cint(item.has_variants)
        or variant_codes
    )

    if is_template:
        stock_info = _get_items_stock_info(
            variant_codes,
            warehouse,
        )

        variants = []

        for variant_code in variant_codes:
            info = stock_info.get(variant_code)

            if not info:
                continue

            # Keep the original variant response fields.
            variants.append({
                "item_code": info["item_code"],
                "item_name": info["item_name"],
                "variant_of": info["variant_of"],
                "has_batch_no": info["has_batch_no"],
                "available_qty": info["available_qty"],
                "has_stock": True,
            })

        return {
            "item_code": item_code,
            "item_name": item.item_name,
            "is_template": True,
            "has_batch_no": 0,
            "available_qty": sum(
                flt(row["available_qty"])
                for row in variants
            ),
            "variants": variants,
            "no_stock": not bool(variants),
        }

    # --------------------------------------------------------
    # NORMAL ITEM
    # --------------------------------------------------------

    stock_info = _get_item_stock_info(
        item_code,
        warehouse,
    )

    if not stock_info:
        return {
            "item_code": item_code,
            "item_name": item.item_name,
            "is_template": False,
            "has_batch_no": cint(item.has_batch_no),
            "available_qty": 0,
            "variants": [],
            "no_stock": True,
        }

    # Preserve the existing scanner response contract.
    stock_info.pop("batches", None)

    return {
        **stock_info,
        "is_template": False,
        "variants": [],
        "no_stock": False,
    }