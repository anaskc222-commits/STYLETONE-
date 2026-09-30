app_name = "my_custom_app"
app_title = "STYLETONE"
app_publisher = "STYLETONE"
app_description = "STYLETONE custom Frappe application"
app_email = "your-email@example.com"
app_license = "MIT"


doc_events = {
    "Item Price": {
        "after_insert": (
            "my_custom_app.update_Pricelist.dispatcher."
            "on_item_price_change"
        ),
        "on_update": (
            "my_custom_app.update_Pricelist.dispatcher."
            "on_item_price_change"
        ),
    },

    "Purchase Invoice": {
        "on_submit": (
            "my_custom_app.update_Pricelist.dispatcher."
            "on_purchase_invoice_submit"
        ),
        "on_update_after_submit": (
            "my_custom_app.update_Pricelist.dispatcher."
            "on_purchase_invoice_submit"
        ),
    },

    "Pricing Rule": {
        "after_insert": (
            "my_custom_app.PRICELISTFOR_PRICING_RULE.dispatcher."
            "trigger_from_pricing_rule"
        ),
        "on_update": (
            "my_custom_app.PRICELISTFOR_PRICING_RULE.dispatcher."
            "trigger_from_pricing_rule"
        ),
    },

    # ---------------------------------------------------------------
    # Prevent Pricing Rule from changing the already-calculated rate
    # in Quotation, Sales Order and Sales Invoice
    # ---------------------------------------------------------------

    "Quotation": {
        "before_validate": (
            "my_custom_app.update_Pricelist.transaction_pricing."
            "set_ignore_pricing_rule"
        ),
    },

    "Sales Order": {
        "before_validate": (
            "my_custom_app.update_Pricelist.transaction_pricing."
            "set_ignore_pricing_rule"
        ),
    },

    "Sales Invoice": {
        "before_validate": (
            "my_custom_app.update_Pricelist.transaction_pricing."
            "set_ignore_pricing_rule"
        ),
    },
}
