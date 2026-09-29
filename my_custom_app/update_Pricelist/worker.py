
import frappe


B2B_PRICE_LIST = "B2B WHOLESALE"
SOURCE_PRICE_LIST = "Standard Buying"


def on_item_price_change(doc, method=None):
    """
    Lightweight Item Price event handler.

    Does not perform pricing calculations directly.
    Only enqueues eligible source-price changes.
    """

    if not doc:
        return

    # Never process the B2B output price as a source price.
    if doc.price_list == B2B_PRICE_LIST:
        return

    # Only process the intended source price list.
    if doc.price_list != SOURCE_PRICE_LIST:
        return

    if not doc.item_code:
        return

    try:
        buying_rate = float(doc.price_list_rate or 0)
    except (TypeError, ValueError):
        return

    if buying_rate <= 0:
        return

    frappe.enqueue(
        method=(
            "my_custom_app.update_Pricelist.dispatcher."
            "process_b2b_price_background"
        ),
        queue="short",
        enqueue_after_commit=True,
        job_name=f"b2b_price_{doc.name}",
        item_code=doc.item_code,
        price_list_rate=buying_rate,
        uom=doc.uom or "",
        batch_no=doc.batch_no or "",
        currency=doc.currency,
    )


def process_b2b_price_background(
    item_code,
    price_list_rate,
    uom="",
    batch_no="",
    currency=None,
):
    """
    Background worker for calculating and updating B2B pricing.
    """

    if not item_code:
        return

    if frappe.db.get_value("Item", item_code, "disabled"):
        return

    try:
        buying_rate = float(price_list_rate or 0)
    except (TypeError, ValueError):
        return

    if buying_rate <= 0:
        return

    item_data = frappe.db.get_value(
        "Item",
        item_code,
        ["item_group", "brand"],
        as_dict=True,
    )

    if not item_data:
        return

    item_group = item_data.item_group or ""
    brand = item_data.brand or ""

    rules = frappe.db.sql(
        """
        SELECT
            name,
            priority,
            creation,
            apply_on,
            margin_type,
            margin_rate_or_amount
        FROM `tabPricing Rule`
        WHERE selling = 1
          AND disable = 0
          AND docstatus < 2
          AND for_price_list = %s
          AND customer_group = %s
        ORDER BY priority DESC, creation ASC
        """,
        (B2B_PRICE_LIST, "Wholesale Store Clients"),
        as_dict=True,
    )

    if not rules:
        return

    matched_rules = []

    for rule in rules:
        apply_on = rule.apply_on
        rule_name = rule.name

        if apply_on == "Item Code":
            if frappe.db.exists(
                "Pricing Rule Item Code",
                {
                    "parent": rule_name,
                    "item_code": item_code,
                },
            ):
                matched_rules.append(rule)

        elif apply_on == "Item Group":
            if frappe.db.exists(
                "Pricing Rule Item Group",
                {
                    "parent": rule_name,
                    "item_group": item_group,
                },
            ) or frappe.db.exists(
                "Pricing Rule Item Group",
                {
                    "parent": rule_name,
                    "item_group": "All Item Groups",
                },
            ):
                matched_rules.append(rule)

        elif apply_on == "Brand":
            if brand and frappe.db.exists(
                "Pricing Rule Brand",
                {
                    "parent": rule_name,
                    "brand": brand,
                },
            ):
                matched_rules.append(rule)

        elif apply_on in ("Transaction", None, ""):
            matched_rules.append(rule)

    if not matched_rules:
        return

    def sort_key(rule):
        try:
            priority = int(rule.priority or 0)
        except (TypeError, ValueError):
            priority = 0

        specificity = {
            "Item Code": 1,
            "Brand": 2,
            "Item Group": 3,
            "Transaction": 4,
            "": 4,
            None: 4,
        }.get(rule.apply_on, 99)

        return (
            -priority,
            specificity,
            rule.creation,
        )

    winning_rule = min(matched_rules, key=sort_key)

    if winning_rule.margin_type != "Percentage":
        return

    try:
        margin = float(
            winning_rule.margin_rate_or_amount or 0
        )
    except (TypeError, ValueError):
        return

    b2b_rate = round(
        buying_rate * (1 + margin / 100.0),
        6,
    )

    existing = frappe.db.get_value(
        "Item Price",
        {
            "item_code": item_code,
            "price_list": B2B_PRICE_LIST,
            "uom": uom or "",
            "batch_no": batch_no or "",
            "selling": 1,
        },
        ["name", "price_list_rate", "currency"],
        order_by="creation asc",
        as_dict=True,
    )

    if existing:
        old_rate = float(existing.price_list_rate or 0)
        old_currency = existing.currency

        if (
            old_rate == b2b_rate
            and old_currency == currency
        ):
            return

        frappe.db.set_value(
            "Item Price",
            existing.name,
            {
                "price_list_rate": b2b_rate,
                "currency": currency,
                "selling": 1,
            },
            update_modified=False,
        )

        return

    new_price = frappe.new_doc("Item Price")
    new_price.item_code = item_code
    new_price.price_list = B2B_PRICE_LIST
    new_price.price_list_rate = b2b_rate
    new_price.currency = currency
    new_price.uom = uom or ""
    new_price.batch_no = batch_no or ""
    new_price.selling = 1
    new_price.valid_from = frappe.utils.today()

    new_price.insert(ignore_permissions=True)
