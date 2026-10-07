import json

import frappe
from frappe.utils import add_months, date_diff, getdate, now_datetime

from erpnext.stock.doctype.batch.batch import get_batch_qty


WAREHOUSE = "Arakkinar Store - ST"

SALES_MONTHS = 3
EXPIRY_MONTHS = 10

LATEST_KEY = "weekly_expiry:latest"


def build_weekly_snapshot():
    """
    Build the expiry snapshot.

    Heavy calculation runs once when called by the scheduler
    or manually from the report refresh action.
    """

    as_of_date = getdate()

    batches = get_batches(as_of_date)

    if not batches:
        save_snapshot(as_of_date, [])
        return

    item_codes = sorted(
        {
            row.item_code
            for row in batches
            if row.item_code
        }
    )

    batch_qty = get_batch_quantities(
        item_codes,
        WAREHOUSE,
        as_of_date,
    )

    sales = get_sales(
        item_codes,
        WAREHOUSE,
        as_of_date,
    )

    prices = get_prices(item_codes)

    result = []

    for batch in batches:

        item_code = batch.item_code
        batch_no = batch.batch_no

        quantity = batch_qty.get(
            (item_code, batch_no),
            0,
        )

        sales_3m = sales.get(
            item_code,
            0,
        )

        price = prices.get(
            item_code,
            {},
        )

        mrp = price.get("mrp", 0)
        buying_cost = price.get("buying_cost", 0)

        calculation = calculate(
            as_of_date=as_of_date,
            expiry_date=batch.expiry_date,
            quantity=quantity,
            mrp=mrp,
            buying_cost=buying_cost,
            sales_3m=sales_3m,
        )

        result.append(
            {
                "item_code": item_code,
                "item_name": batch.item_name,
                "batch_no": batch_no,
                "expiry_date": str(batch.expiry_date),

                "months_left": calculation["months_left"],
                "expiry_remaining": calculation[
                    "expiry_remaining"
                ],

                "quantity_available": quantity,

                "mrp": mrp,
                "buying_cost": buying_cost,

                "sales_3m": sales_3m,
                "avg_monthly_sales": (
                    sales_3m / SALES_MONTHS
                ),

                "movement": calculation["movement"],

                "expiry_risk": calculation["expiry_risk"],
                "movement_risk": calculation["movement_risk"],
                "risk_score": calculation["risk_score"],

                "expiry_target_margin": calculation[
                    "expiry_target_margin"
                ],

                "target_margin": calculation[
                    "target_margin"
                ],

                "minimum_safe_selling_price": calculation[
                    "minimum_safe_selling_price"
                ],

                "maximum_safe_discount": calculation[
                    "maximum_safe_discount"
                ],

                "recommended_discount": calculation[
                    "recommended_discount"
                ],

                "recommended_selling_price": calculation[
                    "recommended_selling_price"
                ],

                "expected_profit": calculation[
                    "expected_profit"
                ],

                "action": calculation["action"],
            }
        )

    result.sort(
        key=lambda x: (
            x["expiry_date"],
            x["item_code"],
            x["batch_no"],
        )
    )

    save_snapshot(
        as_of_date,
        result,
    )


def enqueue_weekly_expiry():
    """
    Scheduler entry point.
    """

    frappe.enqueue(
        build_weekly_snapshot,
        queue="long",
        timeout=60 * 60 * 2,
        job_name="styletone-weekly-expiry",
    )


def get_batches(as_of_date):

    end_date = add_months(
        as_of_date,
        EXPIRY_MONTHS,
    )

    return frappe.db.sql(
        """
        SELECT
            b.name AS batch_no,
            b.item AS item_code,
            i.item_name,
            b.expiry_date

        FROM `tabBatch` b

        INNER JOIN `tabItem` i
            ON i.name = b.item

        WHERE
            b.expiry_date IS NOT NULL
            AND b.expiry_date >= %(as_of_date)s
            AND b.expiry_date <= %(end_date)s

        ORDER BY
            b.expiry_date,
            b.item,
            b.name
        """,
        {
            "as_of_date": as_of_date,
            "end_date": end_date,
        },
        as_dict=True,
    )


def get_batch_quantities(
    item_codes,
    warehouse,
    as_of_date,
):

    result = {}

    for item_code in item_codes:

        rows = get_batch_qty(
            item_code=item_code,
            warehouse=warehouse,
            posting_date=as_of_date,
            for_stock_levels=True,
            consider_negative_batches=True,
            ignore_reserved_stock=True,
        )

        if not rows:
            continue

        for row in rows:

            batch_no = row.get("batch_no")

            if not batch_no:
                continue

            result[
                (item_code, batch_no)
            ] = float(
                row.get("qty") or 0
            )

    return result


def get_sales(
    item_codes,
    warehouse,
    as_of_date,
):

    if not item_codes:
        return {}

    start_date = add_months(
        as_of_date,
        -SALES_MONTHS,
    )

    rows = frappe.db.sql(
        """
        SELECT
            sii.item_code,

            SUM(
                CASE
                    WHEN si.is_return = 1
                    THEN -ABS(sii.qty)
                    ELSE ABS(sii.qty)
                END
            ) AS sales_qty

        FROM `tabSales Invoice Item` sii

        INNER JOIN `tabSales Invoice` si
            ON si.name = sii.parent

        WHERE
            si.docstatus = 1
            AND si.posting_date >= %(start_date)s
            AND si.posting_date <= %(as_of_date)s
            AND sii.warehouse = %(warehouse)s
            AND sii.item_code IN %(items)s

        GROUP BY
            sii.item_code
        """,
        {
            "start_date": start_date,
            "as_of_date": as_of_date,
            "warehouse": warehouse,
            "items": tuple(item_codes),
        },
        as_dict=True,
    )

    return {
        row.item_code: float(
            row.sales_qty or 0
        )
        for row in rows
    }


def get_prices(item_codes):

    if not item_codes:
        return {}

    rows = frappe.db.sql(
        """
        SELECT
            item_code,

            MAX(
                CASE
                    WHEN price_list = 'Standard Selling'
                    THEN price_list_rate
                    ELSE 0
                END
            ) AS mrp,

            MAX(
                CASE
                    WHEN price_list = 'Standard Buying'
                    THEN price_list_rate
                    ELSE 0
                END
            ) AS buying_cost

        FROM `tabItem Price`

        WHERE
            item_code IN %(items)s

            AND price_list IN (
                'Standard Selling',
                'Standard Buying'
            )

            AND (
                batch_no IS NULL
                OR batch_no = ''
            )

        GROUP BY
            item_code
        """,
        {
            "items": tuple(item_codes),
        },
        as_dict=True,
    )

    return {
        row.item_code: {
            "mrp": float(row.mrp or 0),
            "buying_cost": float(
                row.buying_cost or 0
            ),
        }
        for row in rows
    }


def calculate(
    as_of_date,
    expiry_date,
    quantity,
    mrp,
    buying_cost,
    sales_3m,
):

    days_left = date_diff(
        expiry_date,
        as_of_date,
    )

    months_left = days_left / 30.4375

    expiry_remaining = format_remaining(
        days_left
    )

    # -------------------------
    # EXPIRY RISK
    # -------------------------

    if months_left < 1:
        expiry_risk = 95

    elif months_left < 2:
        expiry_risk = 85

    elif months_left < 3:
        expiry_risk = 70

    elif months_left < 6:
        expiry_risk = 50

    elif months_left < 8:
        expiry_risk = 30

    elif months_left < 10:
        expiry_risk = 15

    else:
        expiry_risk = 0

    # -------------------------
    # EXPIRY TARGET MARGIN
    # -------------------------

    if months_left >= 10:
        expiry_target_margin = 45

    elif months_left >= 8:
        expiry_target_margin = 40

    elif months_left >= 6:
        expiry_target_margin = 35

    elif months_left >= 3:
        expiry_target_margin = 20

    elif months_left >= 2:
        expiry_target_margin = 5

    else:
        expiry_target_margin = 0

    # -------------------------
    # MOVEMENT
    # -------------------------

    avg_monthly_sales = (
        sales_3m / SALES_MONTHS
    )

    if sales_3m <= 0:

        movement = "NO SALES"
        movement_risk = 100

    elif (
        avg_monthly_sales
        * months_left
        <= quantity
    ):

        movement = "VERY SLOW"
        movement_risk = 90

    elif (
        avg_monthly_sales
        * months_left
        <= quantity * 1.5
    ):

        movement = "HIGH RISK"
        movement_risk = 70

    elif (
        avg_monthly_sales
        * months_left
        <= quantity * 3
    ):

        movement = "WATCH"
        movement_risk = 40

    else:

        movement = "NORMAL"
        movement_risk = 10

    # -------------------------
    # COMBINED RISK
    # -------------------------

    risk_score = (
        expiry_risk * 0.50
        + movement_risk * 0.50
    )

    # -------------------------
    # TARGET MARGIN
    # -------------------------

    target_margin = max(
        expiry_target_margin
        - risk_score * 0.30,
        0,
    )

    # -------------------------
    # MINIMUM SAFE PRICE
    # -------------------------

    if (
        buying_cost > 0
        and target_margin < 100
    ):

        minimum_safe_price = (
            buying_cost
            / (
                1
                - target_margin / 100
            )
        )

    else:

        minimum_safe_price = 0

    # -------------------------
    # MAXIMUM SAFE DISCOUNT
    # -------------------------

    if (
        mrp > 0
        and minimum_safe_price > 0
    ):

        maximum_safe_discount = (
            100
            * (
                1
                - minimum_safe_price / mrp
            )
        )

        maximum_safe_discount = max(
            0,
            min(
                maximum_safe_discount,
                100,
            ),
        )

    else:

        maximum_safe_discount = 0

    # -------------------------
    # RECOMMENDED DISCOUNT
    # -------------------------

    if (
        mrp > 0
        and buying_cost > 0
    ):

        recommended_discount = min(
            max(
                risk_score * 0.60,
                0,
            ),
            maximum_safe_discount,
        )

    else:

        recommended_discount = 0

    # -------------------------
    # SELLING PRICE
    # -------------------------

    if mrp > 0:

        recommended_selling_price = (
            mrp
            * (
                1
                - recommended_discount / 100
            )
        )

    else:

        recommended_selling_price = 0

    # -------------------------
    # PROFIT
    # -------------------------

    expected_profit = (
        recommended_selling_price
        - buying_cost
    )

    # -------------------------
    # ACTION
    # -------------------------

    if months_left < 1:

        action = "URGENT CLEARANCE"

    elif movement == "VERY SLOW":

        action = "AGGRESSIVE DISCOUNT"

    elif movement == "HIGH RISK":

        action = "START DISCOUNT"

    elif movement == "WATCH":

        action = "MONITOR"

    else:

        action = "NORMAL SALE"

    return {
        "months_left": months_left,
        "expiry_remaining": expiry_remaining,

        "expiry_risk": expiry_risk,
        "expiry_target_margin":
            expiry_target_margin,

        "movement": movement,
        "movement_risk": movement_risk,

        "risk_score": risk_score,

        "target_margin": target_margin,

        "minimum_safe_selling_price":
            minimum_safe_price,

        "maximum_safe_discount":
            maximum_safe_discount,

        "recommended_discount":
            recommended_discount,

        "recommended_selling_price":
            recommended_selling_price,

        "expected_profit":
            expected_profit,

        "action": action,
    }


def format_remaining(days):

    if days < 0:
        return "Expired"

    months = days // 30
    remaining_days = days % 30

    if months == 0:
        return f"{remaining_days} Days"

    if remaining_days == 0:
        return f"{months} Months"

    return (
        f"{months} Months "
        f"{remaining_days} Days"
    )


def save_snapshot(
    as_of_date,
    rows,
):

    snapshot = {
        "as_of_date": str(as_of_date),
        "warehouse": WAREHOUSE,
        "created_at": str(now_datetime()),
        "row_count": len(rows),
        "rows": rows,
    }

    key = (
        "weekly_expiry:"
        f"{as_of_date}"
    )

    frappe.cache().set_value(
        key,
        json.dumps(snapshot),
        expires_in_sec=60 * 60 * 24 * 10,
    )

    frappe.cache().set_value(
        LATEST_KEY,
        key,
        expires_in_sec=60 * 60 * 24 * 10,
    )

    frappe.db.commit()