app_name = "styletone"
app_title = "STYLETONE"
app_publisher = "STYLETONE"
app_description = "STYLETONE custom Frappe application"
app_email = "your-email@example.com"
app_license = "MIT"

doc_events = {
    "Item Price": {
        "after_insert": "my_custom_app.update_Pricelist.dispatcher.on_item_price_change",
        "on_update": "my_custom_app.update_Pricelist.dispatcher.on_item_price_change",
    },
    "Pricing Rule": {
        "after_insert": "my_custom_app.PRICELISTFOR_PRICING_RULE.dispatcher.trigger_from_pricing_rule",
        "on_update": "my_custom_app.PRICELISTFOR_PRICING_RULE.dispatcher.trigger_from_pricing_rule",
    },
}
