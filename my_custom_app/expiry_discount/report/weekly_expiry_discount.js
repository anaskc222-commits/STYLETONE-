frappe.query_reports["Weekly Expiry Discount"] = {
    filters: [
        {
            fieldname: "as_of_date",
            label: "As of Date",
            fieldtype: "Date",
            default: frappe.datetime.get_today()
        },

        {
            fieldname: "warehouse",
            label: "Warehouse",
            fieldtype: "Link",
            options: "Warehouse",
            default: "Arakkinar Store - ST"
        }
    ]
};