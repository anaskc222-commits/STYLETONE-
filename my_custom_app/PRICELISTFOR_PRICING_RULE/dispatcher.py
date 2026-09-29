import frappe


SOURCE_PRICE_LIST = "Standard Buying"


TARGET_PRICE_LISTS = {
    "B2B WHOLESALE",
    "SALOON",
    "BEAUTY PARLOUR",
}


# ----------------------------------------------------------------------
# PRICING RULE EVENT
# ----------------------------------------------------------------------

def trigger_from_pricing_rule(doc, method=None):
    """
    Triggered when a Pricing Rule is created or updated.

    Customer Group is intentionally ignored.

    Only our three target Price Lists trigger the custom process.
    """

    if not doc:
        return

    if doc.for_price_list not in TARGET_PRICE_LISTS:
        return

    frappe.enqueue(
        "my_custom_app.PRICELISTFOR_PRICING_RULE.dispatcher."
        "process_pricing_rule_background",
        queue="long",
        enqueue_after_commit=True,
        job_name=f"pricing_rule_refresh_{doc.name}",
        pricing_rule_name=doc.name,
    )


# ----------------------------------------------------------------------
# BACKGROUND PRICING RULE PROCESSOR
# ----------------------------------------------------------------------

def process_pricing_rule_background(
    pricing_rule_name
):
    """
    Reload the committed Pricing Rule.

    Find affected Standard Buying Item Prices and enqueue them
    for recalculation.
    """

    if not frappe.db.exists(
        "Pricing Rule",
        pricing_rule_name
    ):
        return

    rule = frappe.get_doc(
        "Pricing Rule",
        pricing_rule_name
    )

    if rule.for_price_list not in TARGET_PRICE_LISTS:
        return

    item_codes = get_affected_item_codes(
        rule
    )

    # None means the rule affects all items.
    if item_codes is None:

        source_prices = frappe.get_all(
            "Item Price",
            filters={
                "price_list": SOURCE_PRICE_LIST,
            },
            pluck="name",
            ignore_permissions=True,
            limit_page_length=0,
        )

    elif not item_codes:

        return

    else:

        source_prices = frappe.get_all(
            "Item Price",
            filters={
                "price_list": SOURCE_PRICE_LIST,
                "item_code": [
                    "in",
                    list(item_codes),
                ],
            },
            pluck="name",
            ignore_permissions=True,
            limit_page_length=0,
        )

    for item_price_name in source_prices:

        frappe.enqueue(
            "my_custom_app.update_Pricelist.dispatcher."
            "process_b2b_price_background",
            queue="long",
            enqueue_after_commit=True,
            job_name=f"b2b_price_{item_price_name}",
            item_price_name=item_price_name,
        )


# ----------------------------------------------------------------------
# FIND AFFECTED ITEMS
# ----------------------------------------------------------------------

def get_affected_item_codes(rule):
    """
    Return:

        set(item_codes)
            for Item Code / Item Group / Brand rules

        None
            when the rule affects all items.

    Customer Group is never considered.
    """

    apply_on = rule.apply_on or ""

    # --------------------------------------------------------------
    # ITEM CODE
    # --------------------------------------------------------------

    if apply_on == "Item Code":

        rows = frappe.get_all(
            "Pricing Rule Item Code",
            filters={
                "parent": rule.name,
            },
            fields=[
                "item_code",
            ],
            ignore_permissions=True,
            limit_page_length=0,
        )

        return {
            row.item_code
            for row in rows
            if row.item_code
        }

    # --------------------------------------------------------------
    # ITEM GROUP
    # --------------------------------------------------------------

    if apply_on == "Item Group":

        rows = frappe.get_all(
            "Pricing Rule Item Group",
            filters={
                "parent": rule.name,
            },
            fields=[
                "item_group",
            ],
            ignore_permissions=True,
            limit_page_length=0,
        )

        groups = {
            row.item_group
            for row in rows
            if row.item_group
        }

        # All Item Groups = default/all items.
        if "All Item Groups" in groups:
            return None

        # No group specified = treat as all items.
        if not groups:
            return None

        items = frappe.get_all(
            "Item",
            filters={
                "item_group": [
                    "in",
                    list(groups),
                ],
                "disabled": 0,
            },
            pluck="name",
            ignore_permissions=True,
            limit_page_length=0,
        )

        return set(items)

    # --------------------------------------------------------------
    # BRAND
    # --------------------------------------------------------------

    if apply_on == "Brand":

        rows = frappe.get_all(
            "Pricing Rule Brand",
            filters={
                "parent": rule.name,
            },
            fields=[
                "brand",
            ],
            ignore_permissions=True,
            limit_page_length=0,
        )

        brands = {
            row.brand
            for row in rows
            if row.brand
        }

        if not brands:
            return None

        items = frappe.get_all(
            "Item",
            filters={
                "brand": [
                    "in",
                    list(brands),
                ],
                "disabled": 0,
            },
            pluck="name",
            ignore_permissions=True,
            limit_page_length=0,
        )

        return set(items)

    # --------------------------------------------------------------
    # TRANSACTION / GENERIC RULE
    # --------------------------------------------------------------

    if apply_on in (
        "Transaction",
        "",
        None,
    ):
        return None

    return None
