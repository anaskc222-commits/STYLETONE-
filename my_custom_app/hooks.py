doc_events = {
    "Item Price": {
        "after_insert": "my_custom_app.update_Pricelist.dispatcher.on_item_price_change",
        "on_update": "my_custom_app.update_Pricelist.dispatcher.on_item_price_change",
    },
    "Pricing Rule": {
        "after_insert": "my_custom_app.b2b_pricing.dispatcher.trigger_from_pricing_rule",
        "on_update": "my_custom_app.b2b_pricing.dispatcher.trigger_from_pricing_rule",
    },
}
