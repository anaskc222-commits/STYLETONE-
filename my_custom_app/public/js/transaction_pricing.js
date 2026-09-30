const TARGET_PRICE_LISTS = [
    "B2B WHOLESALE",
    "SALOON",
    "BEAUTY PARLOUR"
];


function update_ignore_pricing_rule(frm) {
    const should_ignore = TARGET_PRICE_LISTS.includes(
        frm.doc.selling_price_list
    );

    frm.set_value(
        "ignore_pricing_rule",
        should_ignore ? 1 : 0
    );
}


frappe.ui.form.on("Quotation", {
    refresh(frm) {
        update_ignore_pricing_rule(frm);
    },

    selling_price_list(frm) {
        update_ignore_pricing_rule(frm);
    }
});


frappe.ui.form.on("Sales Order", {
    refresh(frm) {
        update_ignore_pricing_rule(frm);
    },

    selling_price_list(frm) {
        update_ignore_pricing_rule(frm);
    }
});


frappe.ui.form.on("Sales Invoice", {
    refresh(frm) {
        update_ignore_pricing_rule(frm);
    },

    selling_price_list(frm) {
        update_ignore_pricing_rule(frm);
    }
});
