import frappe
from frappe.utils import cint, flt, cstr


# ============================================================
# BARCODE LOOKUP
# ============================================================

def _get_item_by_barcode(barcode):
    """Resolve an Item Barcode or exact Item code in one query."""

    rows = frappe.db.sql(
        """
        SELECT
            i.name AS item_code,
            i.item_name,
            i.has_variants,
            i.has_batch_no,
            i.has_serial_no,
            i.is_stock_item,
            i.stock_uom,
            i.description,
            i.image,
            ib.uom AS barcode_uom
        FROM `tabItem` i
        LEFT JOIN `tabItem Barcode` ib
            ON ib.parent = i.name
            AND ib.parenttype = 'Item'
        WHERE
            i.disabled = 0
            AND (
                ib.barcode = %(barcode)s
                OR i.name = %(barcode)s
            )
        ORDER BY
            CASE
                WHEN ib.barcode = %(barcode)s THEN 0
                ELSE 1
            END
        LIMIT 1
        """,
        {"barcode": barcode},
        as_dict=True,
    )

    return rows[0] if rows else None


def _format_item(row):
    """Return the small set of fields required by the client."""

    return {
        "item_code": row.get("item_code") or row.get("name"),
        "item_name": row.get("item_name") or row.get("name"),
        "has_variants": cint(row.get("has_variants")),
        "has_batch_no": cint(row.get("has_batch_no")),
        "has_serial_no": cint(row.get("has_serial_no")),
        "is_stock_item": cint(row.get("is_stock_item")),
        "stock_uom": row.get("stock_uom"),
        "description": row.get("description"),
        "image": row.get("image"),
        "barcode_uom": row.get("barcode_uom"),
    }


@frappe.whitelist()
def scan_barcode_with_variants(
    barcode=None,
    search_value=None,
    ctx=None,
    warehouse=None,
):
    """
    Resolve a barcode or Item code.

    Template variants are loaded only when the resolved Item is a template.
    No stock calculation is performed by this endpoint.
    """

    barcode = cstr(barcode or search_value).strip()

    if not barcode:
        return {"found": False}

    frappe.has_permission("Item", ptype="select", throw=True)

    item = _get_item_by_barcode(barcode)

    if not item:
        return {"found": False}

    item_code = item.get("item_code")

    frappe.has_permission(
        "Item",
        ptype="select",
        doc=item_code,
        throw=True,
    )

    result = _format_item(item)
    result["found"] = True
    result["variants"] = []

    if cint(item.get("has_variants")):
        variants = frappe.get_all(
            "Item",
            filters={
                "variant_of": item_code,
                "disabled": 0,
            },
            fields=[
                "name",
                "item_name",
                "has_batch_no",
                "has_serial_no",
                "is_stock_item",
                "stock_uom",
                "description",
                "image",
            ],
            order_by="name asc",
            limit_page_length=500,
        )

        result["variants"] = [
            {
                "item_code": row.get("name"),
                "item_name": row.get("item_name") or row.get("name"),
                "has_batch_no": cint(row.get("has_batch_no")),
                "has_serial_no": cint(row.get("has_serial_no")),
                "is_stock_item": cint(row.get("is_stock_item")),
                "stock_uom": row.get("stock_uom"),
                "description": row.get("description"),
                "image": row.get("image"),
                "barcode_uom": result.get("barcode_uom"),
            }
            for row in variants
        ]

    return result


# ============================================================
# AVAILABLE BATCHES
# ============================================================

def _get_batch_qty_rows(item_code, warehouse):
    """
    Get positive batch quantities for one item and warehouse.
    Batch stock is deliberately not cached.
    """

    from erpnext.stock.doctype.batch.batch import get_batch_qty

    qty_rows = get_batch_qty(
        item_code=item_code,
        warehouse=warehouse,
        for_stock_levels=True,
        consider_negative_batches=False,
        ignore_reserved_stock=False,
    )

    quantities = {}

    for row in qty_rows or []:
        batch_no = row.get("batch_no")
        qty = flt(row.get("qty"))

        if batch_no:
            quantities[batch_no] = (
                quantities.get(batch_no, 0) + qty
            )

    positive_batch_numbers = [
        batch_no
        for batch_no, qty in quantities.items()
        if qty > 0
    ]

    if not positive_batch_numbers:
        return []

    batch_rows = frappe.get_all(
        "Batch",
        filters={
            "name": ["in", positive_batch_numbers],
            "item": item_code,
            "disabled": 0,
        },
        fields=[
            "name",
            "expiry_date",
        ],
        order_by="expiry_date asc, name asc",
        limit_page_length=1000,
    )

    result = []

    for batch in batch_rows:
        qty = flt(quantities.get(batch.name))

        if qty <= 0:
            continue

        result.append(
            {
                "batch_no": batch.name,
                "expiry_date": batch.expiry_date,
                "qty": qty,
            }
        )

    return result


@frappe.whitelist()
def get_available_batches(item_code, warehouse=None):
    """
    Return positive-quantity batches for a batch-tracked stock Item.

    The warehouse is required. Serial-and-batch Items are left to
    ERPNext's standard serial/batch handling.
    """

    item_code = cstr(item_code).strip()
    warehouse = cstr(warehouse).strip()

    if not item_code:
        frappe.throw("Item Code is required.")

    if not warehouse:
        frappe.throw("Select a warehouse before scanning items.")

    frappe.has_permission(
        "Item",
        ptype="select",
        doc=item_code,
        throw=True,
    )

    item = frappe.db.get_value(
        "Item",
        item_code,
        [
            "has_batch_no",
            "has_serial_no",
            "is_stock_item",
            "disabled",
        ],
        as_dict=True,
    )

    if not item or cint(item.disabled):
        frappe.throw("The selected Item is unavailable.")

    if not cint(item.is_stock_item):
        return []

    if not cint(item.has_batch_no):
        return []

    # Keep serial-and-batch Items on ERPNext's native workflow.
    if cint(item.has_serial_no):
        return []

    if not frappe.db.exists(
        "Warehouse",
        {
            "name": warehouse,
            "disabled": 0,
        },
    ):
        frappe.throw("Select a valid, enabled warehouse.")

    return _get_batch_qty_rows(item_code, warehouse)