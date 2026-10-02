const TARGET_PRICE_LISTS = [
    "B2B WHOLESALE",
    "SALOON",
    "BEAUTY PARLOUR"
];


function update_ignore_pricing_rule(frm) {
    const should_ignore = TARGET_PRICE_LISTS.includes(
        frm.doc.selling_price_list
    );

    const value = should_ignore ? 1 : 0;

    if (frm.doc.ignore_pricing_rule !== value) {
        frm.set_value("ignore_pricing_rule", value);
    }
}


frappe.ui.form.on("Quotation", {
    refresh(frm) {
        update_ignore_pricing_rule(frm);
    }
});


frappe.ui.form.on("Sales Order", {
    refresh(frm) {
        update_ignore_pricing_rule(frm);
    }
});


frappe.ui.form.on("Sales Invoice", {
    refresh(frm) {
        update_ignore_pricing_rule(frm);
    }
});
