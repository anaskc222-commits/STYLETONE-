
import frappe


SOURCE_FIELD = "custom_source_quotation"


def _has_submitted_sales_order(quotation_name):
    """Use ERPNext's existing Quotation-to-Sales-Order links."""
    return bool(
        frappe.db.exists(
            "Sales Order Item",
            {
                "prevdoc_docname": quotation_name,
                "docstatus": 1,
            },
        )
    )


def _has_submitted_direct_invoice(quotation_name, exclude_invoice=None):
    """Find submitted invoices explicitly linked by the direct mapper."""
    filters = {
        SOURCE_FIELD: quotation_name,
        "docstatus": 1,
        "is_return": 0,
    }

    if exclude_invoice:
        filters["name"] = ["!=", exclude_invoice]

    return bool(frappe.db.exists("Sales Invoice", filters))


def _refresh_direct_invoice_status(
    quotation_name,
    event=None,
    current_invoice=None,
):
    if not quotation_name:
        return

    if not frappe.db.exists("Quotation", quotation_name):
        return

    quotation = frappe.get_doc("Quotation", quotation_name)

    # Never alter a cancelled or draft Quotation.
    if quotation.docstatus != 1:
        return

    # Logic 1 remains ERPNext-managed.
    # If a submitted Sales Order exists, let standard status handling win.
    if _has_submitted_sales_order(quotation_name):
        quotation.set_status(update=True)
        return

    if event == "on_submit":
        # The current invoice is being submitted.
        has_invoice = True
    else:
        # On cancellation, ignore the invoice being cancelled.
        has_invoice = _has_submitted_direct_invoice(
            quotation_name,
            exclude_invoice=current_invoice,
        )

    if has_invoice:
        frappe.db.set_value(
            "Quotation",
            quotation_name,
            "status",
            "Invoiced",
            update_modified=False,
        )
    else:
        # No remaining direct invoice: restore ERPNext's calculated status.
        quotation.set_status(update=True)


def on_sales_invoice_submit(doc, method=None):
    if doc.get(SOURCE_FIELD) and not doc.get("is_return"):
        _refresh_direct_invoice_status(
            doc.get(SOURCE_FIELD),
            event="on_submit",
            current_invoice=doc.name,
        )


def on_sales_invoice_cancel(doc, method=None):
    if doc.get(SOURCE_FIELD) and not doc.get("is_return"):
        _refresh_direct_invoice_status(
            doc.get(SOURCE_FIELD),
            event="on_cancel",
            current_invoice=doc.name,
        )


def ensure_direct_invoice_status(doc, method=None):
    """
    ERPNext recalculates Quotation.status during validation.
    Restore Invoiced after saving only when a direct invoice exists
    and no submitted Sales Order link takes precedence.
    """
    if doc.docstatus != 1:
        return

    if _has_submitted_sales_order(doc.name):
        return

    if _has_submitted_direct_invoice(doc.name):
        if doc.status != "Invoiced":
            frappe.db.set_value(
                "Quotation",
                doc.name,
                "status",
                "Invoiced",
                update_modified=False,
            )
