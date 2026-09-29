import frappe

B2B_PRICE_LIST = "B2B WHOLESALE"
B2B_CUSTOMER_GROUP = "Wholesale Store Clients"

RULE_TYPE_ORDER = {
    "Item Code": 1,
    "Brand": 2,
    "Item Group": 3,
    "Transaction": 4,
    "": 4
}

def process_b2b_price_background(
    item_code,
    price_list_rate,
    uom="",
    batch_no="",
    currency=None
):
    """
    Worker function: Runs safely inside a background process.
    """
    if frappe.flags.get("updating_b2b_price"):
        return

    frappe.flags.updating_b2b_price = True

    try:
        try:
            buying_rate = float(price_list_rate or 0)
        except (TypeError, ValueError):
            return

        if buying_rate <= 0:
            return

        # --------------------------------------------------------
        # ITEM DATA
        # --------------------------------------------------------
        item_data = frappe.db.get_value(
            "Item",
            item_code,
            ["item_group", "brand"],
            as_dict=True
        )

        if not item_data:
            return

        item_group = item_data.item_group or ""
        brand = item_data.brand or ""

        # --------------------------------------------------------
        # PRICING RULES
        # --------------------------------------------------------
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
            (B2B_PRICE_LIST, B2B_CUSTOMER_GROUP),
            as_dict=True
        )

        if not rules:
            return

        matched_rules = []

        # --------------------------------------------------------
        # MATCH RULES
        # --------------------------------------------------------
        for rule in rules:
            apply_on = rule.apply_on
            rule_name = rule.name

            if apply_on == "Item Code":
                exists = frappe.db.exists(
                    "Pricing Rule Item Code",
                    {
                        "parent": rule_name,
                        "item_code": item_code
                    }
                )
                if exists:
                    matched_rules.append(rule)

            elif apply_on == "Item Group":
                exists = frappe.db.exists(
                    "Pricing Rule Item Group",
                    {
                        "parent": rule_name,
                        "item_group": ["in", [item_group, "All Item Groups"]]
                    }
                )
                if exists:
                    matched_rules.append(rule)

            elif apply_on == "Brand":
                if brand:
                    exists = frappe.db.exists(
                        "Pricing Rule Brand",
                        {
                            "parent": rule_name,
                            "brand": brand
                        }
                    )
                    if exists:
                        matched_rules.append(rule)

            elif apply_on == "Transaction" or not apply_on:
                matched_rules.append(rule)

        if not matched_rules:
            return

        # --------------------------------------------------------
        # WINNING RULE
        # --------------------------------------------------------
        def sort_key(rule):
            try:
                priority = int(rule.priority or 0)
            except (TypeError, ValueError):
                priority = 0

            return (
                -priority,
                RULE_TYPE_ORDER.get(rule.apply_on, 99),
                rule.creation
            )

        winning_rule = min(
            matched_rules,
            key=sort_key
        )

        if winning_rule.margin_type != "Percentage":
            return

        try:
            margin = float(
                winning_rule.margin_rate_or_amount or 0
            )
        except (TypeError, ValueError):
            return

        b2b_rate = round(buying_rate * (1 + margin / 100.0), 6)

        # --------------------------------------------------------
        # FIND & UPDATE / CREATE ITEM PRICE
        # --------------------------------------------------------
        existing = frappe.db.get_value(
            "Item Price",
            {
                "item_code": item_code,
                "price_list": B2B_PRICE_LIST,
                "uom": uom or "",
                "batch_no": batch_no or ""
            },
            ["name"],
            order_by="creation asc"
        )

        if existing:
            frappe.db.set_value(
                "Item Price",
                existing,
                {
                    "price_list_rate": b2b_rate,
                    "currency": currency,
                    "selling": 1
                },
                update_modified=False
            )
        else:
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

        frappe.db.commit()

    finally:
        frappe.flags.updating_b2b_price = False
