doc_events = {
    "Item Price": {
        "after_insert": "my_custom_app.update_Pricelist.dispatcher.background_update_b2b_price",
        "on_update": "my_custom_app.update_Pricelist.dispatcher.background_update_b2b_price"
    }
}
