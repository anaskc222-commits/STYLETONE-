import frappe
from frappe.utils import flt


# ----------------------------------------------------------------------
# SETTINGS
# ----------------------------------------------------------------------

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
        Maximum ONE Item Price query per document.
    """

    # --------------------------------------------------------------
    # 1. Skip POS
    # --------------------------------------------------------------

    if (
        getattr(doc, "is_pos", 0)
        or getattr(doc, "pos_profile", None)
        or getattr(doc, "pos_opening_shift", None)
    ):
        return

    # --------------------------------------------------------------
    # 2. Only target selling price lists
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
    # 4. Determine whether buying prices are required
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
    # 5. ONE DATABASE QUERY
    # --------------------------------------------------------------

    buying_prices = get_buying_prices_for_document(items)

    # --------------------------------------------------------------
    # 6. Validate all rows in memory
    # --------------------------------------------------------------

    problems = []

    for row in items:

        discount = flt(row.get("discount_percentage"))
        custom_code = flt(row.get("custom_code"))

        # ==========================================================
        # NORMAL DISCOUNT VALIDATION
        # ==========================================================

        if custom_code != SPECIAL_ZERO_MARGIN_CODE:

            # No discount -> nothing to validate
            if discount <= 0:
                continue

            selling_rate = flt(row.get("rate"))

            # ------------------------------------------------------
            # Selling rate missing
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
            # Find Standard Buying price
            # ------------------------------------------------------

            key = make_price_key(row)

            buying_rate = flt(
                buying_prices.get(key)
            )

            # ------------------------------------------------------
            # Buying price not found
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
            # Price List Rate
            # ------------------------------------------------------

            price_list_rate = flt(
                row.get("price_list_rate")
            )

            if price_list_rate <= 0:

                problems.append({
                    "item_code": row.get("item_code"),
                    "selling_rate": selling_rate,
                    "discount": discount,
                    "reason": "Price List Rate is missing or zero",
                })

                continue

            # ------------------------------------------------------
            # Minimum selling rate
            # ------------------------------------------------------

            minimum_selling_rate = buying_rate * (
                1 + minimum_margin / 100
            )

            # ------------------------------------------------------
            # Maximum allowed discount
            # ------------------------------------------------------

            maximum_discount = (
                (price_list_rate - minimum_selling_rate)
                / price_list_rate
            ) * 100

            maximum_discount = max(
                maximum_discount,
                0
            )

            # ------------------------------------------------------
            # Discount too high
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

        # ==========================================================
        # SPECIAL CODE 999
        # ==========================================================

        else:

            selling_rate = flt(row.get("rate"))

            key = make_price_key(row)

            buying_rate = flt(
                buying_prices.get(key)
            )

            # ------------------------------------------------------
            # Buying price not found
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
            # Selling rate missing
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
            # ------------------------------------------------------

            price_list_rate = flt(
                row.get("price_list_rate")
            )

            if price_list_rate > 0:

                actual_discount = (
                    (price_list_rate - buying_rate)
                    / price_list_rate
                ) * 100

                row.discount_percentage = actual_discount
                row.rate = buying_rate

    # --------------------------------------------------------------
    # 7. Everything valid
    # --------------------------------------------------------------

    if not problems:
        return

    # --------------------------------------------------------------
    # 8. Show native Frappe table and stop save
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
    Get Standard Buying prices for ALL document items
    using ONE database query.

    Matching priority:

        1. Item + UOM + Batch
        2. Item + UOM + blank Batch
        3. Item + blank UOM + Batch
        4. Item + blank UOM + blank Batch

    All matching after the query happens in memory.
    """

    # --------------------------------------------------------------
    # Collect unique item codes
    # --------------------------------------------------------------

    item_codes = list({
        row.get("item_code")
        for row in items
        if row.get("item_code")
    })

    if not item_codes:
        return {}

    # ==============================================================
    # ONE DATABASE QUERY
    # ==============================================================

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

    # --------------------------------------------------------------
    # Group Item Prices by Item Code
    # --------------------------------------------------------------

    prices_by_item = {}

    for price in price_rows:

        item_code = price.item_code

        if not item_code:
            continue

        prices_by_item.setdefault(
            item_code,
            []
        ).append(price)

    # --------------------------------------------------------------
    # Match each transaction row
    # --------------------------------------------------------------

    result = {}

    for row in items:

        item_code = row.get("item_code")

        if not item_code:
            continue

        row_uom = row.get("uom") or ""
        row_batch = row.get("batch_no") or ""

        candidates = prices_by_item.get(
            item_code,
            []
        )

        if not candidates:
            continue

        selected_price = None

        # ==========================================================
        # PRIORITY 1
        # EXACT ITEM + UOM + BATCH
        # ==========================================================

        for price in candidates:

            price_uom = price.uom or ""
            price_batch = price.batch_no or ""

            if (
                price_uom == row_uom
                and price_batch == row_batch
            ):
                selected_price = price
                break

        # ==========================================================
        # PRIORITY 2
        # SAME ITEM + SAME UOM + BLANK BATCH
        #
        # This is the important fallback you requested.
        # ==========================================================

        if selected_price is None:

            for price in candidates:

                price_uom = price.uom or ""
                price_batch = price.batch_no or ""

                if (
                    price_uom == row_uom
                    and not price_batch
                ):
                    selected_price = price
                    break

        # ==========================================================
        # PRIORITY 3
        # SAME ITEM + BLANK UOM + SAME BATCH
        # ==========================================================

        if selected_price is None:

            for price in candidates:

                price_uom = price.uom or ""
                price_batch = price.batch_no or ""

                if (
                    not price_uom
                    and price_batch == row_batch
                ):
                    selected_price = price
                    break

        # ==========================================================
        # PRIORITY 4
        # SAME ITEM + BLANK UOM + BLANK BATCH
        # ==========================================================

        if selected_price is None:

            for price in candidates:

                price_uom = price.uom or ""
                price_batch = price.batch_no or ""

                if (
                    not price_uom
                    and not price_batch
                ):
                    selected_price = price
                    break

        # ----------------------------------------------------------
        # Store selected price against THIS transaction row
        # ----------------------------------------------------------

        if selected_price is not None:

            result[
                make_price_key(row)
            ] = flt(
                selected_price.price_list_rate
            )

    return result


# ----------------------------------------------------------------------
# MAKE PRICE KEY
# ----------------------------------------------------------------------

def make_price_key(row):
    """
    Key for the current transaction row.
    """

    return (
        row.get("item_code") or "",
        row.get("uom") or "",
        row.get("batch_no") or "",
    )


# ----------------------------------------------------------------------
# DISPLAY ERROR
# ----------------------------------------------------------------------

def show_margin_error(
    problems,
    selling_price_list,
    minimum_margin,
):
    """
    Show only failed items.

    Buying Rate is intentionally hidden.
    Uses native Frappe table rendering.
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
