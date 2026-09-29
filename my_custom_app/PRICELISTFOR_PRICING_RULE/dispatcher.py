

import frappe


B2B_PRICE_LIST = "B2B WHOLESALE"
B2B_CUSTOMER_GROUP = "Wholesale Store Clients"
SOURCE_PRICE_LIST = "Standard Buying"


def trigger_from_pricing_rule(doc, method=None):
    """
    Lightweight Pricing Rule event handler.
    Enqueues recalculation after the transaction commits.
    """

    if not doc:
        return

    if doc.for_price_list != B2B_PRICE_LIST:
        return

    if doc.customer_group != B2B_CUSTOMER_GROUP:
        return

    if doc.selling != 1:
        return

    frappe.enqueue(
        method=(
            "my_custom_app.b2b_pricing.dispatcher."
            "rebuild_for_pricing_rule"
        ),
        queue="long",
        enqueue_after_commit=True,
        job_name=f"b2b_rule_rebuild_{doc.name}",
        rule_name=doc.name,
    )


def rebuild_for_pricing_rule(rule_name):
    """
    Finds source Item Prices affected by a Pricing Rule
    and enqueues B2B recalculation jobs.
    """

    rule = frappe.db.get_value(
        "Pricing Rule",
        rule_name,
        [
            "name",
            "apply_on",
            "selling",
            "disable",
            "docstatus",
            "for_price_list",
            "customer_group",
        ],
        as_dict=True,
    )

    if not rule:
        return

    if rule.for_price_list != B2B_PRICE_LIST:
        return

    if rule.customer_group != B2B_CUSTOMER_GROUP:
        return

    if not rule.selling or rule.disable:
        return

    if rule.docstatus >= 2:
        return

    item_codes = set()

    if rule.apply_on == "Item Code":
        item_codes = {
            row.item_code
            for row in frappe.get_all(
                "Pricing Rule Item Code",
                filters={"parent": rule_name},
                fields=["item_code"],
            )
            if row.item_code
        }

    elif rule.apply_on == "Brand":
        brands = {
            row.brand
            for row in frappe.get_all(
                "Pricing Rule Brand",
                filters={"parent": rule_name},
                fields=["brand"],
            )
            if row.brand
        }

        if brands:
            item_codes = {
                row.name
                for row in frappe.get_all(
                    "Item",
                    filters={
                        "brand": ["in", list(brands)],
                        "disabled": 0,
                    },
                    fields=["name"],
                )
            }

    elif rule.apply_on == "Item Group":
        groups = {
            row.item_group
            for row in frappe.get_all(
                "Pricing Rule Item Group",
                filters={"parent": rule_name},
                fields=["item_group"],
            )
            if row.item_group
        }

        if "All Item Groups" in groups:
            groups = set(
                frappe.get_all(
                    "Item Group",
                    fields=["name"],
                    pluck="name",
                )
            )

        if groups:
            item_codes = {
                row.name
                for row in frappe.get_all(
                    "Item",
                    filters={
                        "item_group": ["in", list(groups)],
                        "disabled": 0,
                    },
                    fields=["name"],
                )
            }

    elif rule.apply_on in ("Transaction", None, ""):
        item_codes = {
            row.item_code
            for row in frappe.get_all(
                "Item Price",
                filters={
                    "price_list": SOURCE_PRICE_LIST,
                    "selling": 0,
                },
                fields=["item_code"],
                distinct=True,
            )
            if row.item_code
        }

    if not item_codes:
        return

    for item_code in item_codes:
        source_prices = frappe.get_all(
            "Item Price",
            filters={
                "item_code": item_code,
                "price_list": SOURCE_PRICE_LIST,
                "selling": 0,
            },
            fields=[
                "name",
                "item_code",
                "price_list_rate",
                "uom",
                "batch_no",
                "currency",
            ],
        )

        for source_price in source_prices:
            try:
                buying_rate = float(
                    source_price.price_list_rate or 0
                )
            except (TypeError, ValueError):
                continue

            if buying_rate <= 0:
                continue

            frappe.enqueue(
                method=(
                    "my_custom_app.update_Pricelist.dispatcher."
                    "process_b2b_price_background"
                ),
                queue="long",
                enqueue_after_commit=True,
                job_name=f"b2b_price_{source_price.name}",
                item_code=source_price.item_code,
                price_list_rate=buying_rate,
                uom=source_price.uom or "",
                batch_no=source_price.batch_no or "",
                currency=source_price.currency,
            )
