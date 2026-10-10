(() => {
    "use strict";

    if (window.__styleToneQuotationSalesInvoicePricingV1) return;
    window.__styleToneQuotationSalesInvoicePricingV1 = true;

    const SALES_INVOICE_METHOD =
        "my_custom_app.quotation_invoice_mapping.make_sales_invoice_preserve_quotation_pricing";

    frappe.ui.form.on("Quotation", {
        refresh(frm) {
            if (frm.doc.docstatus !== 1) return;
            if (frm.doc.quotation_to !== "Customer") return;
            if (["Lost", "Cancelled"].includes(frm.doc.status)) return;
            if (!frappe.model.can_create("Sales Invoice")) return;

            frm.add_custom_button(
                __("Sales Invoice"),
                () => {
                    frappe.model.open_mapped_doc({
                        method: SALES_INVOICE_METHOD,
                        frm: frm
                    });
                },
                __("Create")
            );
        }
    });
})();