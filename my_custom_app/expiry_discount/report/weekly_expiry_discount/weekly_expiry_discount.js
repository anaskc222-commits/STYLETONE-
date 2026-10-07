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

    ],

    onload: function(report) {

        report.page.add_inner_button(
            __("Generate / Refresh Data"),
            function() {

                frappe.confirm(
                    __("Generate the latest expiry calculation now?"),
                    function() {

                        frappe.call({
                            method:
                                "my_custom_app.expiry_discount.weekly_expiry.build_weekly_snapshot",

                            freeze: true,

                            freeze_message:
                                __("Calculating expiry data..."),

                            callback: function(r) {

                                if (!r.exc) {

                                    frappe.show_alert({
                                        message:
                                            __("Expiry data updated"),
                                        indicator: "green"
                                    });

                                    report.refresh();
                                }
                            }
                        });

                    }
                );

            }
        );
    }
};