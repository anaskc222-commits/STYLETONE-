app_name = "my_custom_app"
app_title = "STYLETONE"
app_publisher = "STYLETONE"
app_description = "STYLETONE custom Frappe application"
app_email = "your-email@example.com"
app_license = "MIT"

doctype_js = {
    "Sales Invoice": "public/js/sales_invoice_batch.js",
}


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

    "Quotation": {
        "validate": (
            "my_custom_app.update_Pricelist.transaction_pricing."
            "validate_discount_limit"
        ),
    },

    "Sales Order": {
        "validate": (
            "my_custom_app.update_Pricelist.transaction_pricing."
            "validate_discount_limit"
        ),
    },

    "Sales Invoice": {
        "validate": (
            "my_custom_app.update_Pricelist.transaction_pricing."
            "validate_discount_limit"
        ),
    },
}
