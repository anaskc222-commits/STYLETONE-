
@frappe.whitelist()
def scan_barcode_with_variants(barcode=None, warehouse=None, search_value=None):
    """Resolve barcode or search value and return in-stock variants."""

    barcode = (barcode or search_value or "").strip()

    if not barcode:
        frappe.throw(_("Please scan or enter a barcode."))

    if not warehouse:
        frappe.throw(_("Please select the Quotation warehouse first."))

    item_code = frappe.db.get_value(
        "Item Barcode",
        {"barcode": barcode},
        "parent",
    )

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
        return {
            "item_code": item_code,
            "variants": [],
            "no_stock": True,
        }

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

            if stock_info and flt(stock_info.get("available_qty")) > 0:
                variants.append(stock_info)

        return {
            "is_template": True,
            "item_code": item_code,
            "item_name": item.item_name,
            "variants": variants,
            "no_stock": not bool(variants),
        }

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
