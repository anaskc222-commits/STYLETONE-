import frappe

def background_update_b2b_price(item_code, price_list_rate, uom=None, batch_no=None, currency=None):
    frappe.enqueue(
        method="my_custom_app.my_custom_app.utils.process_b2b_price_background",
        queue="short",
        timeout=300,
        is_async=True,
        enqueue_after_commit=True,
        item_code=item_code,
        price_list_rate=price_list_rate,
        uom=uom,
        batch_no=batch_no,
        currency=currency
    )

def process_b2b_price_background(item_code, price_list_rate, uom=None, batch_no=None, currency=None):
    if frappe.flags.get("updating_b2b_price"):
        return

    frappe.flags.updating_b2b_price = True

    try:
        buying_rate = float(price_list_rate or 0)
        if buying_rate <= 0:
            return

        b2b_price_list = "B2B Selling"
        b2b_customer_group = "B2B"

        RULE_TYPE_ORDER = {"Item Code": 1, "Item Group": 2, "Brand": 3, "Transaction": 4}

        item_data = frappe.db.get_value("Item", item_code, ["item_group", "brand", "stock_uom"], as_dict=True)
        if not item_data:
            return

        item_group = item_data.item_group or ""
        brand = item_data.brand or ""
        target_uom = uom or item_data.stock_uom or ""

        rules = frappe.db.sql("""
            SELECT name, priority, creation, apply_on, margin_type, margin_rate_or_amount
            FROM `tabPricing Rule`
            WHERE selling = 1 AND disable = 0 AND docstatus < 2
              AND (for_price_list = %s OR ifnull(for_price_list, '') = '')
              AND (customer_group = %s OR ifnull(customer_group, '') = '')
            ORDER BY priority DESC, creation ASC
        """, (b2b_price_list, b2b_customer_group), as_dict=True)

        if not rules:
            return

        matched_rules = []
        for rule in rules:
            apply_on = rule.apply_on
            rule_name = rule.name

            if apply_on == "Item Code":
                if frappe.db.exists("Pricing Rule Item Code", {"parent": rule_name, "item_code": item_code}):
                    matched_rules.append(rule)
            elif apply_on == "Item Group":
                if frappe.db.exists("Pricing Rule Item Group", {"parent": rule_name, "item_group": ["in", [item_group, "All Item Groups"]]}):
                    matched_rules.append(rule)
            elif apply_on == "Brand":
                if brand and frappe.db.exists("Pricing Rule Brand", {"parent": rule_name, "brand": brand}):
                    matched_rules.append(rule)
            elif apply_on == "Transaction" or not apply_on:
                matched_rules.append(rule)

        if not matched_rules:
            return

        def sort_key(rule):
            return (-int(rule.priority or 0), RULE_TYPE_ORDER.get(rule.apply_on, 99), rule.creation)

        winning_rule = min(matched_rules, key=sort_key)
        if winning_rule.margin_type != "Percentage":
            return

        margin = float(winning_rule.margin_rate_or_amount or 0)
        b2b_rate = buying_rate * (1.0 + margin / 100.0)

        filters = {
            "item_code": item_code,
            "price_list": b2b_price_list,
            "uom": target_uom,
            "batch_no": batch_no or ""
        }

        existing_price = frappe.db.get_value("Item Price", filters, "name")

        if existing_price:
            frappe.db.set_value("Item Price", existing_price, {
                "price_list_rate": b2b_rate,
                "currency": currency,
           
