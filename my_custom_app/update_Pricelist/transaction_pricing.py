import frappe
from frappe.utils import flt


SOURCE_PRICE_LIST = "Standard Buying"

MINIMUM_MARGIN_PERCENT = {
    "B2B WHOLESALE": 5.0,
    "SALOON": 7.0,
    "BEAUTY PARLOUR": 10.0,
}

SPECIAL_ZERO_MARGIN_CODE = 999.0

TARGET_PRICE_LISTS = set(MINIMUM_MARGIN_PERCENT)


def validate_discount_limit(doc, method=None):
    """
    Validate discounts for custom selling Price Lists.

    B2B WHOLESALE  -> minimum 5% margin
    SALOON         -> minimum 7% margin
    BEAUTY PARLOUR -> minimum 10% margin

    custom_code = 999:
        Allows selling at Standard Buying price.
        Actual discount is recalculated automatically.

    Standard Selling and POS are untouched.

    Performance:
        Maximum ONE Item Price database query per document.
        No query when validation is not required.
    """

    # ============================================================
    # 1. IGNORE POS
    # ============================================================

    if (
        doc.get("is_pos")
        or doc.get("pos_profile")
        or doc.get("pos_opening_shift")
    ):
        return

    # ============================================================
    # 2. ONLY CUSTOM SELLING PRICE LISTS
    # ============================================================

    selling_price_list = doc.get("selling_price_list")

    if selling_price_list not in TARGET_PRICE_LISTS:
        return

    # ============================================================
    # 3. CHECK WHETHER VALIDATION IS REQUIRED
    # ============================================================

    items = []
    needs_buying_prices = False

    for row in doc.get("items") or []:

        if not row.get("item_code"):
            continue

        discount = flt(
            row.get("discount_percentage")
        )

        custom_code = flt(
            row.get("custom_code")
        )

        items.append(row)

        # Only query Standard Buying when necessary
        if (
            discount > 0
            or custom_code == SPECIAL_ZERO_MARGIN_CODE
        ):
            needs_buying_prices = True

    # No discount and no 999 code
    # Therefore NO database query.
    if not needs_buying_prices:
        return

    # ============================================================
    # 4. ONE DATABASE QUERY
    # ============================================================

    buying_prices = get_buying_prices_for_document(items)

    minimum_margin = MINIMUM_MARGIN_PERCENT[
        selling_price_list
    ]

    problems = []

    # ============================================================
    # 5. VALIDATE ITEMS
    # ============================================================

    for row in items:

        discount = flt(
            row.get("discount_percentage")
        )

        custom_code = flt(
            row.get("custom_code")
        )

        # Nothing to validate
        if (
            discount <= 0
            and custom_code != SPECIAL_ZERO_MARGIN_CODE
        ):
            continue

        item_code = row.get("item_code") or ""

        buying_rate = flt(
            buying_prices.get(
                make_price_key(row),
                0.0
            )
        )

        selling_rate = get_selling_rate(row)

        # ========================================================
        # SPECIAL CODE 999
        # ========================================================

        if custom_code == SPECIAL_ZERO_MARGIN_CODE:

            # Buying price missing
            if buying_rate <= 0:

                problems.append({
                    "item_code": item_code,
                    "buying_rate": 0.0,
                    "selling_rate": selling_rate,
                    "discount": discount,
                    "reason": (
                        "Standard Buying price not found"
                    ),
                })

                continue

            # Selling rate missing
            if selling_rate <= 0:

                problems.append({
                    "item_code": item_code,
                    "buying_rate": buying_rate,
                    "selling_rate": selling_rate,
                    "discount": discount,
                    "reason": "Selling rate is 0",
                })

                continue

            # Selling below buying
            if selling_rate < buying_rate:

                problems.append({
                    "item_code": item_code,
                    "buying_rate": buying_rate,
                    "selling_rate": selling_rate,
                    "discount": discount,
                    "reason": (
                        "Selling below Standard Buying price"
                    ),
                })

                continue

            # ----------------------------------------------------
            # Recalculate actual discount
            # ----------------------------------------------------

            price_list_rate = flt(
                row.get("price_list_rate")
            )

            if price_list_rate > 0:

                actual_discount = (
                    (
                        price_list_rate
                        - buying_rate
                    )
                    / price_list_rate
                ) * 100

                row.discount_percentage = actual_discount
                row.rate = buying_rate

            continue

        # ========================================================
        # NORMAL DISCOUNT VALIDATION
        # ========================================================

        if discount <= 0:
            continue

        # Selling rate missing
        if selling_rate <= 0:

            problems.append({
                "item_code": item_code,
                "buying_rate": buying_rate,
                "selling_rate": selling_rate,
                "discount": discount,
                "reason": "Selling rate is 0",
            })

            continue

        # Buying price missing
        if buying_rate <= 0:

            problems.append({
                "item_code": item_code,
                "buying_rate": 0.0,
                "selling_rate": selling_rate,
                "discount": discount,
                "reason": (
                    "Standard Buying price not found"
                ),
            })

            continue

        # --------------------------------------------------------
        # Price List Rate
        # --------------------------------------------------------

        price_list_rate = flt(
            row.get("price_list_rate")
        )

       
