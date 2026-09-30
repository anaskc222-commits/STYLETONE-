TARGET_PRICE_LISTS = {
    "B2B WHOLESALE",
    "SALOON",
    "BEAUTY PARLOUR",
}


def set_ignore_pricing_rule(doc, method=None):
    """
    Only affect transactions using the three custom selling Price Lists.

    Standard Selling:
        Completely untouched.

    POS:
        Completely untouched because POS uses Standard Selling in this setup.

    All other Price Lists:
        Completely untouched.

    No database queries.
    No background jobs.
    """

    if not doc:
        return

    selling_price_list = doc.get("selling_price_list")

    if selling_price_list not in TARGET_PRICE_LISTS:
        return

    doc.ignore_pricing_rule = 1
