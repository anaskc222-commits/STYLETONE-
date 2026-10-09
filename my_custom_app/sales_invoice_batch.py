
import frappe
from frappe import _
from frappe.utils import flt, cint


def _get_available_batches(item_code, warehouse):
    """Return only batches with positive available quantity."""
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
        qty = flt(batch.get("qty", batch.get("batch_qty", 0)))

        if qty <= 0:
            continue

        batch_no = batch.get("batch_no") or batch.get("name")
        if not batch_no:
            continue

        expiry_date = frappe.db.get_value(
            "Batch", batch_no, "expiry_date"
        )

        batches.append({
            "name": batch_no,
            "batch_no": batch_no,
            "expiry_date": expiry_date,
            "available_qty": qty,
            "qty": qty,
        })

    return batches


def _get_non_batch_available_qty(item_code, warehouse):
    """Calculate available stock for a non-batch item."""
    bin_data = frappe.db.get_value(
        "Bin",
        {"item_code": item_code, "warehouse": warehouse},
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
    """Return stock and batch-tracking details for one item."""
    item = frappe.db.get_value(
        "Item",
        item_code,
        ["name", "item_name", "has_batch_no", "disabled", "is_stock_item"],
        as_dict=True,
    )

    if not item or item.disabled or not item.is_stock_item:
        return None

    has_batch = cint(item.has_batch_no)

    if has_batch:
        batches = _get_available_batches(item_code, warehouse)
        available_qty = sum(flt(row["available_qty"]) for row in batches)
    else:
        batches = []
        available_qty = _get_non_batch_available_qty(
            item_code, warehouse
        )

    # Do not return variants without positive available stock.
    if available_qty <= 0:
        return None

    return {
        "item_code": item.name,
        "item_name": item.item_name,
        "has_batch_no": has_batch,
        "available_qty": available_qty,
        "has_stock": True,
    }


@frappe.whitelist()
def get_available_batches(item_code, warehouse):
    """Public endpoint used by the Quotation batch popup."""
    if not item_code or not warehouse:
        return []

    item = frappe.db.get_value(
        "Item", item_code, ["has_batch_no", "disabled"], as_dict=True
    )

    if not item or item.disabled or not cint(item.has_batch_no):
        return []

    return _get_available_batches(item_code, warehouse)


@frappe.whitelist()
def scan_barcode_with_variants(barcode, warehouse):
    """
    Resolve a barcode and return only items/variants with available stock
    in the selected Quotation warehouse.
    """
    if not barcode:
        frappe.throw(_("Please scan or enter a barcode."))

    if not warehouse:
        frappe.throw(_("Please select the Quotation warehouse first."))

    barcode = str(barcode).strip()

    # Resolve barcode against ERPNext's Item Barcode child table.
    item_code = frappe.db.get_value(
        "Item Barcode",
        {"barcode": barcode},
        "parent",
    )

    # Some setups may store the scanned value directly as an Item Code.
    if not item_code and frappe.db.exists("Item", barcode):
        item_code = barcode

    if not item_code:
        frappe.throw(_("No item was found for barcode {0}.").format(barcode))

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
        ],
        as_dict=True,
    )

    if not item or item.disabled:
        return {"item_code": item_code, "variants": []}

    # A template barcode must return stock-available variants only.
    if item.is_template or item.has_variants:
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
            stock_info = _get_item_stock_info(variant_code, warehouse)

            if stock_info:
                variants.append(stock_info)

        return {
            "is_template": True,
            "item_code": item_code,
            "item_name": item.item_name,
            "variants": variants,
        }

    # Normal item barcode: return the item only when it has stock.
    stock_info = _get_item_stock_info(item_code, warehouse)

    if not stock_info:
        return {
            "is_template": False,
            "item_code": item_code,
            "item_name": item.item_name,
            "has_batch_no": cint(item.has_batch_no),
            "available_qty": 0,
            "variants": [],
            "no_stock": True,
        }

    return {
        "is_template": False,
        **stock_info,
        "variants": [],
    }
