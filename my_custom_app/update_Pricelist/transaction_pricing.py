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
    Validate discounts against Standard Buying prices.

    Selling price:
        Uses ERPNext's existing row.price_list_rate.

    Buying price:
        Uses one bulk Item Price query with batch/UOM fallbacks.

    POS documents and non-target selling price lists are skipped.
    """

    # Skip POS and POS-profile documents.
    if (
        getattr(doc, "is_pos", 0)
        or getattr(doc, "pos_profile", None)
        or getattr(doc, "pos_opening_shift", None)
    ):
        return

    selling_price_list = doc.get("selling_price_list")

    if selling_price_list not in TARGET_PRICE_LISTS:
        return

    minimum_margin = MINIMUM_MARGIN_PERCENT[selling_price_list]

    items = [
        row
        for row in (doc.get("items") or [])
        if row.get("item_code")
    ]

    if not items:
        return

    # Query buying prices only if a discount or special code needs validation.
    if not any(
        flt(row.get("discount_percentage")) > 0
        or flt(row.get("custom_code")) == SPECIAL_ZERO_MARGIN_CODE
        for row in items
    ):
        return

    # One bulk query for all document items.
    buying_prices = get_buying_prices_for_document(items)

    problems = []

    for row in items:
        discount = flt(row.get("discount_percentage"))
        custom_code = flt(row.get("custom_code"))
        selling_rate = flt(row.get("rate"))

        key = make_price_key(row)
        buying_rate = flt(buying_prices.get(key))

        # --------------------------------------------------------------
        # SPECIAL CODE 999
        # --------------------------------------------------------------

        if custom_code == SPECIAL_ZERO_MARGIN_CODE:

            if buying_rate <= 0:
                problems.append({
                    "item_code": row.get("item_code"),
                    "selling_rate": selling_rate,
                    "discount": discount,
                    "reason": "Standard Buying price not found",
                })
                continue

            if selling_rate <= 0:
                problems.append({
                    "item_code": row.get("item_code"),
                    "selling_rate": selling_rate,
                    "discount": discount,
                    "reason": "Selling rate is missing or zero",
                })
                continue

            if selling_rate < buying_rate:
                problems.append({
                    "item_code": row.get("item_code"),
                    "selling_rate": selling_rate,
                    "discount": discount,
                    "reason": "Selling below Standard Buying price",
                })
                continue

            # Preserve existing behavior: set selling rate to buying rate.
            price_list_rate = flt(row.get("price_list_rate"))

            if price_list_rate > 0:
                actual_discount = (
                    (price_list_rate - buying_rate)
                    / price_list_rate
                ) * 100

                row.discount_percentage = actual_discount
                row.rate = buying_rate

            continue

        # --------------------------------------------------------------
        # NORMAL DISCOUNT VALIDATION
        # --------------------------------------------------------------

        if discount <= 0:
            continue

        if selling_rate <= 0:
            problems.append({
                "item_code": row.get("item_code"),
                "selling_rate": selling_rate,
                "discount": discount,
                "reason": "Selling rate is missing or zero",
            })
            continue

        if buying_rate <= 0:
            problems.append({
                "item_code": row.get("item_code"),
                "selling_rate": selling_rate,
                "discount": discount,
                "reason": "Standard Buying price not found",
            })
            continue

        # Keep ERPNext's current selected-selling-price-list rate.
        price_list_rate = flt(row.get("price_list_rate"))

        if price_list_rate <= 0:
            problems.append({
                "item_code": row.get("item_code"),
                "selling_rate": selling_rate,
                "discount": discount,
                "reason": "Price List Rate is missing or zero",
            })
            continue

        minimum_selling_rate = buying_rate * (
            1 + minimum_margin / 100
        )

        maximum_discount = (
            (price_list_rate - minimum_selling_rate)
            / price_list_rate
        ) * 100

        maximum_discount = max(maximum_discount, 0)

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

    if problems:
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
    Retrieve Standard Buying prices in one database query.

    Priority:
        1. Exact item + batch + UOM
        2. Exact item + batch + blank UOM
        3. Exact item + blank batch + UOM
        4. Exact item + blank batch + blank UOM

    Matching is performed in memory.
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

    prices_by_item = {}

    for price in price_rows:
        if price.item_code:
            prices_by_item.setdefault(
                price.item_code, []
            ).append(price)

    result = {}

    for row in items:
        item_code = row.get("item_code")

        if not item_code:
            continue

        row_uom = row.get("uom") or ""
        row_batch = row.get("batch_no") or ""

        candidates = prices_by_item.get(item_code, [])

        if not candidates:
            continue

        selected_price = None

        # Batch-specific records always take priority over blank-batch
        # records. Within each batch level, prefer the exact UOM.
        for batch in (row_batch, ""):
            for uom in (row_uom, ""):
                for price in candidates:
                    if (
                        (price.batch_no or "") == batch
                        and (price.uom or "") == uom
                        and flt(price.price_list_rate) > 0
                    ):
                        selected_price = price
                        break

                if selected_price is not None:
                    break

            if selected_price is not None:
                break

        if selected_price is not None:
            result[make_price_key(row)] = flt(
                selected_price.price_list_rate
            )

    return result


# ----------------------------------------------------------------------
# TRANSACTION ROW KEY
# ----------------------------------------------------------------------

def make_price_key(row):
    return (
        row.get("item_code") or "",
        row.get("uom") or "",
        row.get("batch_no") or "",
    )


# ----------------------------------------------------------------------
# DISPLAY VALIDATION ERRORS
# ----------------------------------------------------------------------

def show_margin_error(
    problems,
    selling_price_list,
    minimum_margin,
):
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