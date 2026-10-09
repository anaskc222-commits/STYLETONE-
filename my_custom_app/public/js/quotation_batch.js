const item_args = {
    ...existing_item_args,
    item_code: item_code,
    batch_no: batch_no || "",
    warehouse: warehouse,
    doctype: "Quotation"
};

const response = await frappe.call({
    method: "erpnext.stock.get_item_details.get_item_details",
    args: {
        args: JSON.stringify(item_args),
        doc: JSON.stringify(frm.doc)
    }
});

if (response.exc || !response.message) {
    throw new Error("ERPNext could not load item details.");
}

const details = response.message;