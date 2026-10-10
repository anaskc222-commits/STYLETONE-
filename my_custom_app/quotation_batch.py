
import frappe
from frappe import _
from frappe.utils import cint, flt, today


# ============================================================
# BARCODE LOOKUP
# ============================================================

def _get_item_by_barcode(barcode):
    barcode = (barcode or "").strip()

    if not barcode:
        return None

    rows = frappe.get_all(
        "Item Barcode",
        filters={"barcode": barcode},
        fields=["parent"],
        limit=2,
    )

    if rows:
        item_codes = list(dict.fromkeys(
            row.parent for row in rows if row.parent
        ))

        if len(item_codes) > 1:
            frappe.throw(
                _("Barcode {0} is assigned to multiple items.").format(
                    barcode
                )
            )

        return item_codes[0] if item_codes else None

    return frappe.db.get_value("Item", barcode, "name")


# ============================================================
# BATCH STOCK HELPERS
# ============================================================

def _get_batch_qty_rows(item_code, warehouse):
    from erpnext.stock.doctype.batch.batch import get_batch_qty

    try:
        result = get_batch_qty(
            item_code=item_code,
            warehouse=warehouse,
            for_stock_levels=True,
            consider_negative_batches=False,
            ignore_reserved_stock=False,
        )
    except TypeError:
        result = get_batch_qty(item_code, warehouse)

    normalized = []

    if isinstance(result, dict):
        for batch_no, value in result.items():
            if isinstance(value, dict):
                name = (
                    value.get("batch_no")
                    or value.get("name")
                    or batch_no
                )
                qty = value.get("qty")

                if qty is None:
                    qty = value.get("available_qty")

                if qty is None:
                    qty = value.get("actual_qty", 0)
            else:
                name = batch_no
                qty = value

            if name:
                normalized.append({
                    "batch_no": str(name),
                    "qty": flt(qty),
                })

    elif isinstance(result, (list, tuple)):
        for row in result:
            if isinstance(row, dict):
                name = row.get("batch_no") or row.get("name")
                qty = row.get("qty")

                if qty is None:
                    qty = row.get("available_qty")

                if qty is None:
                    qty = row.get("actual_qty", 0)
            else:
                name = (
                    getattr(row, "batch_no", None)
                    or getattr(row, "name", None)
                )
                qty = getattr(row, "qty", 0)

            if name:
                normalized.append({
                    "batch_no": str(name),
                    "qty": flt(qty),
                })

    merged = {}

    for row in normalized:
        batch_no = row["batch_no"]
        merged[batch_no] = (
            merged.get(batch_no, 0) + flt(row["qty"])
        )

    return [
        {
            "batch_no": batch_no,
            "qty": qty,
            "available_qty": qty,
        }
        for batch_no, qty in merged.items()
        if qty > 0
    ]


def _get_available_batches(item_code, warehouse):
    rows = _get_batch_qty_rows(item_code, warehouse)

    if not rows:
        return []

    batch_names = [row["batch_no"] for row in rows]
    expiry_map = {}

    for start in range(0, len(batch_names), 500):
        chunk = batch_names[start:start + 500]

        expiry_rows = frappe.get_all(
            "Batch",
            filters={"name": ["in", chunk]},
            fields=["name", "expiry_date"],
        )

        for expiry in expiry_rows:
            expiry_map[expiry.name] = expiry.expiry_date

    for row in rows:
        row["expiry_date"] = expiry_map.get(row["batch_no"])

    return sorted(
        rows,
        key=lambda row: (
            row["expiry_date"] is None,
            str(row["expiry_date"] or "9999-12-31"),
            row["batch_no"],
        ),
    )


# ============================================================
# NON-BATCH STOCK
# ============================================================

def _get_non_batch_available_qty(item_code, warehouse):
    bin_row = frappe.db.get_value(
        "Bin",
        {
            "item_code": item_code,
            "warehouse": warehouse,
        },
        ["actual_qty", "reserved_qty"],
        as_dict=True,
    )

    if not bin_row:
        return 0.0

    return max(
        0.0,
        flt(bin_row.actual_qty) - flt(bin_row.reserved_qty),
    )


# ============================================================
# ITEM STOCK INFORMATION
# ============================================================

def _get_item_stock_info(item_code, warehouse):
    item = frappe.db.get_value(
        "Item",
        item_code,
        [
            "name",
            "item_name",
            "variant_of",
            "has_variants",
            "has_batch_no",
            "has_serial_no",
            "disabled",
            "is_stock_item",
        ],
        as_dict=True,
    )

    if not item:
        return None

    if cint(item.disabled) or not cint(item.is_stock_item):
        return None

    if cint(item.has_batch_no) and cint(item.has_serial_no):
        return {
            "item_code": item.name,
            "item_name": item.item_name,
            "has_batch_no": cint(item.has_batch_no),
            "has_serial_no": cint(item.has_serial_no),
            "qty": 0,
            "available_qty": 0,
            "unsupported_serial_batch": True,
        }

    if cint(item.has_batch_no):
        batches = _get_available_batches(item.name, warehouse)
        qty = sum(flt(batch["available_qty"]) for batch in batches)
    else:
        batches = []
        qty = _get_non_batch_available_qty(item.name, warehouse)

    return {
        "item_code": item.name,
        "item_name": item.item_name,
        "variant_of": item.variant_of,
        "has_batch_no": cint(item.has_batch_no),
        "has_serial_no": cint(item.has_serial_no),
        "qty": qty,
        "available_qty": qty,
        "batches": batches,
    }


# ============================================================
# PUBLIC API: AVAILABLE BATCHES
# ============================================================

@frappe.whitelist()
def get_available_batches(item_code, warehouse):
    item_code = (item_code or "").strip()
    warehouse = (warehouse or "").strip()

    if not item_code:
        frappe.throw(_("Item Code is required."))

    if not warehouse:
        frappe.throw(_("Select a Warehouse before selecting a batch."))

    item = frappe.db.get_value(
        "Item",
        item_code,
        [
            "has_batch_no",
            "has_serial_no",
            "disabled",
            "is_stock_item",
        ],
        as_dict=True,
    )

    if not item:
        frappe.throw(_("Item {0} was not found.").format(item_code))

    if cint(item.disabled):
        frappe.throw(_("Item {0} is disabled.").format(item_code))

    if not cint(item.is_stock_item):
        frappe.throw(_("Item {0} is not a stock item.").format(item_code))

    if not cint(item.has_batch_no):
        return []

    if cint(item.has_serial_no):
        frappe.throw(
            _(
                "Item {0} uses serial numbers and batches; "
                "this selector does not support serial selection."
            ).format(item_code)
        )

    return _get_available_batches(item_code, warehouse)


# ============================================================
# PUBLIC API: BATCH-SPECIFIC ITEM PRICE
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
    """
    Find a valid Item Price for the selected batch.

    Returns found=False if the installed Item Price DocType
    does not support batch-specific pricing or no matching
    price exists. The caller can then retain ERPNext pricing.
    """

    item_code = (item_code or "").strip()
    batch_no = (batch_no or "").strip()
    price_list = (price_list or "").strip()
    customer = (customer or "").strip()
    uom = (uom or "").strip()
    transaction_date = transaction_date or today()

    if not item_code or not batch_no or not price_list:
        return {"found": False}

    meta = frappe.get_meta("Item Price")

    # Never query a field absent from the installed schema.
    if not meta.has_field("batch_no"):
        return {
            "found": False,
            "reason": "Item Price has no batch_no field.",
        }

    conditions = [
        "item_code = %(item_code)s",
        "price_list = %(price_list)s",
        "batch_no = %(batch_no)s",
        "(valid_from IS NULL OR valid_from <= %(date)s)",
        "(valid_upto IS NULL OR valid_upto >= %(date)s)",
    ]

    values = {
        "item_code": item_code,
        "price_list": price_list,
        "batch_no": batch_no,
        "date": transaction_date,
    }

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

    optional_select = []

    for fieldname in ("customer", "uom", "valid_from", "modified"):
        if meta.has_field(fieldname):
            optional_select.append(fieldname)

    select_fields = [
        "name",
        "price_list_rate",
        "batch_no",
    ] + optional_select

    order_fields = []

    if meta.has_field("customer") and customer:
        order_fields.append(
            "(customer = %(customer)s) DESC"
        )

    if meta.has_field("uom") and uom:
        order_fields.append(
            "(uom = %(uom)s) DESC"
        )

    if meta.has_field("valid_from"):
        order_fields.append("valid_from DESC")

    if meta.has_field("modified"):
        order_fields.append("modified DESC")

    order_by = ", ".join(order_fields) or "name DESC"

    rows = frappe.db.sql(
        """
        SELECT {select_fields}
        FROM `tabItem Price`
        WHERE {conditions}
        ORDER BY {order_by}
        LIMIT 1
        """.format(
            select_fields=", ".join(
                "`{}`".format(field) for field in select_fields
            ),
            conditions=" AND ".join(conditions),
            order_by=order_by,
        ),
        values,
        as_dict=True,
    )

    if not rows:
        return {"found": False}

    return {
        "found": True,
        "price_list_rate": flt(rows[0].price_list_rate),
        "batch_no": rows[0].batch_no,
        "item_price": rows[0].name,
    }


# ============================================================
# PUBLIC API: BARCODE AND VARIANT LOOKUP
# ============================================================

@frappe.whitelist()
def scan_barcode_with_variants(barcode, warehouse=None):
    barcode = (barcode or "").strip()
    warehouse = (warehouse or "").strip()

    if not barcode:
        frappe.throw(_("Scan or enter a barcode."))

    if not warehouse:
        frappe.throw(_("Select the Warehouse before scanning."))

    item_code = _get_item_by_barcode(barcode)

    if not item_code:
        frappe.throw(
            _("No Item was found for barcode {0}.").format(barcode)
        )

    scanned_item = frappe.db.get_value(
        "Item",
        item_code,
        [
            "name",
            "item_name",
            "has_variants",
            "variant_of",
            "disabled",
            "is_stock_item",
        ],
        as_dict=True,
    )

    if not scanned_item:
        frappe.throw(_("Item {0} was not found.").format(item_code))

    if cint(scanned_item.disabled):
        frappe.throw(_("Item {0} is disabled.").format(item_code))

    if (
        not cint(scanned_item.is_stock_item)
        and not cint(scanned_item.has_variants)
    ):
        frappe.throw(_("Item {0} is not a stock item.").format(item_code))

    variant_codes = frappe.get_all(
        "Item",
        filters={
            "variant_of": scanned_item.name,
            "disabled": 0,
            "is_stock_item": 1,
        },
        pluck="name",
        order_by="name asc",
    )

    is_template = bool(
        cint(scanned_item.has_variants) or variant_codes
    )

    if is_template:
        variants = []

        for variant_code in variant_codes:
            info = _get_item_stock_info(variant_code, warehouse)

            if not info or info.get("unsupported_serial_batch"):
                continue

            if flt(info["available_qty"]) <= 0:
                continue

            variants.append({
                "item_code": info["item_code"],
                "item_name": info["item_name"] or info["item_code"],
                "has_batch_no": info["has_batch_no"],
                "qty": info["available_qty"],
                "available_qty": info["available_qty"],
            })

        return {
            "item_code": scanned_item.name,
            "item_name": scanned_item.item_name or scanned_item.name,
            "is_template": True,
            "variants": variants,
        }

    info = _get_item_stock_info(scanned_item.name, warehouse)

    if not info:
        frappe.throw(
            _("Item {0} is disabled or is not a stock item.").format(item_code)
        )

    if info.get("unsupported_serial_batch"):
        frappe.throw(
            _(
                "Item {0} uses serial numbers and batches; "
                "this selector does not support serial selection."
            ).format(item_code)
        )

    if flt(info["available_qty"]) <= 0:
        frappe.throw(
            _(
                "No positive available stock for item {0} "
                "in warehouse {1}."
            ).format(item_code, warehouse)
        )

    return {
        "item_code": info["item_code"],
        "item_name": info["item_name"] or info["item_code"],
        "is_template": False,
        "has_batch_no": info["has_batch_no"],
        "qty": info["available_qty"],
        "available_qty": info["available_qty"],
    }
