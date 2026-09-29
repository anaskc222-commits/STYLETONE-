import frappe


B2B_PRICE_LIST = "B2B WHOLESALE"
SOURCE_PRICE_LIST = "Standard Buying"
B2B_CUSTOMER_GROUP = "Wholesale Store Clients"


RULE_SPECIFICITY = {
    "Item Code": 1,
    "Brand": 2,
    "Item Group": 3,
    "Transaction": 4,
    "": 4,
    None: 4,
}


def on_item_price_change(doc, method=None):
    """
    Lightweight Item Price event handler.

    Only Standard Buying prices are processed.
    B2B output prices are ignored.

    The actual pricing calculation runs in the background.
    """

    if not doc or not doc.item_code:
        return

    # Never process generated B2B prices.
    if doc.price_list == B2B_PRICE_LIST:
        return

    # Ignore every other price list.
    if doc.price_list != SOURCE_PRICE_LIST:
        return

    # On update, only enqueue when pricing-relevant
    # fields actually changed.
    if method == "on_update":
        relevant_fields = (
            "price_list_rate",
            "currency",
            "uom",
            "batch_no",
        )

        if not any(
            doc.has_value_changed(field)
            for field in relevant_fields
        ):
            return

    # Validate source buying rate.
    try:
        buying_rate = float(doc.price_list_rate or 0)
    except (TypeError, ValueError):
        return

    if buying_rate <= 0:
        return

    # Pass only the Item Price name.
    # The worker reloads the latest committed record.
   
