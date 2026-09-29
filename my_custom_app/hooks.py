app_name = "my_custom_app"
app_title = "STYLETONE"
app_publisher = "STYLETONE"
app_description = "STYLETONE custom Frappe application"
app_email = "your-email@example.com"
app_license = "MIT"

doc_events = {
    "Item Price": {
        "after_insert": "my_custom_app.update_Pricelist.dispatcher.test_event",
        "on_update": "my_custom_app.update_Pricelist.dispatcher.test_event",
    },
}
