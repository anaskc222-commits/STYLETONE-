
import frappe
from frappe import _


@frappe.whitelist()
def scan_barcode_with_variants(search_value):
    """Resolve a barcode and return variant choices when needed."""

    barcode = (search_value or "").strip()

    if not barcode:
        frappe.throw(_("Please scan or enter a barcode."))

    if not frappe.has_permission("Item", "read"):
        frappe.throw(_("You do not have permission to read Items."))

    barcode_data = frappe.db.get_value(
        "Item Barcode",
        {"barcode": barcode},
        ["parent", "uom"],
        as_dict=True,
    )

    if not barcode_data or not barcode_data.parent:
        frappe.throw(_("No item found for barcode: {0}").format(barcode))

    item = frappe.get_cached_value(
        "Item",
        barcode_data.parent,
        [
            "name",
            "item_name",
            "disabled",
            "has_variants",
            "variant_of",
            "has_batch_no",
            "has_serial_no",
            "stock_uom",
        ],
        as_dict=True,
    )

    if not item or item.disabled:
        frappe.throw(_("The scanned item is missing or disabled."))

    if item.has_serial_no:
        frappe.throw(
            _("Serial-number-tracked items are not supported by this batch selector.")
        )

    result = {
        "barcode": barcode,
        "barcode_uom": barcode_data.uom,
        "item_code": item.name,
        "item_name": item.item_name,
        "has_variants": item.has_variants,
        "variant_of": item.variant_of,
        "has_batch_no": item.has_batch_no,
        "has_serial_no": item.has_serial_no,
        "stock_uom": item.stock_uom,
        "variants": [],
    }

    if item.has_variants and not item.variant_of:
        result["variants"] = frappe.get_all(
            "Item",
            filters={
                "variant_of": item.name,
                "disabled": 0,
            },
            fields=[
                "name as item_code",
                "item_name",
                "has_batch_no",
                "has_serial_no",
                "stock_uom",
            ],
            order_by="name asc",
            page_length=500,
        )

        if not result["variants"]:
            frappe.throw(
                _("No enabled variants found for template {0}.").format(item.name)
            )

    return result


@frappe.whitelist()
def get_available_batches(item_code, warehouse):
    """
    Return positive batch quantities for one item and warehouse.

    Uses ERPNext's batch quantity calculation instead of manually
    aggregating Stock Ledger Entries.
    """

    item_code = (item_code or "").strip()
    warehouse = (warehouse or "").strip()

    if not item_code or not warehouse:
        frappe.throw(_("Item and Warehouse are required."))

    if not frappe.has_permission("Item", "read"):
        frappe.throw(_("You do not have permission to read Items."))

    if not frappe.has_permission("Warehouse", "read"):
        frappe.throw(_("You do not have permission to read Warehouses."))

    if not frappe.has_permission("Batch", "read"):
        frappe.throw(_("You do not have permission to read Batches."))

    item = frappe.get_cached_value(
        "Item",
        item_code,
        [
            "disabled",
            "has_variants",
            "variant_of",
            "has_batch_no",
            "has_serial_no",
        ],
        as_dict=True,
    )

    if not item or item.disabled:
        frappe.throw(_("Item {0} is missing or disabled.").format(item_code))

    if item.has_variants and not item.variant_of:
        frappe.throw(_("Select a concrete item variant first."))

    if item.has_serial_no:
        frappe.throw(
            _("Serial-number-tracked items are not supported by this selector.")
        )

    if not item.has_batch_no:
        return []

    if not frappe.db.exists("Warehouse", warehouse):
        frappe.throw(_("Warehouse {0} does not exist.").format(warehouse))

    from erpnext.stock.doctype.batch.batch import get_batch_qty

    batch_rows = get_batch_qty(
        item_code=item_code,
        warehouse=warehouse,
        for_stock_levels=True,
        consider_negative_batches=False,
        ignore_reserved_stock=False,
    ) or []

    # Aggregate defensively in case the API returns multiple entries per batch.
    quantities = {}

    for row in batch_rows:
        batch_no = row.get("batch_no")
        qty = frappe.utils.flt(row.get("qty"))

        if batch_no:
            quantities[batch_no] = quantities.get(batch_no, 0) + qty

    positive_batch_nos = [
        batch_no
        for batch_no, qty in quantities.items()
        if qty > 0
    ]

    if not positive_batch_nos:
        return []

    # Fetch expiry details only for the batches returned by ERPNext's
    # stock calculation, not for every batch in the database.
    batch_details = frappe.get_all(
        "Batch",
        filters={
            "name": ["in", positive_batch_nos],
            "item": item_code,
            "disabled": 0,
        },
        fields=["name", "expiry_date"],
        page_length=len(positive_batch_nos),
    )

    expiry_by_batch = {
        row.name: row.expiry_date
        for row in batch_details
    }

    result = [
        {
            "name": batch_no,
            "expiry_date": expiry_by_batch.get(batch_no),
            "available_qty": qty,
        }
        for batch_no, qty in quantities.items()
        if qty > 0 and batch_no in expiry_by_batch
    ]

    result.sort(
        key=lambda row: (
            row["expiry_date"] is None,
            str(row["expiry_date"] or ""),
            row["name"],
        )
    )

    return result
