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

    Standard Selling and all other Price Lists are untouched.
    POS invoices are completely ignored.
    """

    if not doc:
        return

    # ----------------------------------------------------------
    # Do not run custom logic for POS Next
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
    # Check whether Standard Buying prices are required.
    #
    # Normal discount > 0 OR custom_code = 999
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
            break

        discount = get_number(
            row.get("discount_percentage")
        )

        if discount is not None and discount > 0:
            needs_buying_prices = True
            break

    if not needs_buying_prices:
        return

    # ----------------------------------------------------------
    # ONE Standard Buying query for the whole document
    # ----------------------------------------------------------

    buying_prices = get_buying_prices_for_document(items)

    minimum_margin = float(
        MINIMUM_MARGIN_PERCENT[price_list]
    )

    # ----------------------------------------------------------
    # Validate each row
    # ----------------------------------------------------------

    for row in items:

        special_code = get_number(
            row.get("custom_code")
        )

        discount = get_number(
            row.get("discount_percentage")
        )

        # ======================================================
        # SPECIAL CODE 999
        # ======================================================

        if (
            special_code is not None
            and abs(
                special_code - SPECIAL_ZERO_MARGIN_CODE
            ) < 0.000001
        ):

            key = make_price_key(
                row.item_code,
                row.uom,
                row.batch_no,
            )

            buying_rate = buying_prices.get(
                key,
                0.0,
            )

            if buying_rate <= 0:
                frappe.throw(
                    f"Special code <b>999</b> cannot be used "
                    f"for item <b>{row.item_code}</b> because a valid "
                    f"Standard Buying price was not found for "
                    f"the same UOM and Batch."
                )

            selling_rate = get_selling_rate(row)

            if selling_rate <= 0:
                frappe.throw(
                    f"Special code <b>999</b> cannot be used "
                    f"for item <b>{row.item_code}</b> because the "
                    f"selling Price List rate is not available."
                )

            if selling_rate < buying_rate:
                frappe.throw(
                    f"Special code <b>999</b> cannot be used "
                    f"for item <b>{row.item_code}</b> because the "
                    f"{price_list} price "
                    f"({selling_rate:.2f}) is below "
                    f"Standard Buying "
                    f"({buying_rate:.2f})."
                )

            # --------------------------------------------------
            # Calculate the real discount required to sell
            # exactly at Standard Buying.
            # --------------------------------------------------

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

        # ======================================================
        # NORMAL DISCOUNT VALIDATION
        # ======================================================

        if discount is None:
            continue

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

        buying_rate = buying_prices.get(
            key,
            0.0,
        )

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

        max_discount = round(
            max_discount,
            6,
        )

        if discount > max_discount + 0.000001:

            frappe.throw(
                f"<b>Discount exceeds the allowed limit</b>"
                f"<br><br>"
                f"Item: <b>{row.item_code}</b>"
                f"<br>"
                f"Price List: <b>{price_list}</b>"
                f"<br>"
                f"Standard Buying Rate: "
                f"<b>{buying_rate:.2f}</b>"
                f"<br>"
                f"Price List Rate: "
                f"<b>{selling_rate:.2f}</b>"
                f"<br>"
                f"Minimum Required Margin: "
                f"<b>{minimum_margin:.2f}%</b>"
                f"<br>"
                f"Maximum Allowed Discount: "
                f"<b>{max_discount:.2f}%</b>"
                f"<br>"
                f"Entered Discount: "
                f"<b>{discount:.2f}%</b>"
            )


def get_buying_prices_for_document(items):
    """
    Fetch Standard Buying prices once for all item codes
    in the current document.

    Matching:
        Item Code + UOM + Batch

    One database query per document.
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

        rate = get_number(
            price.price_list_rate
        )

        if rate is None or rate <= 0:
            continue

        key = make_price_key(
            price.item_code,
            price.uom,
            price.batch_no,
        )

        # Keep newest matching Item Price.
        if key not in result:
            result[key] = rate

    return result


def make_price_key(
    item_code,
    uom=None,
    batch_no=None,
):
    return (
        item_code or "",
        uom or "",
        batch_no or "",
    )


def get_selling_rate(row):
    price_list_rate = get_number(
        row.price_list_rate
    )

    if (
        price_list_rate is not None
        and price_list_rate > 0
    ):
        return price_list_rate

    rate = get_number(
        row.rate
    )

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
