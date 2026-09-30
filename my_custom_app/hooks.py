app_name = "my_custom_app"
app_title = "STYLETONE"
app_publisher = "STYLETONE"
app_description = "STYLETONE custom Frappe application"
app_email = "your-email@example.com"
app_license = "MIT"


doctype_js = {
    "Quotation": "public/js/transaction_pricing.js",
    "Sales Order": "public/js/transaction_pricing.js",
    "Sales Invoice": "public/js/transaction_pricing.js",
}


# ----------------------------------------------------------------------
# DOCTYPE CLASS EXTENSIONS
# ----------------------------------------------------------------------

extend_doctype_class = {
    "Quotation": [
        "my_custom_app.extensions.quotation.QuotationBatchPricingMixin"
    ]
}


# ----------------------------------------------------------------------
# DOCUMENT EVENTS
# ----------------------------------------------------------------------

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
