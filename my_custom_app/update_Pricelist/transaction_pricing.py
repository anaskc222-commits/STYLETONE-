import frappe


SOURCE_PRICE_LIST = "Standard Buying"


MINIMUM_MARGIN_PERCENT = {
    "B2B WHOLESALE": 5.0,
    "SALOON": 7.0,
    "BEAUTY PARLOUR": 10.0,
}


SPECIAL_ZERO_MARGIN_CODE = 999.0


def validate_discount_limit(doc, method=None):
    """
    Validate discount limits for the three custom selling Price Lists.

    B2B WHOLESALE  -> minimum 5% margin
    SALOON         -> minimum 7% margin
    BEAUTY PARLOUR -> minimum 10% margin

    Special code:
        custom_code = 999

        Sell exactly at Standard Buying price.
        The actual discount percentage is calculated automatically.

    Multiple invalid items are displayed together in one table.

    Standard Selling and all other Price Lists are untouched.
    POS invoices are completely ignored.
    """

    if not doc:
        return

    # ----------------------------------------------------------
    # Ignore POS / POS Next
    # ----------------------------------------------------------

    if doc.get("pos_profile") or doc.get("pos_opening_shift"):
        return

    # ----------------------------------------------------------
    # Only process the three custom Selling Price Lists
    # ----------------------------------------------------------

    price_list = doc.get("selling_price_list")

    if price_list not in MINIMUM_MARGIN_PERCENT:
        return

    items = [
        row
        for row in (doc.get("items") or [])
        if row.item_code
    ]

    if not items:
        return

    # ----------------------------------------------------------
    # Check whether Standard Buying prices are required
    # ----------------------------------------------------------

    needs_buying_prices = False

    for row in items:

        special_code = get_number(
            row.get("custom_code")
        )

        if (
            special_code is not None
            and abs(
                special_code - SPECIAL_ZERO_MARGIN_CODE
            ) < 0.000001
        ):
            needs_buying_prices = True
           
