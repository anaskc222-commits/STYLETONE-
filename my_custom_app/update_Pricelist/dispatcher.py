import frappe


B2B_PRICE_LIST = "B2B WHOLESALE"
SOURCE_PRICE_LIST = "Standard Buying"
B2B_CUSTOMER_GROUP = "Wholesale Store Clients"


RULE_SPECIFICITY = {
    "Item Code": 1,
    "Brand": 2,
    "Item Group": 3,
    "Transaction": 4,
    "": 4,
    None: 4,
}


def on_item_price_change(doc, method=None):
    """
    Lightweight Item Price event handler.

    Only Standard Buying prices are processed.
    B2B output prices are ignored.

    Actual pricing calculation runs in the background.
    """

    if not doc or not doc.item_code:
        return

    # Never process generated B2B prices.
    if doc.price_list == B2B_PRICE_LIST:
        return

    # Ignore every other price list.
    if doc.price_list != SOURCE_PRICE_LIST:
        return

    # On update, only enqueue when pricing-relevant
    # fields actually changed.
    if method == "on_update":
        relevant_fields = (
            "price_list_rate",
            "currency",
            "uom",
            "batch_no",
        )

        if not any(
            doc.has_value_changed(field)
            for field in relevant_fields
        ):
            return

    # Validate source buying rate.
    try:
        buying_rate = float(doc.price_list_rate or 0)
    except (TypeError, ValueError):
        return

    if buying_rate <= 0:
        return

    # Pass only the Item Price name.
    # The worker reloads the latest committed record.
    frappe.enqueue(
        method=(
            "my_custom_app.update_Pricelist.dispatcher."
            "process_b2b_price_background"
        ),
        queue="long",
        enqueue_after_commit=True,
        job_name=f"b2b_price_{doc.name}",
        item_price_name=doc.name,
    )


def process_b2b_price_background(item_price_name):
    """
    Background worker.

    Reloads the latest committed Standard Buying Item Price,
    loads active B2B Pricing Rules,
    finds the winning rule,
    calculates the B2B price,
    and updates the B2B Item Price.

    If the source Item Price was deleted, nothing is changed.
    Therefore the existing B2B price remains unchanged.
    """

    if not item_price_name:
        return

    # Reload latest committed source Item Price.
    source_price = frappe.db.get_value(
        "Item Price",
        item_price_name,
        [
            "name",
            "item_code",
            "price_list",
            "price_list_rate",
            "uom",
            "batch_no",
            "currency",
        ],
        as_dict=True,
    )

    # Source Item Price may have been deleted.
    # Keep the existing B2B price unchanged.
    if not source_price:
        return

    # Make sure this is still the source price list.
    if source_price.price_list != SOURCE_PRICE_LIST:
        return

    if not source_price.item_code:
        return

    # Validate buying rate.
    try:
        buying_rate = float(source_price.price_list_rate or 0)
    except (TypeError, ValueError):
        return

    if buying_rate <= 0:
        return

    # Load Item information.
    item_data = frappe.db.get_value(
        "Item",
        source_price.item_code,
        [
            "item_group",
            "brand",
            "disabled",
        ],
        as_dict=True,
    )

    if not item_data:
        return

    # Do not process disabled Items.
    if item_data.disabled:
        return

    # Load active Pricing Rules.
    rules = load_active_rules()

    if not rules:
        return

    # Find the applicable/winning rule.
    winning_rule = find_winning_rule(
        rules=rules,
        item_code=source_price.item_code,
        item_group=item_data.item_group or "",
        brand=item_data.brand or "",
    )

    if not winning_rule:
        return

    # Only percentage margins are supported.
    if winning_rule.margin_type != "Percentage":
        return

    try:
        margin = float(
            winning_rule.margin_rate_or_amount or 0
        )
    except (TypeError, ValueError):
        return

    # Calculate B2B selling price.
    b2b_rate = round(
        buying_rate * (1 + margin / 100.0),
        6,
    )

    # Update/create B2B Item Price.
    update_b2b_item_price(
        item_code=source_price.item_code,
        b2b_rate=b2b_rate,
        uom=source_price.uom or "",
        batch_no=source_price.batch_no or "",
        currency=source_price.currency,
    )


def load_active_rules():
    """
    Loads all active B2B Pricing Rules and their child
    conditions in bulk.

    No repeated exists() calls.
    """

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
        (
            B2B_PRICE_LIST,
            B2B_CUSTOMER_GROUP,
        ),
        as_dict=True,
    )

    if not rules:
        return []

    rule_names = [rule.name for rule in rules]

    # --------------------------------------------------
    # Item Code conditions
    # --------------------------------------------------

    item_code_map = {}

    rows = frappe.get_all(
        "Pricing Rule Item Code",
        filters={
            "parent": ["in", rule_names],
        },
        fields=[
            "parent",
            "item_code",
        ],
    )

    for row in rows:
        item_code_map.setdefault(
            row.parent,
            set(),
        ).add(row.item_code)

    # --------------------------------------------------
    # Item Group conditions
    # --------------------------------------------------

    item_group_map = {}

    rows = frappe.get_all(
        "Pricing Rule Item Group",
        filters={
            "parent": ["in", rule_names],
        },
        fields=[
            "parent",
            "item_group",
        ],
    )

    for row in rows:
        item_group_map.setdefault(
            row.parent,
            set(),
        ).add(row.item_group)

    # --------------------------------------------------
    # Brand conditions
    # --------------------------------------------------

    brand_map = {}

    rows = frappe.get_all(
        "Pricing Rule Brand",
        filters={
            "parent": ["in", rule_names],
        },
        fields=[
            "parent",
            "brand",
        ],
    )

    for row in rows:
        brand_map.setdefault(
            row.parent,
            set(),
        ).add(row.brand)

    # Attach condition maps to each rule.
    for rule in rules:
        rule["_item_codes"] = item_code_map.get(
            rule.name,
            set(),
        )

        rule["_item_groups"] = item_group_map.get(
            rule.name,
            set(),
        )

        rule["_brands"] = brand_map.get(
            rule.name,
            set(),
        )

    return rules


def find_winning_rule(
    rules,
    item_code,
    item_group,
    brand,
):
    """
    Determines the winning Pricing Rule.

    Selection order:

    1. Higher priority number
    2. Item Code specificity
    3. Brand specificity
    4. Item Group specificity
    5. Transaction specificity
    6. Older creation time
    """

    matched_rules = []

    for rule in rules:
        apply_on = rule.apply_on

        # ----------------------------------------------
        # Item Code rule
        # ----------------------------------------------

        if apply_on == "Item Code":

            if item_code in rule["_item_codes"]:
                matched_rules.append(rule)

        # ----------------------------------------------
        # Brand rule
        # ----------------------------------------------

        elif apply_on == "Brand":

            if brand and brand in rule["_brands"]:
                matched_rules.append(rule)

        # ----------------------------------------------
        # Item Group rule
        # ----------------------------------------------

        elif apply_on == "Item Group":

            groups = rule["_item_groups"]

            if (
                item_group in groups
                or "All Item Groups" in groups
            ):
                matched_rules.append(rule)

        # ----------------------------------------------
        # Transaction / global rule
        # ----------------------------------------------

        elif apply_on in (
            "Transaction",
            None,
            "",
        ):
            matched_rules.append(rule)

    if not matched_rules:
        return None

    def sort_key(rule):
        try:
            priority = int(rule.priority or 0)
        except (TypeError, ValueError):
            priority = 0

        specificity = RULE_SPECIFICITY.get(
            rule.apply_on,
            99,
        )

        return (
            -priority,
            specificity,
            rule.creation,
        )

    return min(
        matched_rules,
        key=sort_key,
    )


def update_b2b_item_price(
    item_code,
    b2b_rate,
    uom,
    batch_no,
    currency,
):
    """
    Updates an existing B2B Item Price or creates one.

    Existing B2B prices are never deleted by this process.
    """

    existing = frappe.db.get_value(
        "Item Price",
        {
            "item_code": item_code,
            "price_list": B2B_PRICE_LIST,
            "uom": uom or "",
            "batch_no": batch_no or "",
            "selling": 1,
        },
        [
            "name",
            "price_list_rate",
            "currency",
        ],
        order_by="creation asc",
        as_dict=True,
    )

    # --------------------------------------------------
    # Existing B2B Item Price
    # --------------------------------------------------

    if existing:

        try:
            old_rate = float(
                existing.price_list_rate or 0
            )
        except (TypeError, ValueError):
            old_rate = 0

        # Do not write if nothing changed.
        if (
            old_rate == b2b_rate
            and existing.currency == currency
        ):
            return

        # Direct DB update avoids triggering normal
        # Item Price hooks again.
        frappe.db.set_value(
            "Item Price",
            existing.name,
            {
                "price_list_rate": b2b_rate,
                "currency": currency,
            },
            update_modified=False,
        )

        return

    # --------------------------------------------------
    # Create new B2B Item Price
    # --------------------------------------------------

    new_price = frappe.new_doc("Item Price")

    new_price.item_code = item_code
    new_price.price_list = B2B_PRICE_LIST
    new_price.price_list_rate = b2b_rate
    new_price.currency = currency
    new_price.uom = uom or ""
    new_price.batch_no = batch_no or ""
    new_price.selling = 1
    new_price.valid_from = frappe.utils.today()

    new_price.insert(
        ignore_permissions=True,
    )
