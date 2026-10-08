import frappe
from frappe.utils import flt


# ================================================================
# BATCH SELECTION
# ================================================================

@frappe.whitelist()
def get_available_batches(item_code, warehouse=None):
    """
    Return available batches for an item.

    Returns:
        batch_no
        expiry_date

    Quantity is used only to remove zero/negative-stock batches.
    Quantity is NOT returned to the client.

    No FEFO.
    No automatic batch selection.
    """

    if not item_code or not warehouse:
        return []

    # ------------------------------------------------------------
    # ITEM
    # ------------------------------------------------------------

    item = frappe.get_cached_value(
        "Item",
        item_code,
        ["has_batch_no", "has_serial_no"],
        as_dict=True,
    )

    if not item:
        return []

    # Not a batch item
    if not item.has_batch_no:
        return []

    # Let ERPNext handle serial + batch items
    if item.has_serial_no:
        return []

    # ------------------------------------------------------------
    # ERPNext'S OWN BATCH STOCK CALCULATION
    # ------------------------------------------------------------

    from erpnext.stock.doctype.batch.batch import get_batch_qty

    batches = get_batch_qty(
        item_code=item_code,
        warehouse=warehouse,
        for_stock_levels=True,
        consider_negative_batches=False,
        ignore_reserved_stock=False,
    )

    if not batches:
        return []

    # ------------------------------------------------------------
    # Keep only positive-stock batches
    # ------------------------------------------------------------

    batch_numbers = []

    for row in batches:
        batch_no = row.get("batch_no")
        qty = flt(row.get("qty"))

        if not batch_no:
            continue

        if qty <= 0:
            continue

        batch_numbers.append(batch_no)

    if not batch_numbers:
        return []

    # ------------------------------------------------------------
    # Get expiry dates in ONE query
    # ------------------------------------------------------------

    batch_details = frappe.get_all(
        "Batch",
        filters={
            "name": ["in", batch_numbers],
            "disabled": 0,
        },
        fields=[
            "name",
            "expiry_date",
        ],
    )

    expiry_map = {
        row.name: row.expiry_date
        for row in batch_details
    }

    # Preserve ERPNext batch order
    result = []

    for batch_no in batch_numbers:
        result.append(
            {
                "batch_no": batch_no,
                "expiry_date": expiry_map.get(batch_no),
            }
        )

    return result


# ================================================================
# BARCODE + VARIANT SELECTION
# ================================================================

@frappe.whitelist()
def scan_barcode_with_variants(search_value, ctx=None):
    """
    Uses ERPNext's standard barcode scanner first.

    If the barcode resolves to an Item Template that has variants,
    return the variants so the cashier can select one.

    Otherwise return the normal ERPNext barcode result unchanged.

    This keeps normal barcode / batch / serial / warehouse scanning
    behavior intact.
    """

    if not search_value:
        return {}

    if isinstance(ctx, str):
        ctx = frappe.parse_json(ctx)

    ctx = frappe._dict(ctx or {})

    # ------------------------------------------------------------
    # Use ERPNext's standard barcode resolver
    # ------------------------------------------------------------

    from erpnext.stock.utils import scan_barcode

    data = scan_barcode(
        search_value=search_value,
        ctx=ctx,
    )

    if not data:
        return {}

    # ------------------------------------------------------------
    # Warehouse / serial / batch / normal item
    # ------------------------------------------------------------

    item_code = data.get("item_code")

    if not item_code:
        return data

    # ------------------------------------------------------------
    # Is the resolved item a TEMPLATE with variants?
    # ------------------------------------------------------------

    item = frappe.get_cached_value(
        "Item",
        item_code,
        ["has_variants"],
        as_dict=True,
    )

    if not item or not item.has_variants:
        return data

    # ------------------------------------------------------------
    # Get active variants of this template
    # ------------------------------------------------------------

    variants = frappe.get_all(
        "Item",
        filters={
            "variant_of": item_code,
            "disabled": 0,
        },
        fields=[
            "name",
            "item_name",
        ],
        order_by="name asc",
    )

    if not variants:
        return data

    # ------------------------------------------------------------
    # Permission check
    # ------------------------------------------------------------

    permitted_variants = []

    for variant in variants:
        if frappe.has_permission(
            "Item",
            ptype="read",
            doc=variant.name,
        ):
            permitted_variants.append(
                {
                    "item_code": variant.name,
                    "item_name": variant.item_name,
                }
            )

    # Only return variant selection when there are variants
    if not permitted_variants:
        return data

    data["variant_selection"] = permitted_variants

    return data