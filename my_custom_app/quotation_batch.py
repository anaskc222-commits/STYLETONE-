
import frappe


@frappe.whitelist()
def scan_barcode_with_variants(search_value):
    """Resolve a barcode to an item or an enabled variant list."""

    barcode = (search_value or "").strip()
    if not barcode:
        frappe.throw("Please scan or enter a barcode.")

    if not frappe.has_permission("Item", "read"):
        frappe.throw("You do not have permission to read Items.")

    barcode_data = frappe.db.get_value(
        "Item Barcode",
        {"barcode": barcode},
        ["parent", "uom"],
        as_dict=True,
    )

    if not barcode_data or not barcode_data.parent:
        frappe.throw(f"No item found for barcode: {barcode}")

    item_code = barcode_data.parent

    item = frappe.db.get_value(
        "Item",
        item_code,
        [
            "name",
            "item_name",
            "disabled",
            "has_variants",
            "variant_of",
            "has_batch_no",
            "stock_uom",
        ],
        as_dict=True,
    )

    if not item or item.disabled:
        frappe.throw(f"Item {item_code} is missing or disabled.")

    result = {
        "barcode": barcode,
        "barcode_uom": barcode_data.uom,
        "item_code": item.name,
        "item_name": item.item_name,
        "has_variants": item.has_variants,
        "variant_of": item.variant_of,
        "has_batch_no": item.has_batch_no,
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
                "stock_uom",
            ],
            order_by="name asc",
        )

        if not result["variants"]:
            frappe.throw(
                f"Item template {item.name} has no enabled variants."
            )

    return result


@frappe.whitelist()
def get_available_batches(item_code, warehouse):
    """
    Return batches with positive net Stock Ledger Entry quantity
    for this item and warehouse.

    This is a batch/warehouse stock check, not a stock reservation.
    """

    item_code = (item_code or "").strip()
    warehouse = (warehouse or "").strip()

    if not item_code or not warehouse:
        frappe.throw("Item and Warehouse are required.")

    if not frappe.has_permission("Item", "read"):
        frappe.throw("You do not have permission to read Items.")

    if not frappe.has_permission("Warehouse", "read"):
        frappe.throw("You do not have permission to read Warehouses.")

    if not frappe.has_permission("Batch", "read"):
        frappe.throw("You do not have permission to read Batches.")

    item = frappe.db.get_value(
        "Item",
        item_code,
        ["name", "disabled", "has_batch_no", "has_variants", "variant_of"],
        as_dict=True,
    )

    if not item or item.disabled:
        frappe.throw(f"Item {item_code} is missing or disabled.")

    if item.has_variants and not item.variant_of:
        frappe.throw("Select a concrete item variant first.")

    if not item.has_batch_no:
        return []

    if not frappe.db.exists("Warehouse", warehouse):
        frappe.throw(f"Warehouse {warehouse} does not exist.")

    # Stock Ledger Entry quantities are aggregated by batch and warehouse.
    # The field names must be supported by this ERPNext v16 database.
    batches = frappe.db.sql(
        """
        SELECT
            sle.batch_no AS name,
            batch.expiry_date,
            SUM(sle.actual_qty) AS available_qty
        FROM `tabStock Ledger Entry` sle
        INNER JOIN `tabBatch` batch
            ON batch.name = sle.batch_no
        WHERE
            sle.item_code = %(item_code)s
            AND sle.warehouse = %(warehouse)s
            AND sle.batch_no IS NOT NULL
            AND sle.batch_no != ''
            AND sle.is_cancelled = 0
            AND batch.disabled = 0
        GROUP BY
            sle.batch_no,
            batch.expiry_date
        HAVING SUM(sle.actual_qty) > 0
        ORDER BY
            batch.expiry_date IS NULL,
            batch.expiry_date ASC,
            sle.batch_no ASC
        """,
        {
            "item_code": item_code,
            "warehouse": warehouse,
        },
        as_dict=True,
    )

    return batches
