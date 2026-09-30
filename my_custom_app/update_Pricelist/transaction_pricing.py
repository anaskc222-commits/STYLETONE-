TARGET_PRICE_LISTS = {
    "B2B WHOLESALE",
    "SALOON",
    "BEAUTY PARLOUR",
}


def set_ignore_pricing_rule(doc, method=None):
    """
    For the custom selling Price Lists, prevent ERPNext from applying
    the Pricing Rule a second time.

    The rate already stored in Item Price is used as the transaction rate.

    This function intentionally performs no database queries and does not
    enqueue any background jobs.
    """

    if not doc:
        return

    selling_price_list = doc.get("selling_price_list")

    if selling_price_list not in TARGET_PRICE_LISTS:
        return

    doc.ignore_pricing_rule = 1
