import frappe
from frappe import _
from frappe.utils import flt, cint

from erpnext.stock.doctype.batch.batch import get_batch_qty


# ============================================================
# BARCODE RESOLUTION
# ============================================================

def _resolve_item_code(barcode):
    """Resolve a barcode to an Item code."""

    barcode = (barcode or "").strip()

    if not barcode:
        return None

    # First, resolve the barcode through the Item Barcode child table.
    item_code = frappe.db.get_value(
        "Item Barcode",
        {"barcode": barcode},
        "parent",
    )

    if item_code:
        return item_code

    # Allow scanning an Item Code directly.
    if frappe.db.exists("Item", barcode):
        return barcode

    return None


# ============================================================
# BATCH EXPIRY DATES
# ============================================================

def _get_expiry_dates(batch_numbers):
    """Fetch expiry dates for multiple batches in one query."""

    batch_numbers = list({
        batch_no
        for batch_no in (batch_numbers or [])
        if batch_no
    })

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
# BATCH QUANTITIES
# ============================================================

def _normalize_batch_qty_rows(result):
    """
    Normalize get_batch_qty() output across supported return shapes.

    Expected common shape:
        [{"batch_no": "BATCH-001", "qty": 5}]

    Also supports dictionary mappings where batch numbers are keys.
    """

    if not result:
        return []

    if isinstance(result, dict):
        # A single batch row.
        if result.get("batch_no") or result.get("name"):
            return [result]

        # A mapping such as {"BATCH-001": 5, "BATCH-002": 3}.
        rows = []

        for batch_no, qty in result.items():
            if isinstance(qty, dict):
                row = dict(qty)
                row.setdefault("batch_no", batch_no)
            else:
                row = {
                    "batch_no": batch_no,
                    "qty": qty,
                }

            rows.append(row)

        return rows

    if isinstance(result, (list, tuple)):
        rows = []

        for row in result:
            if isinstance(row, dict):
                rows.append(row)

        return rows

    return []


def _get_batch_quantities(item_code, warehouse):
    """
    Return positive available quantities by batch.

    Uses ERPNext's get_batch_qty() rather than calculating batch
    stock directly from Stock Ledger Entries.
    """

    if not item_code or not warehouse:
        return []

    result = get_batch_qty(
        item_code=item_code,
        warehouse=warehouse,
        for_stock_levels=True,
        consider_negative_batches=False,
        ignore_reserved_stock=False,
    )

    rows = _normalize_batch_qty_rows(result)
    batches = []

    for row in rows:
        batch_no = (
            row.get("batch_no")
            or row.get("name")
        )

        qty = flt(
            row.get("qty")
            if row.get("qty") is not None
            else row.get("batch_qty")
        )

        if not batch_no or qty <= 0:
            continue

        batches.append({
            "batch_no": batch_no,
            "qty": qty,
            "available_qty": qty,
        })

    # Avoid returning duplicate batch rows if a backend version
    # provides more than one row for the same batch.
    combined = {}

    for row in batches:
        batch_no = row["batch_no"]

        if batch_no not in combined:
            combined[batch_no] = {
                "batch_no": batch_no,
                "qty": 0,
                "available_qty": 0,
            }

        combined[batch_no]["qty"] += row["qty"]
        combined[batch_no]["available_qty"] += row["available_qty"]

    return list(combined.values())


def _get_available_batches(item_code, warehouse):
    """Return positive-stock batches with their expiry dates."""

    batches = _get_batch_quantities(item_code, warehouse)

    if not batches:
        return []

    expiry_dates = _get_expiry_dates([
        row["batch_no"]
        for row in batches
    ])

    for row in batches:
        row["expiry_date"] = expiry_dates.get(row["batch_no"])

    # Keep the response order stable.
    batches.sort(
        key=lambda row: (
            str(row.get("expiry_date") or "9999-12-31"),
            row["batch_no"],
        )
    )

    return batches


@frappe.whitelist()
def get_available_batches(item_code=None, warehouse=None):
    """
    Public endpoint for the batch-selection dialog.

    Returns only batches with positive available quantity.
    """

    item_code = (item_code or "").strip()
    warehouse = (warehouse or "").strip()

    if not item_code:
        frappe.throw(_("Please select an Item."))

    if not warehouse:
        frappe.throw(_("Please select a Warehouse before scanning."))

    item = frappe.db.get_value(
        "Item",
        item_code,
        [
            "name",
            "has_batch_no",
            "has_serial_no",
            "disabled",
            "is_stock_item",
        ],
        as_dict=True,
    )

    if not item:
        frappe.throw(_("Item {0} was not found.").format(item_code))

    if item.disabled:
        frappe.throw(_("Item {0} is disabled.").format(item_code))

    if not item.is_stock_item:
        frappe.throw(_("Item {0} is not a stock item.").format(item_code))

    if not cint(item.has_batch_no):
        return []

    if cint(item.has_serial_no):
        frappe.throw(
            _(
                "Item {0} uses both serial numbers and batches. "
                "This batch selector does not handle serial-number selection."
            ).format(item_code)
        )

    return _get_available_batches(item_code, warehouse)


# ============================================================
# NON-BATCH STOCK QUANTITIES
# ============================================================

def _get_non_batch_quantities(item_codes, warehouse):
    """
    Fetch Bin quantities for multiple non-batch items in one query.

    This is used for variant selection and ordinary non-batch items.
    Batch-controlled items use get_batch_qty() instead.
    """

    item_codes = list({
        code for code in (item_codes or []) if code
    })

    if not item_codes or not warehouse:
        return {}

    rows = frappe.get_all(
        "Bin",
        filters={
            "item_code": ["in", item_codes],
            "warehouse": warehouse,
        },
        fields=[
            "item_code",
            "actual_qty",
            "reserved_qty",
        ],
    )

    quantities = {
        item_code: 0.0
        for item_code in item_codes
    }

    for row in rows:
        available_qty = max(
            0.0,
            flt(row.actual_qty) - flt(row.reserved_qty),
        )

        quantities[row.item_code] = available_qty

    return quantities


# ============================================================
# BULK ITEM STOCK INFORMATION
# ============================================================

def _get_items_stock_info(item_codes, warehouse):
    """
    Return stock information indexed by Item code.

    Uses:
    - One bulk Item lookup
    - One bulk Bin lookup for non-batch items
    - ERPNext get_batch_qty() for each batch-controlled item
    - One bulk Batch expiry-date lookup
    """

    item_codes = list({
        code for code in (item_codes or []) if code
    })

    if not item_codes or not warehouse:
        return {}

    item_rows = frappe.get_all(
        "Item",
        filters={
            "name": ["in", item_codes],
        },
        fields=[
            "name",
            "item_name",
            "variant_of",
            "has_variants",
            "has_batch_no",
            "has_serial_no",
            "disabled",
            "is_stock_item",
        ],
    )

    items = {}

    for item in item_rows:
        if item.disabled or not item.is_stock_item:
            continue

        # Serial-plus-batch items need serial selection logic, which
        # is outside the scope of this batch-only selector.
        if cint(item.has_serial_no) and cint(item.has_batch_no):
            continue

        items[item.name] = item

    if not items:
        return {}

    non_batch_codes = [
        item_code
        for item_code, item in items.items()
        if not cint(item.has_batch_no)
    ]

    batch_codes = [
        item_code
        for item_code, item in items.items()
        if cint(item.has_batch_no)
    ]

    non_batch_quantities = _get_non_batch_quantities(
        non_batch_codes,
        warehouse,
    )

    result = {}

    # Add non-batch item stock information.
    for item_code in non_batch_codes:
        item = items[item_code]
        available_qty = flt(
            non_batch_quantities.get(item_code, 0)
        )

        result[item_code] = {
            "item_code": item_code,
            "item_name": item.item_name or item_code,
            "variant_of": item.variant_of,
            "has_batch_no": 0,
            "available_qty": available_qty,
            "qty": available_qty,
            "batches": [],
        }

    # Batch quantities are obtained through ERPNext's stock function.
    all_batch_rows = []
    batches_by_item = {}

    for item_code in batch_codes:
        item = items[item_code]

        batch_rows = _get_batch_quantities(
            item_code,
            warehouse,
        )

        batches_by_item[item_code] = batch_rows

        for batch in batch_rows:
            all_batch_rows.append(batch)

        available_qty = sum(
            flt(batch.get("available_qty"))
            for batch in batch_rows
        )

        result[item_code] = {
            "item_code": item_code,
            "item_name": item.item_name or item_code,
            "variant_of": item.variant_of,
            "has_batch_no": 1,
            "available_qty": available_qty,
            "qty": available_qty,
            "batches": batch_rows,
        }

    # Fetch expiry dates for all returned batches in one query.
    expiry_dates = _get_expiry_dates([
        batch.get("batch_no")
        for batch in all_batch_rows
    ])

    for item_code, batch_rows in batches_by_item.items():
        for batch in batch_rows:
            batch["expiry_date"] = expiry_dates.get(
                batch.get("batch_no")
            )

        batch_rows.sort(
            key=lambda row: (
                str(row.get("expiry_date") or "9999-12-31"),
                row["batch_no"],
            )
        )

        result[item_code]["batches"] = batch_rows

    return result


def _get_item_stock_info(item_code, warehouse):
    """Return stock information for one Item."""

    info = _get_items_stock_info(
        [item_code],
        warehouse,
    )

    return info.get(item_code)


# ============================================================
# ITEM TEMPLATE VARIANTS
# ============================================================

def _get_variant_codes(template_code):
    """
    Return direct, active stock-item variants of an Item template.

    Uses variant_of relationships rather than a nonexistent is_template
    database field.
    """

    if not template_code:
        return []

    rows = frappe.get_all(
        "Item",
        filters={
            "variant_of": template_code,
            "disabled": 0,
            "is_stock_item": 1,
        },
        fields=["name"],
        order_by="name asc",
    )

    return [row.name for row in rows]


# ============================================================
# BARCODE SCAN ENDPOINT
# ============================================================

@frappe.whitelist()
def scan_barcode_with_variants(barcode, warehouse=None):
    """
    Resolve a barcode for Quotation scanning.

    Template barcode:
        Returns variants that have positive available stock.

    Ordinary item barcode:
        Returns item stock information.

    No Item.is_template field is queried.
    """

    barcode = (barcode or "").strip()
    warehouse = (warehouse or "").strip()

    if not barcode:
        frappe.throw(_("Please scan or enter a barcode."))

    if not warehouse:
        frappe.throw(_("Please select a Warehouse before scanning."))

    item_code = _resolve_item_code(barcode)

    if not item_code:
        frappe.throw(
            _("No Item or Item Barcode found for: {0}").format(barcode)
        )

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
        frappe.throw(
            _("Item {0} was not found.").format(item_code)
        )

    if item.disabled:
        frappe.throw(
            _("Item {0} is disabled.").format(item_code)
        )

    if not item.is_stock_item:
        frappe.throw(
            _("Item {0} is not a stock item.").format(item_code)
        )

    # Detect a template using the standard has_variants field and
    # actual variant_of relationships.
    variant_codes = _get_variant_codes(item_code)
    is_template = bool(cint(item.has_variants) or variant_codes)

    if is_template:
        if not variant_codes:
            frappe.throw(
                _("No active stock-item variants found for {0}.").format(
                    item_code
                )
            )

        stock_info = _get_items_stock_info(
            variant_codes,
            warehouse,
        )

        variants = []

        for variant_code in variant_codes:
            info = stock_info.get(variant_code)

            if not info:
                continue

            available_qty = flt(
                info.get("available_qty")
            )

            if available_qty <= 0:
                continue

            variants.append({
                "item_code": variant_code,
                "item_name": (
                    info.get("item_name")
                    or variant_code
                ),
                "has_batch_no": cint(
                    info.get("has_batch_no")
                ),
                "available_qty": available_qty,
                "qty": available_qty,
                "batches": info.get("batches") or [],
            })

        if not variants:
            frappe.throw(
                _("No variants with available stock found for {0}.").format(
                    item_code
                )
            )

        return {
            "is_template": True,
            "item_code": item_code,
            "item_name": item.item_name or item_code,
            "variants": variants,
        }

    # Reject serial-plus-batch items because they require serial selection.
    if cint(item.has_serial_no) and cint(item.has_batch_no):
        frappe.throw(
            _(
                "Item {0} uses both serial numbers and batches. "
                "Serial-number selection is not supported by this selector."
            ).format(item_code)
        )

    info = _get_item_stock_info(
        item_code,
        warehouse,
    )

    if not info:
        frappe.throw(
            _("Could not retrieve stock information for {0}.").format(
                item_code
            )
        )

    available_qty = flt(
        info.get("available_qty")
    )

    if available_qty <= 0:
        frappe.throw(
            _("No available stock for {0} in warehouse {1}.").format(
                item_code,
                warehouse,
            )
        )

    return {
        "is_template": False,
        "item_code": item_code,
        "item_name": (
            info.get("item_name")
            or item.item_name
            or item_code
        ),
        "has_batch_no": cint(item.has_batch_no),
        "available_qty": available_qty,
        "qty": available_qty,
        "batches": info.get("batches") or [],
    }