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

    Special code 999:
        Sell exactly at Standard Buying price.
        The actual discount percentage is calculated automatically.

    Standard Selling and all other Price Lists are untouched.
    """

    if not doc:
        return

    price_list = doc.get("selling_price_list")

    if price_list not in MINIMUM_MARGIN_PERCENT:
        return

    items = [
        row for row in (doc.get("items") or [])
        if row.item_code
    ]

    if not items:
        return

    # ----------------------------------------------------------
    # Check whether a database lookup is actually needed.
    # ----------------------------------------------------------

    needs_buying_prices = False

    for row in items:
        discount = get_number(row.discount_percentage)

        if discount is None:
            continue

        if discount > 0:
            needs_buying_prices = True
            break

    if not needs_buying_prices:
        return

    # ----------------------------------------------------------
    # ONE Standard Buying query for the whole document.
    # ----------------------------------------------------------

    buying_prices = get_buying_prices_for_document(items)

    minimum_margin = float(
        MINIMUM_MARGIN_PERCENT[price_list]
    )

    for row in items:

        discount = get_number(row.discount_percentage)

        if discount is None:
            continue

        # ------------------------------------------------------
        # Special 999 code
        # ------------------------------------------------------

        if abs(discount - SPECIAL_ZERO_MARGIN_CODE) < 0.000001:
            key = make_price_key(
                row.item_code,
                row.uom,
                row.batch_no,
            )

            buying_rate = buying_prices.get(key, 0.0)

            if buying_rate <= 0:
                frappe.throw(
                    (
                        "Special code <b>{code}</b> cannot be used "
                        "for item <b>{item}</b> because a valid "
                        "Standard Buying price was not found for "
                        "the same UOM and Batch."
                    ).format(
                        code=int(SPECIAL_ZERO_MARGIN_CODE),
                        item=row.item_code,
                    )
                )

            selling_rate = get_selling_rate(row)

            if selling_rate <= 0:
                frappe.throw(
                    (
                        "Special code <b>{code}</b> cannot be used "
                        "for item <b>{item}</b> because the "
                        "selling Price List rate is not available."
                    ).format(
                        code=int(SPECIAL_ZERO_MARGIN_CODE),
                        item=row.item_code,
                    )
                )

            if selling_rate < buying_rate:
                frappe.throw(
                    (
                        "Special code <b>{code}</b> cannot be used "
                        "for item <b>{item}</b> because the "
                        "{price_list} price ({selling:.2f}) is below "
                        "Standard Buying ({buying:.2f})."
                    ).format(
                        code=int(SPECIAL_ZERO_MARGIN_CODE),
                        item=row.item_code,
                        price_list=price_list,
                        selling=selling_rate,
                        buying=buying_rate,
                    )
                )

            actual_discount = (
                (selling_rate - buying_rate)
                / selling_rate
            ) * 100

            if actual_discount < 0:
                actual_discount = 0

            row.discount_percentage = round(
                actual_discount,
                6,
            )

            row.rate = buying_rate

            continue

        # ------------------------------------------------------
        # Normal discount validation
        # ------------------------------------------------------

        if discount <= 0:
            continue

        selling_rate = get_selling_rate(row)

        if selling_rate <= 0:
            continue

        key = make_price_key(
            row.item_code,
            row.uom,
            row.batch_no,
        )

        buying_rate = buying_prices.get(key, 0.0)

        # No matching Standard Buying price:
        # do not interfere with the transaction.
        if buying_rate <= 0:
            continue

        minimum_allowed_rate = buying_rate * (
            1 + (minimum_margin / 100)
        )

        if selling_rate <= minimum_allowed_rate:
            max_discount = 0.0
        else:
            max_discount = (
                (selling_rate - minimum_allowed_rate)
                / selling_rate
            ) * 100

        max_discount = round(max_discount, 6)

        if discount > max_discount + 0.000001:
            frappe.throw(
                (
                    "<b>Discount exceeds the allowed limit</b>"
                    "<br><br>"
                    "Item: <b>{item}</b>"
                    "<br>"
                    "Price List: <b>{price_list}</b>"
                    "<br>"
                    "Standard Buying Rate: "
                    "<b>{buying:.2f}</b>"
                    "<br>"
                    "Price List Rate: "
                    "<b>{selling:.2f}</b>"
                    "<br>"
                    "Minimum Required Margin: "
                    "<b>{margin:.2f}%</b>"
                    "<br>"
                    "Maximum Allowed Discount: "
                    "<b>{maximum:.2f}%</b>"
                    "<br>"
                    "Entered Discount: "
                    "<b>{entered:.2f}%</b>"
                ).format(
                    item=row.item_code,
                    price_list=price_list,
                    buying=buying_rate,
                    selling=selling_rate,
                    margin=minimum_margin,
                    maximum=max_discount,
                    entered=discount,
                )
            )


def get_buying_prices_for_document(items):
    """
    Fetch Standard Buying prices once for all item codes
    in the current document.

    Matching is done using:
        Item Code + UOM + Batch

    This function performs ONE database query.
    """

    item_codes = {
        row.item_code
        for row in items
        if row.item_code
    }

    if not item_codes:
        return {}

    prices = frappe.get_all(
        "Item Price",
        filters={
            "price_list": SOURCE_PRICE_LIST,
            "item_code": ["in", list(item_codes)],
        },
        fields=[
            "name",
            "item_code",
            "price_list_rate",
            "uom",
            "batch_no",
            "creation",
        ],
        order_by="creation desc",
        ignore_permissions=True,
        limit_page_length=0,
    )

    result = {}

    for price in prices:
        rate = get_number(price.price_list_rate)

        if rate is None or rate <= 0:
            continue

        key = make_price_key(
            price.item_code,
            price.uom,
            price.batch_no,
        )

        # Keep the newest matching Item Price.
        if key not in result:
            result[key] = rate

    return result


def make_price_key(item_code, uom=None, batch_no=None):
    return (
        item_code or "",
        uom or "",
        batch_no or "",
    )


def get_selling_rate(row):
    price_list_rate = get_number(
        row.price_list_rate
    )

    if price_list_rate is not None:
        if price_list_rate > 0:
            return price_list_rate

    rate = get_number(row.rate)

    if rate is not None and rate > 0:
        return rate

    return 0.0


def get_number(value):
    if value is None:
        return None

    try:
        return float(value)
    except (TypeError, ValueError):
        return None
