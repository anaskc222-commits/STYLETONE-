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


# ----------------------------------------------------------------------
# MAIN VALIDATION
# ----------------------------------------------------------------------

def validate_discount_limit(doc, method=None):
    """
    Validate selling discounts against Standard Buying price.

    Applies only to:
        B2B WHOLESALE
        SALOON
        BEAUTY PARLOUR

    Does NOT affect:
        Standard Selling
        POS

    Database usage:
        Maximum ONE Item Price query per document,
        and only when validation is actually needed.
    """

    # --------------------------------------------------------------
    # 1. Ignore POS transactions
    # --------------------------------------------------------------

    if (
        getattr(doc, "is_pos", 0)
        or getattr(doc, "pos_profile", None)
        or getattr(doc, "pos_opening_shift", None)
    ):
        return

    # --------------------------------------------------------------
    # 2. Only validate the three custom selling price lists
    # --------------------------------------------------------------

    selling_price_list = doc.get("selling_price_list")

    if selling_price_list not in TARGET_PRICE_LISTS:
        return

    minimum_margin = MINIMUM_MARGIN_PERCENT[selling_price_list]

    # --------------------------------------------------------------
    # 3. Get item rows
    # --------------------------------------------------------------

    items = [
        row
        for row in (doc.get("items") or [])
        if row.get("item_code")
    ]

    if not items:
        return

    # --------------------------------------------------------------
    # 4. Check whether a buying-price lookup is actually needed
    #
    # No discount + no 999 = no database query.
    # --------------------------------------------------------------

    needs_buying_prices = False

    for row in items:
        discount = flt(row.get("discount_percentage"))

        custom_code = flt(row.get("custom_code"))

        if discount > 0 or custom_code == SPECIAL_ZERO_MARGIN_CODE:
            needs_buying_prices = True
            break

    if not needs_buying_prices:
        return

    # --------------------------------------------------------------
    # 5. ONE database query
    # --------------------------------------------------------------

    buying_prices = get_buying_prices_for_document(items)

    # --------------------------------------------------------------
    # 6. Validate rows
    # --------------------------------------------------------------

    problems = []

    for row in items:

        discount = flt(row.get("discount_percentage"))
        custom_code = flt(row.get("custom_code"))

        # ----------------------------------------------------------
        # Normal rows
        # ----------------------------------------------------------

        if custom_code != SPECIAL_ZERO_MARGIN_CODE:

            # No discount -> nothing to validate
            if discount <= 0:
                continue

            selling_rate = flt(row.get("rate"))

            if selling_rate <= 0:
                problems.append({
                    "item_code": row.get("item_code"),
                    "selling_rate": selling_rate,
                    "discount": discount,
                    "reason": "Selling rate is missing or zero",
                })
                continue

            key = make_price_key(row)

            buying_rate = flt(buying_prices.get(key))

            if buying_rate <= 0:
                problems.append({
                    "item_code": row.get("item_code"),
                    "selling_rate": selling_rate,
                    "discount": discount,
                    "reason": "Standard Buying price not found",
                })
                continue

            price_list_rate = flt(row.get("price_list_rate"))

            if price_list_rate <= 0:
                problems.append({
                    "item_code": row.get("item_code"),
                    "selling_rate": selling_rate,
                    "discount": discount,
                    "reason": "Price List Rate is missing or zero",
                })
                continue

            # ------------------------------------------------------
            # Minimum selling price
            # ------------------------------------------------------

            minimum_selling_rate = buying_rate * (
                1 + minimum_margin / 100
            )

            # ------------------------------------------------------
            # Maximum permitted discount
            # ------------------------------------------------------

            maximum_discount = (
                (price_list_rate - minimum_selling_rate)
                / price_list_rate
            ) * 100

            maximum_discount = max(maximum_discount, 0)

            # ------------------------------------------------------
            # Discount exceeds allowed amount
            # ------------------------------------------------------

            if discount > maximum_discount + 0.0001:

                problems.append({
                    "item_code": row.get("item_code"),
                    "selling_rate": selling_rate,
                    "discount": discount,
                    "reason": (
                        f"Maximum allowed discount is "
                        f"{maximum_discount:.2f}%"
                    ),
                })

        # ----------------------------------------------------------
        # SPECIAL CODE 999
        #
        # Allows selling exactly at Standard Buying price.
        # ----------------------------------------------------------

        else:

            selling_rate = flt(row.get("rate"))

            key = make_price_key(row)

            buying_rate = flt(buying_prices.get(key))

            # ------------------------------------------------------
            # Buying price missing
            # ------------------------------------------------------

            if buying_rate <= 0:

                problems.append({
                    "item_code": row.get("item_code"),
                    "selling_rate": selling_rate,
                    "discount": discount,
                    "reason": "Standard Buying price not found",
                })

                continue

            # ------------------------------------------------------
            # Selling rate invalid
            # ------------------------------------------------------

            if selling_rate <= 0:

                problems.append({
                    "item_code": row.get("item_code"),
                    "selling_rate": selling_rate,
                    "discount": discount,
                    "reason": "Selling rate is missing or zero",
                })

                continue

            # ------------------------------------------------------
            # Cannot sell below Standard Buying
            # ------------------------------------------------------

            if selling_rate < buying_rate:

                problems.append({
                    "item_code": row.get("item_code"),
                    "selling_rate": selling_rate,
                    "discount": discount,
                    "reason": "Selling below Standard Buying price",
                })

                continue

            # ------------------------------------------------------
            # Recalculate actual discount
            #
            # ERPNext discount formula:
            #
            # (price_list_rate - rate) / price_list_rate * 100
            # ------------------------------------------------------

            price_list_rate = flt(row.get("price_list_rate"))

            if price_list_rate > 0:

                actual_discount = (
                    (price_list_rate - buying_rate)
                    / price_list_rate
                ) * 100

                row.discount_percentage = actual_discount
                row.rate = buying_rate

    # --------------------------------------------------------------
    # 7. If everything is valid, stop
    # --------------------------------------------------------------

    if not problems:
        return

    # --------------------------------------------------------------
    # 8. Show native Frappe table
    # --------------------------------------------------------------

    show_margin_error(
        problems,
        selling_price_list,
        minimum_margin,
    )


# ----------------------------------------------------------------------
# GET STANDARD BUYING PRICES
# ----------------------------------------------------------------------

def get_buying_prices_for_document(items):
    """
    Get all required Standard Buying prices in ONE database query.

    Matching:
        Item Code
        UOM
        Batch No

    Latest Item Price wins.
    """

    item_codes = list({
        row.get("item_code")
        for row in items
        if row.get("item_code")
    })

    if not item_codes:
        return {}

    price_rows = frappe.get_all(
        "Item Price",
        filters={
            "price_list": SOURCE_PRICE_LIST,
            "item_code": ["in", item_codes],
        },
        fields=[
            "item_code",
            "uom",
            "batch_no",
            "price_list_rate",
            "creation",
        ],
        order_by="creation desc",
        limit_page_length=0,
    )

    result = {}

    for price in price_rows:

        key = (
            price.item_code or "",
            price.uom or "",
            price.batch_no or "",
        )

        # First/latest record wins
        if key not in result:
            result[key] = flt(price.price_list_rate)

    return result


# ----------------------------------------------------------------------
# PRICE KEY
# ----------------------------------------------------------------------

def make_price_key(row):
    """
    Match Item Price using:
        Item Code
        UOM
        Batch No
    """

    return (
        row.get("item_code") or "",
        row.get("uom") or "",
        row.get("batch_no") or "",
    )


# ----------------------------------------------------------------------
# NATIVE FRAPPE ERROR TABLE
# ----------------------------------------------------------------------

def show_margin_error(
    problems,
    selling_price_list,
    minimum_margin,
):
    """
    Display validation errors using Frappe's native table renderer.

    Buying Rate is intentionally NOT displayed.
    """

    table = [
        [
            "Item",
            "Selling Rate",
            "Discount",
            "Reason",
        ]
    ]

    for problem in problems:

        table.append([
            problem["item_code"],
            f'{flt(problem["selling_rate"]):.2f}',
            f'{flt(problem["discount"]):.2f}%',
            problem["reason"],
        ])

    frappe.msgprint(
        table,
        title=(
            f"Margin validation failed — "
            f"{selling_price_list} "
            f"(Minimum margin: {minimum_margin:.0f}%)"
        ),
        indicator="red",
        as_table=True,
        raise_exception=True,
    )
