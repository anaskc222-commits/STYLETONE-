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
    Validate discounts for the three custom selling Price Lists.

    B2B WHOLESALE  -> minimum 5% margin
    SALOON         -> minimum 7% margin
    BEAUTY PARLOUR -> minimum 10% margin

    custom_code = 999:
        Sell at Standard Buying price.
        Actual discount is recalculated automatically.

    Standard Selling and POS are completely ignored.
    """

    # ---------------------------------------------------------
    # 1. Ignore POS
    # ---------------------------------------------------------
    if (
        doc.get("is_pos")
        or doc.get("pos_profile")
        or doc.get("pos_opening_shift")
    ):
        return

    # ---------------------------------------------------------
    # 2. Only custom selling price lists
    # ---------------------------------------------------------
    selling_price_list = doc.get("selling_price_list")

    if selling_price_list not in TARGET_PRICE_LISTS:
        return

    # ---------------------------------------------------------
    # 3. Determine whether buying prices are needed
    # ---------------------------------------------------------
    items = []
    needs_buying_prices = False

    for row in doc.get("items") or []:

        if not row.get("item_code"):
            continue

        discount = flt(row.get("discount_percentage"))
        custom_code = flt(row.get("custom_code"))

        items.append(row)

        if discount > 0 or custom_code == SPECIAL_ZERO_MARGIN_CODE:
            needs_buying_prices = True

    # No discount and no 999 code
    # Therefore no DB query is necessary.
    if not needs_buying_prices:
        return

    # ---------------------------------------------------------
    # 4. ONE DB QUERY
    # ---------------------------------------------------------
    buying_prices = get_buying_prices_for_document(items)

    # ---------------------------------------------------------
    # 5. Validate
    # ---------------------------------------------------------
    minimum_margin = MINIMUM_MARGIN_PERCENT[selling_price_list]

    problems = []

    for row in items:

        discount = flt(row.get("discount_percentage"))
        custom_code = flt(row.get("custom_code"))

        # Nothing to validate
        if discount <= 0 and custom_code != SPECIAL_ZERO_MARGIN_CODE:
            continue

        item_code = row.get("item_code") or ""

        price_key = make_price_key(row)

        buying_rate = flt(
            buying_prices.get(price_key, 0.0)
        )

        selling_rate = get_selling_rate(row)

        # =====================================================
        # SPECIAL CODE 999
        # =====================================================
        if custom_code == SPECIAL_ZERO_MARGIN_CODE:

            # No buying price
            if buying_rate <= 0:

                problems.append({
                    "item_code": item_code,
                    "buying_rate": 0.0,
                    "selling_rate": selling_rate,
                    "discount": discount,
                    "reason": "Standard Buying price not found",
                })

                continue

            # No selling rate
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
                    "reason": "Selling below Standard Buying price",
                })

                continue

            # Recalculate actual discount
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

            continue

        # =====================================================
        # NORMAL DISCOUNT
        # =====================================================

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
                "reason": "Standard Buying price not found",
            })

            continue

        # -----------------------------------------------------
        # Price List Rate
        # -----------------------------------------------------
        price_list_rate = flt(
            row.get("price_list_rate")
        )

        if price_list_rate <= 0:

            problems.append({
                "item_code": item_code,
                "buying_rate": buying_rate,
                "selling_rate": selling_rate,
                "discount": discount,
                "reason": "Price List Rate is 0",
            })

            continue

        # -----------------------------------------------------
        # Minimum selling price
        # -----------------------------------------------------
        minimum_selling_rate = buying_rate * (
            1 + minimum_margin / 100
        )

        # -----------------------------------------------------
        # Maximum discount allowed
        # -----------------------------------------------------
        maximum_discount = (
            (price_list_rate - minimum_selling_rate)
            / price_list_rate
        ) * 100

        maximum_discount = max(
            0.0,
            maximum_discount
        )

        # -----------------------------------------------------
        # Check discount
        # -----------------------------------------------------
        if discount > maximum_discount + 0.0001:

            problems.append({
                "item_code": item_code,
                "buying_rate": buying_rate,
                "selling_rate": selling_rate,
                "discount": discount,
                "reason": (
                    f"Maximum allowed discount is "
                    f"{maximum_discount:.2f}%"
                ),
            })

    # ---------------------------------------------------------
    # 6. Everything is valid
    # ---------------------------------------------------------
    if not problems:
        return

    # ---------------------------------------------------------
    # 7. Show only problematic items
    # ---------------------------------------------------------
    message = build_error_table(
        problems,
        selling_price_list,
        minimum_margin,
    )

    frappe.throw(message)


# =================================================================
# BUYING PRICE QUERY
# =================================================================

def get_buying_prices_for_document(items):
    """
    Fetch Standard Buying prices using ONE database query.

    Matching:
        Item Code
        UOM
        Batch No

    Newest Item Price wins.
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

        if key not in result:
            result[key] = flt(
                price.price_list_rate
            )

    return result


# =================================================================
# PRICE KEY
# =================================================================

def make_price_key(row):

    return (
        row.get("item_code") or "",
        row.get("uom") or "",
        row.get("batch_no") or "",
    )


# =================================================================
# SELLING RATE
# =================================================================

def get_selling_rate(row):

    return flt(
        row.get("rate")
    )


# =================================================================
# ERROR TABLE
# =================================================================

def build_error_table(
    problems,
    selling_price_list,
    minimum_margin,
):

    rows = []

    for problem in problems:

        item_code = frappe.utils.escape_html(
            str(problem["item_code"])
        )

        reason = frappe.utils.escape_html(
            str(problem["reason"])
        )

        rows.append(
            f"""
            <tr>
                <td>{item_code}</td>

                <td style="text-align:right;">
                    {problem["buying_rate"]:.2f}
                </td>

                <td style="text-align:right;">
                    {problem["selling_rate"]:.2f}
                </td>

                <td style="text-align:right;">
                    {problem["discount"]:.2f}%
                </td>

                <td>
                    {reason}
                </td>
            </tr>
            """
        )

    price_list = frappe.utils.escape_html(
        str(selling_price_list)
    )

    return f"""
        <div>

            <p>
                <b>Discount validation failed</b>
            </p>

            <p>
                Price List:
                <b>{price_list}</b>
                <br>
                Required minimum margin:
                <b>{minimum_margin:.2f}%</b>
            </p>

            <table
                class="table table-bordered"
                style="width:100%;"
            >

                <thead>
                    <tr>
                        <th>Item</th>
                        <th>Buying Price</th>
                        <th>Selling Rate</th>
                        <th>Discount</th>
                        <th>Reason</th>
                    </tr>
                </thead>

                <tbody>
                    {''.join(rows)}
                </tbody>

            </table>

        </div>
    """
