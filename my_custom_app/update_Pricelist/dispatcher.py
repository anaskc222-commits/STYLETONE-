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
    frappe.enqueue(
        method=(
            "my_custom_app.update_Pricelist.dispatcher."
            "process_b2b_price_background"
        ),
        queue="long",
        enqueue_after_commit=True,
        job_name=f"b2b_price_{doc.name}",
        item_price_name=doc.name,
    )


def process_b2b_price_background(item_price_name):
    """
    Background worker.

    Reloads the latest committed Standard Buying Item Price,
    loads active B2B Pricing Rules,
    finds the winning rule,
    calculates the B2B price,
    and updates the B2B Item Price.

    If the source Item Price was deleted, nothing is changed.
    Therefore the existing B2B price remains unchanged.
    """

    if not item_price_name:
        return

    # Reload latest committed source Item Price.
    source_price = frappe.db.get_value(
        "Item Price",
        item_price_name,
        [
            "name",
            "item_code",
            "price_list",
            "price_list_rate",
            "uom",
            "batch_no",
            "currency",
        ],
        as_dict=True,
    )

    # Source Item Price may have been deleted.
    # Keep the existing B2B price unchanged.
    if not source_price:
        return

    # Make sure this is still the source price list.
    if source_price.price_list != SOURCE_PRICE_LIST:
        return

    if not source_price.item_code:
        return

    # Validate buying rate.
    try:
        buying_rate = float(source_price.price_list_rate or 0)
    except (TypeError, ValueError):
        return

    if buying_rate <= 0:
        return

    # Load Item information.
    item_data = frappe.db.get_value(
        "Item",
        source_price.item_code,
        [
            "item_group",
            "brand",
            "disabled",
        ],
        as_dict=True,
    )

    if not item_data:
        return

    # Do not process disabled Items.
    if item_data.disabled:
        return

    # Load active Pricing Rules.
    rules = load_active_rules()

    if not rules:
        return

    # Find the applicable/winning rule.
    winning_rule = find_winning_rule(
        rules=rules,
        item_code=source_price.item_code,
        item_group=item_data.item_group or "",
        brand=item_data.brand or "",
    )

    if not winning_rule:
        return

    # Only percentage margins are supported.
    if winning_rule.margin_type != "Percentage":
        return

    try:
        margin = float(
            winning_rule.margin_rate_or_amount or 0
        )
    except (TypeError, ValueError):
        return

    # Calculate
