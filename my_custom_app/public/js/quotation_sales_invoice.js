(() => {
    "use strict";

    if (window.__styleToneQuotationSalesInvoice) return;
    window.__styleToneQuotationSalesInvoice = true;

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
                        method:
                            "erpnext.selling.doctype.quotation.quotation.make_sales_invoice",
                        frm: frm
                    });
                },
                __("Create")
            );
        }
    });
})();