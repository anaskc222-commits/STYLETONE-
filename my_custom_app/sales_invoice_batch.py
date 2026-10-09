
import frappe


@frappe.whitelist()
def scan_barcode_with_variants(search_value, ctx=None):
    """Resolve a barcode to an item or return selectable template variants."""

    search_value = (search_value or "").strip()

    if not search_value:
        frappe.throw("Please scan or enter a barcode.")

    barcode_data = frappe.db.get_value(
        "Item Barcode",
        {"barcode": search_value},
        ["barcode", "parent", "uom"],
        as_dict=True,
    )

    if not barcode_data or not barcode_data.parent:
        frappe.throw(f"No item found for barcode: {search_value}")

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
            "has_serial_no",
            "stock_uom",
        ],
        as_dict=True,
    )

    if not item:
        frappe.throw(f"Item {item_code} does not exist.")

    if item.disabled:
        frappe.throw(f"Item {item_code} is disabled.")

    base_data = {
        "barcode": search_value,
        "barcode_uom": barcode_data.uom,
        "item_code": item.name,
        "item_name": item.item_name,
        "has_batch_no": item.has_batch_no,
        "has_serial_no": item.has_serial_no,
        "stock_uom": item.stock_uom,
    }

    # A concrete variant can be selected directly.
    if item.variant_of:
        return {
            **base_data,
            "is_variant": 1,
            "has_variants": 0,
            "variants": [],
        }

    # Never add an Item Template directly to the invoice.
    if item.has_variants:
        variants = frappe.get_all(
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
        )

        if not variants:
            frappe.throw(
                f"Item Template {item.name} has no enabled variants."
            )

        return {
            **base_data,
            "is_variant": 0,
            "has_variants": 1,
            "variants": variants,
        }

    return {
        **base_data,
        "is_variant": 0,
        "has_variants": 0,
        "variants": [],
    }
