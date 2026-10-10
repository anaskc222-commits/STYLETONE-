import frappe
from frappe.utils import flt, getdate, nowdate


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
    Validate discounts for Quotation and Sales Invoice.

    Batch fields:
      Quotation     -> custom_batch_no
      Sales Invoice -> batch_no

    Rules:
      - Only configured target selling price lists are validated.
      - POS transactions are skipped.
      - Standard Buying price must be positive.
      - A selected batch must match its batch-specific buying price
        or an applicable item-level price with blank batch.
      - A different nonblank batch price is never used as a fallback.
      - Code 999 bypasses minimum-margin checks but still requires
        a valid Standard Buying price.
      - This function never changes selling rates or discounts.
    """

    # Skip POS transactions and POS-profile transactions.
    if (
        flt(doc.get("is_pos"))
        or doc.get("pos_profile")
        or doc.get("pos_opening_shift")
    ):
        return

    selling_price_list = doc.get("selling_price_list")

    if selling_price_list not in TARGET_PRICE_LISTS:
        return

    minimum_margin = MINIMUM_MARGIN_PERCENT[selling_price_list]

    # Only fetch buying prices for rows requiring validation.
    rows = [
        row
        for row in (doc.get("items") or [])
        if row.get("item_code")
        and (
            flt(row.get("discount_percentage")) > 0
            or flt(row.get("custom_code")) == SPECIAL_ZERO_MARGIN_CODE
        )
    ]

    if not rows:
        return

    # Quotation uses transaction_date; Sales Invoice uses posting_date.
    effective_date = getdate(
        doc.get("posting_date")
        or doc.get("transaction_date")
        or nowdate()
    )

    buying_prices, diagnostics = get_buying_prices_for_document(
        rows,
        effective_date,
    )

    problems = []

    for row in rows:
        item_code = row.get("item_code")
        discount = flt(row.get("discount_percentage"))
        custom_code = flt(row.get("custom_code"))
        selling_rate = flt(row.get("rate"))
        price_list_rate = flt(row.get("price_list_rate"))

        key = make_price_key(row)
        buying_rate = flt(buying_prices.get(key))

        # Special code 999: require a valid cost, but skip margin checks.
        if custom_code == SPECIAL_ZERO_MARGIN_CODE:
            if buying_rate <= 0:
                problems.append({
                    "item_code": item_code,
                    "selling_rate": selling_rate,
                    "discount": discount,
                    "reason": (
                        "Code 999 requires a valid Standard Buying price. "
                        + diagnostics.get(
                            key,
                            "No matching Standard Buying price was found."
                        )
                    ),
                })

            continue

        if discount <= 0:
            continue

        if selling_rate <= 0:
            problems.append({
                "item_code": item_code,
                "selling_rate": selling_rate,
                "discount": discount,
                "reason": "Selling rate is missing or zero.",
            })
            continue

        if buying_rate <= 0:
            problems.append({
                "item_code": item_code,
                "selling_rate": selling_rate,
                "discount": discount,
                "reason": (
                    "Standard Buying price not found. "
                    + diagnostics.get(
                        key,
                        "No matching Standard Buying price was found."
                    )
                ),
            })
            continue

        if price_list_rate <= 0:
            problems.append({
                "item_code": item_code,
                "selling_rate": selling_rate,
                "discount": discount,
                "reason": "Price List Rate is missing or zero.",
            })
            continue

        # Minimum selling price required to preserve the target margin.
        minimum_selling_rate = buying_rate * (
            1.0 + minimum_margin / 100.0
        )

        # Maximum discount allowed against the price list rate.
        maximum_discount = max(
            0.0,
            (
                (price_list_rate - minimum_selling_rate)
                / price_list_rate
            ) * 100.0,
        )

        if discount > maximum_discount + 0.0001:
            problems.append({
                "item_code": item_code,
                "selling_rate": selling_rate,
                "discount": discount,
                "reason": (
                    f"Maximum allowed discount is "
                    f"{maximum_discount:.2f}%. "
                    f"Buying price: {buying_rate:.2f}; "
                    f"minimum margin: {minimum_margin:.2f}%."
                ),
            })

    if problems:
        show_margin_error(
            problems,
            selling_price_list,
            minimum_margin,
        )


# ----------------------------------------------------------------------
# BATCH FIELD COMPATIBILITY
# ----------------------------------------------------------------------

def get_row_batch_no(row):
    """
    Get the selected batch for either supported document.

    Sales Invoice: batch_no
    Quotation:     custom_batch_no
    """

    return (
        row.get("batch_no")
        or row.get("custom_batch_no")
        or ""
    )


# ----------------------------------------------------------------------
# BULK STANDARD BUYING PRICE LOOKUP
# ----------------------------------------------------------------------

def get_buying_prices_for_document(items, effective_date=None):
    """
    Fetch applicable Standard Buying Item Price records using one SQL
    query for all relevant item codes.

    Matching priority:
      1. Exact batch + exact UOM
      2. Exact batch + blank UOM
      3. Blank batch + exact UOM
      4. Blank batch + blank UOM

    A nonblank batch-specific price is not used for a different batch.
    If the document row has no batch, only blank-batch prices match.

    Only positive prices valid on the effective document date qualify.
    """

    item_codes = list({
        row.get("item_code")
        for row in items
        if row.get("item_code")
    })

    if not item_codes:
        return {}, {}

    effective_date = getdate(effective_date or nowdate())

    placeholders = ", ".join(["%s"] * len(item_codes))

    query = f"""
        SELECT
            item_code,
            uom,
            batch_no,
            price_list_rate,
            creation
        FROM `tabItem Price`
        WHERE price_list = %s
          AND item_code IN ({placeholders})
          AND price_list_rate > 0
          AND (valid_from IS NULL OR valid_from <= %s)
          AND (valid_upto IS NULL OR valid_upto >= %s)
        ORDER BY creation DESC
    """

    params = (
        [SOURCE_PRICE_LIST]
        + item_codes
        + [effective_date, effective_date]
    )

    price_rows = frappe.db.sql(
        query,
        tuple(params),
        as_dict=True,
    )

    # Index format must match make_price_key():
    # (item_code, batch_no, uom)
    price_index = {}

    for price in price_rows:
        index_key = (
            price.get("item_code") or "",
            price.get("batch_no") or "",
            price.get("uom") or "",
        )

        # Query is newest first; retain the newest applicable record
        # for each exact item/batch/UOM combination.
        price_index.setdefault(
            index_key,
            flt(price.get("price_list_rate")),
        )

    result = {}
    diagnostics = {}

    for row in items:
        item_code = row.get("item_code")

        if not item_code:
            continue

        row_uom = row.get("uom") or ""
        row_batch = get_row_batch_no(row)
        row_key = make_price_key(row)

        priorities = (
            (item_code, row_batch, row_uom),
            (item_code, row_batch, ""),
            (item_code, "", row_uom),
            (item_code, "", ""),
        )

        selected_rate = None

        for candidate_key in priorities:
            candidate_rate = price_index.get(candidate_key)

            if candidate_rate is not None and candidate_rate > 0:
                selected_rate = candidate_rate
                break

        if selected_rate is not None:
            result[row_key] = selected_rate
            continue

        # Diagnostic only: show available prices without applying an
        # unrelated batch-specific price.
        item_candidates = [
            (batch, uom, rate)
            for (code, batch, uom), rate in price_index.items()
            if code == item_code
        ]

        if not item_candidates:
            diagnostics[row_key] = (
                f"No positive Standard Buying price valid on "
                f"{effective_date} was found for item {item_code}."
            )
        else:
            available = [
                (
                    f"UOM={uom or '(blank)'}, "
                    f"Batch={batch or '(blank)'}, "
                    f"Rate={rate:.2f}"
                )
                for batch, uom, rate in item_candidates[:5]
            ]

            diagnostics[row_key] = (
                f"No matching UOM/batch price for item {item_code}. "
                f"Document UOM={row_uom or '(blank)'}, "
                f"batch={row_batch or '(blank)'}. "
                f"Available prices: {'; '.join(available)}"
            )

    return result, diagnostics


# ----------------------------------------------------------------------
# INVOICE / QUOTATION ROW KEY
# ----------------------------------------------------------------------

def make_price_key(row):
    """
    Use one consistent key for Quotation and Sales Invoice rows.
    """

    return (
        row.get("item_code") or "",
        get_row_batch_no(row),
        row.get("uom") or "",
    )


# ----------------------------------------------------------------------
# VALIDATION ERROR MESSAGE
# ----------------------------------------------------------------------

def show_margin_error(problems, selling_price_list, minimum_margin):
    table = [["Item", "Selling Rate", "Discount", "Reason"]]

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
            f"Margin validation failed — {selling_price_list} "
            f"(Minimum margin: {minimum_margin:.0f}%)"
        ),
        indicator="red",
        as_table=True,
        raise_exception=True,
    )