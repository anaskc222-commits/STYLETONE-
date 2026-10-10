import frappe
from frappe import _


# ------------------------------------------------------------
# SHARED HELPERS
# ------------------------------------------------------------

HEADER_FIELDS = (
    "selling_price_list",
    "currency",
    "conversion_rate",
    "price_list_currency",
    "plc_conversion_rate",
    "apply_discount_on",
    "additional_discount_percentage",
    "discount_amount",
    "ignore_pricing_rule",
    "tax_category",
    "taxes_and_charges",
    "shipping_rule",
    "incoterm",
    "named_place",
)

ITEM_PRICE_FIELDS = (
    "price_list_rate",
    "rate",
    "discount_percentage",
    "discount_amount",
    "margin_type",
    "margin_rate_or_amount",
)


def _copy_header_values(source, target):
    """Preserve Quotation price-list and discount settings."""

    for field in HEADER_FIELDS:
        if source.meta.has_field(field) and target.meta.has_field(field):
            target.set(field, source.get(field))


def _copy_item_values(source, target):
    """Copy the existing calculated rate and batch, without price lookup."""

    if source.item_code != target.item_code:
        frappe.throw(
            _("Cannot safely map item {0} to the Quotation item.")
            .format(target.item_code)
        )

    # Custom Quotation field -> standard target batch field.
    batch_no = source.get("custom_batch_no")

    if batch_no and target.meta.has_field("batch_no"):
        target.batch_no = batch_no

    # Preserve the Quotation's calculated price and discounts.
    for field in ITEM_PRICE_FIELDS:
        if source.meta.has_field(field) and target.meta.has_field(field):
            target.set(field, source.get(field))


def _copy_invoice_rows(quotation, invoice):
    """
    Match invoice rows to Quotation rows in source order.
    If the row count differs, only allow unambiguous item-code matches.
    """

    source_rows = [
        row for row in quotation.items
        if not row.get("is_alternative")
    ]
    target_rows = list(invoice.items or [])

    if len(source_rows) == len(target_rows):
        for source, target in zip(source_rows, target_rows):
            _copy_item_values(source, target)
        return

    # A differing row count can occur when only selected rows are mapped.
    # Never guess between repeated rows for the same item.
    unused_sources = list(source_rows)

    for target in target_rows:
        candidates = [
            row for row in unused_sources
            if row.item_code == target.item_code
        ]

        if len(candidates) != 1:
            frappe.throw(
                _(
                    "Cannot safely match item {0} to its Quotation row. "
                    "Please check repeated items or selected rows."
                ).format(target.item_code)
            )

        source = candidates[0]
        _copy_item_values(source, target)
        unused_sources.remove(source)


# ------------------------------------------------------------
# QUOTATION -> SALES INVOICE
# ------------------------------------------------------------

@frappe.whitelist()
def make_sales_invoice_preserve_quotation_pricing(
    source_name,
    target_doc=None,
    args=None,
):
    from erpnext.selling.doctype.quotation.quotation import (
        make_sales_invoice as standard_make_sales_invoice,
    )

    quotation = frappe.get_doc("Quotation", source_name)

    if quotation.docstatus != 1:
        frappe.throw(_("Only submitted Quotations can be invoiced."))

    if quotation.quotation_to != "Customer":
        frappe.throw(_("This action requires a Customer Quotation."))

    # Use ERPNext's normal mapper first.
    invoice = standard_make_sales_invoice(
        source_name,
        target_doc=target_doc,
        args=args,
    )

    # Restore the Quotation's Price List and discount settings.
    _copy_header_values(quotation, invoice)

    # Restore the batch-specific rate and discount on each row.
    _copy_invoice_rows(quotation, invoice)

    # Calculate amounts and taxes from the preserved rates.
    invoice.run_method("calculate_taxes_and_totals")

    return invoice


# ------------------------------------------------------------
# QUOTATION -> SALES ORDER
# ------------------------------------------------------------

@frappe.whitelist()
def make_sales_order_preserve_quotation_pricing(
    source_name,
    target_doc=None,
    args=None,
):
    from erpnext.selling.doctype.quotation.quotation import (
        make_sales_order as standard_make_sales_order,
    )

    quotation = frappe.get_doc("Quotation", source_name)

    if quotation.docstatus != 1:
        frappe.throw(_("Only submitted Quotations can create Sales Orders."))

    # Use ERPNext's standard mapping, including its quantity checks.
    order = standard_make_sales_order(
        source_name,
        target_doc=target_doc,
        args=args,
    )

    _copy_header_values(quotation, order)

    # ERPNext maps the source Quotation Item name into quotation_item.
    source_by_name = {
        row.name: row
        for row in quotation.items
    }

    for target in order.items:
        source = source_by_name.get(target.get("quotation_item"))

        if not source:
            frappe.throw(
                _(
                    "Cannot identify the source Quotation row for "
                    "Sales Order item {0}."
                ).format(target.item_code)
            )

        _copy_item_values(source, target)

    order.run_method("calculate_taxes_and_totals")

    return order