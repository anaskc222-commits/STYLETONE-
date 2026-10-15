
import frappe


SOURCE_FIELD = "custom_source_quotation_"


def _has_submitted_sales_order(quotation_name):
    """Check whether a submitted Sales Order references this Quotation."""
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
    """Find submitted direct invoices linked to this Quotation."""
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

    # Never change a draft or cancelled Quotation.
    if quotation.docstatus != 1:
        return

    # Preserve ERPNext's normal Sales Order status handling.
    if _has_submitted_sales_order(quotation_name):
        quotation.set_status(update=True)
        return

    if event == "on_submit":
        # The current invoice is being submitted.
        has_invoice = True
    else:
        # On cancellation, exclude the invoice being cancelled.
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
        # Restore ERPNext's calculated status if no direct invoice remains.
        quotation.set_status(update=True)


def on_sales_invoice_submit(doc, method=None):
    """Update the source Quotation when a direct invoice is submitted."""
    if doc.get(SOURCE_FIELD) and not doc.get("is_return"):
        _refresh_direct_invoice_status(
            doc.get(SOURCE_FIELD),
            event="on_submit",
            current_invoice=doc.name,
        )


def on_sales_invoice_cancel(doc, method=None):
    """Recalculate the source Quotation when a direct invoice is cancelled."""
    if doc.get(SOURCE_FIELD) and not doc.get("is_return"):
        _refresh_direct_invoice_status(
            doc.get(SOURCE_FIELD),
            event="on_cancel",
            current_invoice=doc.name,
        )


def ensure_direct_invoice_status(doc, method=None):
    """
    Restore Invoiced after a Quotation update when a submitted direct invoice
    exists and the normal Sales Order flow does not take precedence.
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
