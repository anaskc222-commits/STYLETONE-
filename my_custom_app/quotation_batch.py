
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
# AVAILABLE BATCHES
# ============================================================

def _get_available_batches(item_code, warehouse):
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
        qty = flt(batch.get("qty", batch.get("batch_qty", 0)))

        if not batch_no or qty <= 0:
            continue

        expiry_date = frappe.db.get_value(
            "Batch",
            batch_no,
            "expiry_date",
        )

        batches.append({
            "name": batch_no,
            "batch_no": batch_no,
            "expiry_date": expiry_date,
            "available_qty": qty,
            "qty": qty,
        })

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
# ITEM STOCK INFORMATION
# ============================================================

def _get_non_batch_available_qty(item_code, warehouse):
    if not item_code or not warehouse:
        return 0

    bin_data = frappe.db.get_value(
        "Bin",
        {
            "item_code": item_code,
            "warehouse": warehouse,
        },
        ["actual_qty", "reserved_qty"],
        as_dict=True,
    )

    if not bin_data:
        return 0

    return max(
        0,
        flt(bin_data.actual_qty) - flt(bin_data.reserved_qty),
    )


def _get_item_stock_info(item_code, warehouse):
    if not item_code or not warehouse:
        return None

    item = frappe.db.get_value(
        "Item",
        item_code,
        [
            "name",
            "item_name",
            "has_batch_no",
            "disabled",
            "is_stock_item",
        ],
        as_dict=True,
    )

    if not item:
        return None

    if cint(item.disabled) or not cint(item.is_stock_item):
        return None

    has_batch_no = cint(item.has_batch_no)

    if has_batch_no:
        batches = _get_available_batches(item_code, warehouse)
        available_qty = sum(
            flt(batch.get("available_qty"))
            for batch in batches
        )
    else:
        available_qty = _get_non_batch_available_qty(
            item_code,
            warehouse,
        )

    if available_qty <= 0:
        return None

    return {
        "item_code": item.name,
        "item_name": item.item_name,
        "has_batch_no": has_batch_no,
        "available_qty": available_qty,
        "has_stock": True,
    }


# ============================================================
# STANDARD QUOTATION BARCODE HANDLER
# ============================================================

@frappe.whitelist()
def scan_barcode_with_variants(barcode, warehouse=None):
    """
    Resolve the scanned value from the standard Quotation
    barcode field.

    Template barcode:
        Return only variants with positive available stock.

    Normal item barcode:
        Return item details only when positive stock exists.

    The JavaScript handles the variant/batch dialogs and then
    calls ERPNext's standard get_item_details method.
    """

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
            "message": _("No item was found for barcode {0}.").format(
                barcode
            ),
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
    # TEMPLATE BARCODE: FIND AVAILABLE VARIANTS
    # --------------------------------------------------------

    if cint(item.is_template) or cint(item.has_variants):
        variant_codes = frappe.get_all(
            "Item",
            filters={
                "variant_of": item_code,
                "disabled": 0,
                "is_stock_item": 1,
            },
            pluck="name",
            order_by="name asc",
        )

        variants = []

        for variant_code in variant_codes:
            stock_info = _get_item_stock_info(
                variant_code,
                warehouse,
            )

            if (
                stock_info
                and flt(stock_info.get("available_qty")) > 0
            ):
                variants.append(stock_info)

        return {
            "item_code": item_code,
            "item_name": item.item_name,
            "is_template": True,
            "has_batch_no": 0,
            "available_qty": sum(
                flt(variant.get("available_qty"))
                for variant in variants
            ),
            "variants": variants,
            "no_stock": not bool(variants),
        }

    # --------------------------------------------------------
    # NORMAL ITEM BARCODE
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

    return {
        **stock_info,
        "is_template": False,
        "variants": [],
        "no_stock": False,
    }
