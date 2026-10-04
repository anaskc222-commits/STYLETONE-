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
        The actual discount is recalculated automatically.

    Important:
    - Standard Selling is untouched.
    - POS is untouched.
    - No DB query when validation is not required.
    - Maximum ONE Item Price query per document.
    """

    # ---------------------------------------------------------------
    # 1. Ignore POS
    # ---------------------------------------------------------------
    if doc.get("is_pos") or doc.get("pos_profile") or doc.get("pos_opening_shift"):
        return

    # ---------------------------------------------------------------
    # 2. Only validate the three custom selling price lists
    # ---------------------------------------------------------------
    selling_price_list = doc.get("selling_price_list")

    if selling_price_list not in TARGET_PRICE_LISTS:
        return

    # ---------------------------------------------------------------
    # 3. Find whether buying prices are actually required
    # ---------------------------------------------------------------
    items = []
    needs_buying_prices = False

    for row in doc.get("items") or []:
        item_code = row.get("item_code")

        if not item_code:
            continue

        discount = flt(row.get("discount_percentage"))

        custom_code = flt(row.get("custom_code"))

        # Only query buying prices when:
        # - discount exists, OR
        # - special 999 code is used
        if discount > 0 or custom_code == SPECIAL_ZERO_MARGIN_CODE:
            needs_buying_prices = True

        items.append(row)

    # No discount / no 999 = nothing to validate
    if not needs_buying_prices:
        return

    # ---------------------------------------------------------------
    # 4. ONE DB QUERY ONLY
    # ---------------------------------------------------------------
    buying_prices = get_buying_prices_for_document(items)

    # ---------------------------------------------------------------
    # 5. Validate and collect ONLY problematic items
    # ---------------------------------------------------------------
    problems = []

    minimum_margin = MINIMUM_MARGIN_PERCENT[selling_price_list]

    for row in items:

        discount = flt(row.get("discount_percentage"))
        custom_code = flt(row.get("custom_code"))

        # -----------------------------------------------------------
        # Ignore rows that don't need validation
        # -----------------------------------------------------------
        if discount <= 0 and custom_code != SPECIAL_ZERO_MARGIN_CODE:
            continue

        item_code = row.get("item_code") or ""

        buying_rate = buying_prices.get(
            make_price_key(row),
            0.0
        )

        selling_rate = get_selling_rate(row)

        # ===========================================================
        # SPECIAL CODE 999
        # ===========================================================
        if custom_code == SPECIAL_ZERO_MARGIN_CODE:

            # Buying price missing
            if buying_rate <= 0:
                problems.append({
                    "item_code": item_code,
                    "buying_rate": 0.0,
                    "selling_rate": selling_rate,
                    "discount": discount,
                    "reason": "Standard Buying price not found"
                })
                continue

            # Selling rate missing
            if selling_rate <= 0:
                problems.append({
                    "item_code": item_code,
                    "buying_rate": buying_rate,
                    "selling_rate": selling_rate,
                    "discount": discount,
                    "reason": "Selling rate is 0"
                })
                continue

            # Cannot sell below buying price
            if selling_rate < buying_rate:
                problems.append({
                    "item_code": item_code,
                    "buying_rate": buying_rate,
                    "selling_rate": selling_rate,
                    "discount": discount,
                    "reason": "Selling below Standard Buying price"
                })
                continue

            # Calculate actual discount from buying price
            price_list_rate = flt(row.get("price_list_rate"))

            if price_list_rate > 0:
                actual_discount = (
                    (price_list_rate - buying_rate)
                    / price_list_rate
                ) * 100

                row.discount_percentage = actual_discount
                row.rate = buying_rate

            continue

        # ===========================================================
        # NORMAL DISCOUNT VALIDATION
        # ===========================================================

        # No discount = nothing to validate
        if discount <= 0:
            continue

        # Selling rate missing
        if selling_rate <= 0:
            problems.append({
                "item_code": item_code,
                "buying_rate": buying_rate,
                "selling_rate": selling_rate,
                "discount": discount,
                "reason": "Selling rate is 0"
            })
            continue

        # Buying price missing
        if buying_rate <= 0:
            problems.append({
                "item_code": item_code,
                "buying_rate": 0.0,
                "selling_rate": selling_rate,
                "discount": discount,
                "reason": "Standard Buying price not found"
            })
            continue

        # -----------------------------------------------------------
        # Minimum allowed selling rate
        #
        # Example:
        # Buying = 100
        # Minimum margin = 5%
        # Minimum selling rate = 105
        # -----------------------------------------------------------
        minimum_selling_rate = buying_rate * (
            1 + minimum_margin / 100
        )

        price_list_rate = flt(row.get("price_list_rate"))

        if price_list_rate <= 0:
            problems.append({
                "item_code": item_code,
                "buying_rate": buying_rate,
                "selling_rate": selling_rate,
                "discount": discount,
                "reason": "Price List Rate is 0"
            })
            continue

        # Maximum discount allowed
        maximum_discount = (
            (price_list_rate - minimum_selling_rate)
            / price_list_rate
        ) * 100

        # Prevent negative maximum discount
        maximum_discount = max(0.0, maximum_discount)

        # Small floating-point tolerance
        if discount > maximum_discount + 0.0001:
            problems.append({
                "item_code": item_code,
                "buying_rate": buying_rate,
                "selling_rate": selling_rate,
                "discount": discount,
                "reason": (
                    f"Maximum allowed discount is "
                    f"{maximum_discount:.2f}%"
                )
            )

    # ---------------------------------------------------------------
    # 6. If everything is valid, simply allow Save/Submit
    # ---------------------------------------------------------------
    if not problems:
        return

    # ---------------------------------------------------------------
    # 7. Show ONLY problematic items
    # ---------------------------------------------------------------
    message = build_error_table(
        problems,
        selling_price_list,
        minimum_margin
    )

    frappe.throw(message)


# ==================================================================
# BUYING PRICE QUERY
# ==================================================================

def get_buying_prices_for_document(items):
    """
    Fetch all required Standard Buying prices in ONE DB query.

    Returns:
        {
            (item_code, uom, batch_no): rate
        }
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

        # Because rows are ordered newest first,
        # first matching record wins.
        if key not in result:
            result[key] = flt(price.price_list_rate)

    return result


# ==================================================================
# PRICE KEY
# ==================================================================

def make_price_key(row):
    """
    Match Item Price using:
        Item Code + UOM + Batch No
    """

    return (
        row.get("item_code") or "",
        row.get("uom") or "",
        row.get("batch_no") or "",
    )


# ==================================================================
# SELLING RATE
# ==================================================================

def get_selling_rate(row):
    """
    Get the actual transaction selling rate.
    """

    return flt(row.get("rate"))


# ==================================================================
# ERROR TABLE
# ==================================================================

def build_error_table(problems, selling_price_list, minimum_margin):

    rows = []

    for problem in problems:

        rows.append(
            f"""
            <tr>
                <td>{frappe.utils.escape_html(problem["item_code"])}</td>
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
                    {frappe.utils.escape_html(problem["reason"])}
                </td>
            </tr>
            """
        )

    table = f"""
        <div>
            <p>
                <b>Discount validation failed</b>
            </p>

            <p>
                Price List:
                <b>{frappe.utils.escape_html(selling_price_list)}</b>
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

    return table
