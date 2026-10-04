import frappe
from frappe.utils import flt


# =================================================================
# SETTINGS
# =================================================================

SOURCE_PRICE_LIST = "Standard Buying"


MINIMUM_MARGIN_PERCENT = {
    "B2B WHOLESALE": 5.0,
    "SALOON": 7.0,
    "BEAUTY PARLOUR": 10.0,
}


SPECIAL_ZERO_MARGIN_CODE = 999.0


TARGET_PRICE_LISTS = set(
    MINIMUM_MARGIN_PERCENT
)


# =================================================================
# MAIN VALIDATION
# =================================================================

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
        Maximum ONE Item Price query per document.
        No Item Price query when validation is not required.
    """

    # =============================================================
    # 1. IGNORE POS
    # =============================================================

    if (
        doc.get("is_pos")
        or doc.get("pos_profile")
        or doc.get("pos_opening_shift")
    ):
        return

    # =============================================================
    # 2. ONLY CUSTOM SELLING PRICE LISTS
    # =============================================================

    selling_price_list = doc.get(
        "selling_price_list"
    )

    if selling_price_list not in TARGET_PRICE_LISTS:
        return

    # =============================================================
    # 3. COLLECT ITEMS
    # =============================================================

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

        if (
            discount > 0
            or custom_code == SPECIAL_ZERO_MARGIN_CODE
        ):
            needs_buying_prices = True

    # =============================================================
    # NO VALIDATION REQUIRED
    # =============================================================

    if not needs_buying_prices:
        return

    # =============================================================
    # 4. ONE DATABASE QUERY
    # =============================================================

    buying_prices = get_buying_prices_for_document(
        items
    )

    minimum_margin = MINIMUM_MARGIN_PERCENT[
        selling_price_list
    ]

    problems = []

    # =============================================================
    # 5. VALIDATE EACH ITEM
    # =============================================================

    for row in items:

        discount = flt(
            row.get("discount_percentage")
        )

        custom_code = flt(
            row.get("custom_code")
        )

        # ---------------------------------------------------------
        # Nothing to validate for this row
        # ---------------------------------------------------------

        if (
            discount <= 0
            and custom_code != SPECIAL_ZERO_MARGIN_CODE
        ):
            continue

        item_code = row.get(
            "item_code"
        ) or ""

        buying_rate = flt(
            buying_prices.get(
                make_price_key(row),
                0.0
            )
        )

        selling_rate = get_selling_rate(
            row
        )

        # =========================================================
        # SPECIAL CODE 999
        # =========================================================

        if custom_code == SPECIAL_ZERO_MARGIN_CODE:

            # -----------------------------------------------------
            # Buying price missing
            # -----------------------------------------------------

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

            # -----------------------------------------------------
            # Selling rate missing
            # -----------------------------------------------------

            if selling_rate <= 0:

                problems.append({
                    "item_code": item_code,
                    "buying_rate": buying_rate,
                    "selling_rate": selling_rate,
                    "discount": discount,
                    "reason": "Selling rate is 0",
                })

                continue

            # -----------------------------------------------------
            # Selling below Standard Buying
            # -----------------------------------------------------

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

            # -----------------------------------------------------
            # Recalculate actual discount
            # -----------------------------------------------------

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

                row.discount_percentage = (
                    actual_discount
                )

                row.rate = buying_rate

            continue

        # =========================================================
        # NORMAL DISCOUNT
        # =========================================================

        if discount <= 0:
            continue

        # ---------------------------------------------------------
        # Selling rate missing
        # ---------------------------------------------------------

        if selling_rate <= 0:

            problems.append({
                "item_code": item_code,
                "buying_rate": buying_rate,
                "selling_rate": selling_rate,
                "discount": discount,
                "reason": "Selling rate is 0",
            })

            continue

        # ---------------------------------------------------------
        # Buying price missing
        # ---------------------------------------------------------

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

        # ---------------------------------------------------------
        # Price List Rate
        # ---------------------------------------------------------

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

        # ---------------------------------------------------------
        # Minimum selling rate
        # ---------------------------------------------------------

        minimum_selling_rate = (
            buying_rate
            * (
                1
                + minimum_margin / 100
            )
        )

        # ---------------------------------------------------------
        # Maximum allowed discount
        # ---------------------------------------------------------

        maximum_discount = (
            (
                price_list_rate
                - minimum_selling_rate
            )
            / price_list_rate
        ) * 100

        maximum_discount = max(
            0.0,
            maximum_discount
        )

        # ---------------------------------------------------------
        # Check discount
        # ---------------------------------------------------------

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

    # =============================================================
    # 6. EVERYTHING VALID
    # =============================================================

    if not problems:
        return

    # =============================================================
    # 7. SHOW ONLY PROBLEMATIC ITEMS
    # =============================================================

    message = build_error_table(
        problems,
        selling_price_list,
        minimum_margin,
    )

    frappe.throw(message)


# =================================================================
# GET STANDARD BUYING PRICES
# =================================================================

def get_buying_prices_for_document(items):
    """
    Fetch Standard Buying prices in ONE database query.

    Match:
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

        # Newest matching price wins
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
# ERROR UI
# =================================================================

def build_error_table(
    problems,
    selling_price_list,
    minimum_margin,
):
    """
    Compact ERPNext-style validation UI.

    Buying Rate is intentionally NOT displayed.
    It is still used internally for validation.
    """

    price_list = frappe.utils.escape_html(
        str(selling_price_list)
    )

    rows = []

    for problem in problems:

        item_code = frappe.utils.escape_html(
            str(problem["item_code"])
        )

        reason = frappe.utils.escape_html(
            str(problem["reason"])
        )

        selling_rate = (
            f'{problem["selling_rate"]:.2f}'
        )

        discount = (
            f'{problem["discount"]:.2f}%'
        )

        rows.append(
            f"""
            <tr>

                <td style="
                    padding:8px 10px;
                    border-bottom:1px solid #e5e7eb;
                    text-align:left;
                    font-weight:500;
                    white-space:nowrap;
                ">
                    {item_code}
                </td>

                <td style="
                    padding:8px 10px;
                    border-bottom:1px solid #e5e7eb;
                    text-align:right;
                    white-space:nowrap;
                ">
                    {selling_rate}
                </td>

                <td style="
                    padding:8px 10px;
                    border-bottom:1px solid #e5e7eb;
                    text-align:right;
                    white-space:nowrap;
                ">
                    {discount}
                </td>

                <td style="
                    padding:8px 10px;
                    border-bottom:1px solid #e5e7eb;
                    text-align:left;
                    color:#6b7280;
                    line-height:1.4;
                    min-width:190px;
                ">
                    {reason}
                </td>

            </tr>
            """
        )

    table_rows = "".join(rows)

    return f"""
    <div style="
        font-family:inherit;
        width:100%;
        box-sizing:border-box;
    ">

        <div style="
            margin-bottom:12px;
            line-height:1.45;
        ">

            <div style="
                font-size:14px;
                font-weight:600;
                color:#36414c;
                margin-bottom:4px;
            ">
                Margin validation failed
            </div>

            <div style="
                font-size:13px;
                color:#6b7280;
            ">
                Price List:
                <b style="color:#36414c;">
                    {price_list}
                </b>

                <span style="margin:0 4px;">
                    ·
                </span>

                Minimum margin:
                <b style="color:#36414c;">
                    {minimum_margin:.0f}%
                </b>
            </div>

        </div>

        <div style="
            width:100%;
            overflow-x:auto;
            -webkit-overflow-scrolling:touch;
            border:1px solid #d1d8dd;
            border-radius:6px;
            background:#ffffff;
        ">

            <table style="
                width:100%;
                min-width:560px;
                border-collapse:collapse;
                table-layout:auto;
                font-size:12px;
                color:#36414c;
            ">

                <thead>

                    <tr style="
                        background:#f7f9fa;
                    ">

                        <th style="
                            padding:8px 10px;
                            border-bottom:1px solid #d1d8dd;
                            text-align:left;
                            font-weight:600;
                            white-space:nowrap;
                        ">
                            Item
                        </th>

                        <th style="
                            padding:8px 10px;
                            border-bottom:1px solid #d1d8dd;
                            text-align:right;
                            font-weight:600;
                            white-space:nowrap;
                        ">
                            Selling Rate
                        </th>

                        <th style="
                            padding:8px 10px;
                            border-bottom:1px solid #d1d8dd;
                            text-align:right;
                            font-weight:600;
                            white-space:nowrap;
                        ">
                            Discount
                        </th>

                        <th style="
                            padding:8px 10px;
                            border-bottom:1px solid #d1d8dd;
                            text-align:left;
                            font-weight:600;
                            white-space:nowrap;
                        ">
                            Reason
                        </th>

                    </tr>

                </thead>

                <tbody>
                    {table_rows}
                </tbody>

            </table>

        </div>

    </div>
    """
