import frappe
from frappe import _
from frappe.utils import flt, getdate, nowdate


@frappe.whitelist()
def scan_barcode_with_variants(search_value):
    """Resolve a barcode and return variant choices when required."""

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
            _("Serial-number-tracked items are not supported by this selector.")
        )

    result = {
        "barcode": barcode,
        "barcode_uom": barcode_data.uom,
        "item_code": item.name,
        "item_name": item.item_name,
        "disabled": item.disabled,
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
                "disabled",
                "has_batch_no",
                "has_serial_no",
                "stock_uom",
                "variant_of",
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
    """Return positive-quantity batches for the selected item and warehouse."""

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

    quantities = {}

    for row in batch_rows:
        batch_no = row.get("batch_no")
        qty = flt(row.get("qty"))

        if batch_no:
            quantities[batch_no] = quantities.get(batch_no, 0) + qty

    positive_batch_nos = [
        batch_no for batch_no, qty in quantities.items() if qty > 0
    ]

    if not positive_batch_nos:
        return []

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
        row.name: row.expiry_date for row in batch_details
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


def _find_item_price(
    item_code,
    price_list,
    batch_no,
    transaction_date,
    currency=None,
    uom=None,
    customer=None,
    qty=1,
):
    """
    Find a valid Item Price.

    Priority:
    1. Exact selected batch.
    2. Blank batch.

    Supports standard Item Price validity, currency, UOM, customer,
    and minimum-quantity fields when those fields exist in this site.
    """

    if not item_code or not price_list:
        return None

    meta = frappe.get_meta("Item Price")

    if not meta.has_field("batch_no"):
        # This site cannot store batch-specific prices in Item Price
        # unless a different custom field or pricing mechanism is used.
        batch_field_exists = False
    else:
        batch_field_exists = True

    fields = {"item_code", "price_list", "price_list_rate"}
    optional_fields = [
        "batch_no",
        "valid_from",
        "valid_upto",
        "currency",
        "uom",
        "customer",
        "min_qty",
        "packing_unit",
    ]

    for fieldname in optional_fields:
        if meta.has_field(fieldname):
            fields.add(fieldname)

    date_value = transaction_date or nowdate()
    try:
        date_value = str(getdate(date_value))
    except Exception:
        date_value = nowdate()

    # Exact-batch price first, followed by the blank-batch fallback.
    batch_candidates = [batch_no, ""] if batch_no else [""]

    for candidate_batch in batch_candidates:
        if candidate_batch and not batch_field_exists:
            continue

        conditions = [
            "item_code = %(item_code)s",
            "price_list = %(price_list)s",
        ]

        values = {
            "item_code": item_code,
            "price_list": price_list,
            "transaction_date": date_value,
            "qty": flt(qty) or 1,
        }

        if batch_field_exists:
            if candidate_batch:
                conditions.append("IFNULL(batch_no, '') = %(batch_no)s")
                values["batch_no"] = candidate_batch
            else:
                conditions.append("IFNULL(batch_no, '') = ''")

        if meta.has_field("valid_from"):
            conditions.append(
                "(valid_from IS NULL OR valid_from <= %(transaction_date)s)"
            )

        if meta.has_field("valid_upto"):
            conditions.append(
                "(valid_upto IS NULL OR valid_upto >= %(transaction_date)s)"
            )

        if meta.has_field("min_qty"):
            conditions.append("(IFNULL(min_qty, 0) <= %(qty)s)")

        if meta.has_field("currency") and currency:
            conditions.append("(IFNULL(currency, '') = %(currency)s)")
            values["currency"] = currency

        if meta.has_field("uom") and uom:
            conditions.append("(IFNULL(uom, '') IN ('', %(uom)s))")
            values["uom"] = uom

        if meta.has_field("customer") and customer:
            conditions.append("(IFNULL(customer, '') IN ('', %(customer)s))")
            values["customer"] = customer

        selected_fields = ", ".join(
            f"`{fieldname}`" for fieldname in sorted(fields)
        )

        order_parts = []

        if meta.has_field("customer") and customer:
            order_parts.append(
                "CASE WHEN customer = %(customer)s THEN 0 ELSE 1 END"
            )

        if meta.has_field("uom") and uom:
            order_parts.append(
                "CASE WHEN uom = %(uom)s THEN 0 ELSE 1 END"
            )

        if meta.has_field("valid_from"):
            order_parts.append("valid_from DESC")

        order_parts.append("modified DESC")

        query = f"""
            SELECT {selected_fields}
            FROM `tabItem Price`
            WHERE {" AND ".join(conditions)}
            ORDER BY {", ".join(order_parts)}
            LIMIT 1
        """

        rows = frappe.db.sql(query, values, as_dict=True)

        if rows:
            return rows[0]

    return None


@frappe.whitelist()
def get_quotation_item_details(
    item_code,
    batch_no=None,
    warehouse=None,
    args=None,
    doc=None,
):
    """
    Fetch ERPNext item details with batch_no provided before item_code
    is written to the Quotation Item row.
    """

    from erpnext.stock.get_item_details import get_item_details

    item_code = (item_code or "").strip()
    batch_no = (batch_no or "").strip()
    warehouse = (warehouse or "").strip()

    if not item_code:
        frappe.throw(_("Item Code is required."))

    if not warehouse:
        frappe.throw(_("Select the Quotation's Custom Warehouse first."))

    if not frappe.has_permission("Item", "read"):
        frappe.throw(_("You do not have permission to read Items."))

    item = frappe.get_cached_value(
        "Item",
        item_code,
        ["disabled", "has_variants", "variant_of", "has_batch_no", "has_serial_no"],
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

    if item.has_batch_no and not batch_no:
        frappe.throw(
            _("Select a batch before fetching details for {0}.").format(item_code)
        )

    if batch_no:
        batch_item = frappe.db.get_value("Batch", batch_no, "item")

        if batch_item != item_code:
            frappe.throw(
                _("Batch {0} does not belong to Item {1}.").format(
                    batch_no, item_code
                )
            )

    item_args = frappe.parse_json(args) if args else {}
    item_args = frappe._dict(item_args)

    quotation_doc = frappe.parse_json(doc) if doc else {}
    quotation_doc = frappe._dict(quotation_doc)

    # The selected batch is present before ERPNext calculates item details.
    item_args.update({
        "doctype": "Quotation",
        "item_code": item_code,
        "batch_no": batch_no,
        "warehouse": warehouse,
        "company": item_args.get("company") or quotation_doc.get("company"),
        "customer": (
            item_args.get("customer")
            or quotation_doc.get("party_name")
            or quotation_doc.get("customer")
        ),
        "transaction_date": (
            item_args.get("transaction_date")
            or quotation_doc.get("transaction_date")
            or nowdate()
        ),
        "qty": flt(item_args.get("qty")) or 1,
    })

    if not item_args.get("selling_price_list"):
        item_args.selling_price_list = (
            quotation_doc.get("selling_price_list")
            or item_args.get("price_list")
        )

    if not item_args.get("currency"):
        item_args.currency = quotation_doc.get("currency")

    if not item_args.get("conversion_rate"):
        item_args.conversion_rate = (
            flt(quotation_doc.get("conversion_rate")) or 1
        )

    if not item_args.get("plc_conversion_rate"):
        item_args.plc_conversion_rate = (
            flt(quotation_doc.get("plc_conversion_rate")) or 1
        )

    if not item_args.get("uom"):
        item_args.uom = item_args.get("stock_uom")

    # Call ERPNext's standard item-details implementation.
    details = get_item_details(item_args, doc=quotation_doc or None)

    if not details:
        frappe.throw(
            _("ERPNext returned no item details for {0}.").format(item_code)
        )

    details = frappe._dict(details)

    # Apply the requested batch-aware Item Price priority.
    price_list = (
        item_args.get("selling_price_list")
        or item_args.get("price_list")
    )

    item_price = _find_item_price(
        item_code=item_code,
        price_list=price_list,
        batch_no=batch_no,
        transaction_date=item_args.get("transaction_date"),
        currency=item_args.get("currency"),
        uom=item_args.get("uom"),
        customer=item_args.get("customer"),
        qty=item_args.get("qty"),
    )

    if item_price:
        rate = flt(item_price.get("price_list_rate"))
    else:
        # User's requested fallback when no matching Item Price exists.
        rate = 0

    details.item_code = item_code
    details.rate = rate
    details.price_list_rate = rate
    details.batch_no = batch_no
    details.custom_batch_no = batch_no

    return {"details": details}