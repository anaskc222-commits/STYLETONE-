import frappe
from frappe.utils import flt, getdate, nowdate

----------------------------------------------------------------------

SETTINGS

----------------------------------------------------------------------

SOURCE_PRICE_LIST = "Standard Buying"

MINIMUM_MARGIN_PERCENT = {
"B2B WHOLESALE": 5.0,
"SALOON": 7.0,
"BEAUTY PARLOUR": 10.0,
}

SPECIAL_ZERO_MARGIN_CODE = 999.0
TARGET_PRICE_LISTS = set(MINIMUM_MARGIN_PERCENT)

----------------------------------------------------------------------

MAIN VALIDATION

----------------------------------------------------------------------

def validate_discount_limit(doc, method=None):
"""
Validate discounts against Standard Buying.

Code 999 bypasses minimum-margin limits without changing the rate.
A valid Standard Buying price is still required for code 999.
"""

# Skip POS and POS-profile transactions.
if (
    getattr(doc, "is_pos", 0)
    or doc.get("pos_profile")
    or doc.get("pos_opening_shift")
):
    return

selling_price_list = doc.get("selling_price_list")

if selling_price_list not in TARGET_PRICE_LISTS:
    return

minimum_margin = MINIMUM_MARGIN_PERCENT[selling_price_list]

rows = [
    row for row in (doc.get("items") or [])
    if row.get("item_code")
    and (
        flt(row.get("discount_percentage")) > 0
        or flt(row.get("custom_code")) == SPECIAL_ZERO_MARGIN_CODE
    )
]

if not rows:
    return

effective_date = getdate(doc.get("posting_date") or nowdate())

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

    # --------------------------------------------------------------
    # SPECIAL CODE 999: BYPASS MARGIN LIMIT
    # --------------------------------------------------------------

    if custom_code == SPECIAL_ZERO_MARGIN_CODE:
        if buying_rate <= 0:
            problems.append({
                "item_code": item_code,
                "selling_rate": selling_rate,
                "discount": discount,
                "reason": (
                    "Code 999 requires a valid Standard Buying price. "
                    + diagnostics.get(key, "")
                ),
            })

        # Bypass minimum margin checks.
        # Do not change selling_rate or discount_percentage.
        continue

    # --------------------------------------------------------------
    # NORMAL DISCOUNT VALIDATION
    # --------------------------------------------------------------

    if discount <= 0:
        continue

    if selling_rate <= 0:
        problems.append({
            "item_code": item_code,
            "selling_rate": selling_rate,
            "discount": discount,
            "reason": "Selling rate is missing or zero",
        })
        continue

    if buying_rate <= 0:
        problems.append({
            "item_code": item_code,
            "selling_rate": selling_rate,
            "discount": discount,
            "reason": (
                "Standard Buying price not found. "
                + diagnostics.get(key, "")
            ),
        })
        continue

    if price_list_rate <= 0:
        problems.append({
            "item_code": item_code,
            "selling_rate": selling_rate,
            "discount": discount,
            "reason": "Price List Rate is missing or zero",
        })
        continue

    minimum_selling_rate = buying_rate * (
        1.0 + minimum_margin / 100.0
    )

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
                f"minimum margin: {minimum_margin:.2f}%"
            ),
        })

if problems:
    show_margin_error(
        problems,
        selling_price_list,
        minimum_margin,
    )

----------------------------------------------------------------------

BULK STANDARD BUYING PRICE LOOKUP

----------------------------------------------------------------------

def get_buying_prices_for_document(items, effective_date=None):
"""
Fetch applicable Item Price records in one SQL query.

Match priority:
  1. Exact batch + exact UOM
  2. Exact batch + blank UOM
  3. Blank batch + exact UOM
  4. Blank batch + blank UOM

Only positive prices valid on the document date are considered.
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

# Build an indexed lookup, keeping the newest record per key.
price_index = {}

for price in price_rows:
    index_key = (
        price.get("item_code") or "",
        price.get("batch_no") or "",
        price.get("uom") or "",
    )

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
    row_batch = row.get("batch_no") or ""
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
            f"Invoice UOM={row_uom or '(blank)'}, "
            f"batch={row_batch or '(blank)'}. "
            f"Available: {'; '.join(available)}"
        )

return result, diagnostics

----------------------------------------------------------------------

INVOICE ROW KEY

----------------------------------------------------------------------

def make_price_key(row):
return (
row.get("item_code") or "",
row.get("uom") or "",
row.get("batch_no") or "",
)

----------------------------------------------------------------------

VALIDATION ERROR MESSAGE

----------------------------------------------------------------------

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