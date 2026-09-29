import frappe


B2B_PRICE_LIST = "B2B WHOLESALE"
SOURCE_PRICE_LIST = "Standard Buying"
B2B_CUSTOMER_GROUP = "Wholesale Store Clients"

BATCH_SIZE = 250

RULE_SPECIFICITY = {
    "Item Code": 1,
    "Brand": 2,
    "Item Group": 3,
    "Transaction": 4,
    "": 4,
    None: 4,
}


# =========================================================
# ITEM PRICE EVENT
# =========================================================

def on_item_price_change(doc, method=None):
    """
    Very lightweight event handler.

    Only Standard Buying prices are sent to the background
    worker. B2B output prices are ignored.
    """

    if not doc or not doc.item_code:
        return

    # Never process our own generated B2B price.
    if doc.price_list == B2B_PRICE_LIST:
        return

    # Ignore every other Item Price.
    if doc.price_list != SOURCE_PRICE_LIST:
        return

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
        queue="long",
        enqueue_after_commit=True,
        job_name=f"b2b_item_price_{doc.name}",
        item_price_name=doc.name,
    )


# =========================================================
# SINGLE ITEM PRICE BACKGROUND JOB
# =========================================================

def process_b2b_price_background(item_price_name):
    """
    Processes one Standard Buying Item Price.

    The latest committed Item Price is loaded again so that
    queued jobs don't use stale values.
    """

    if not item_price_name:
        return

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

    if not source_price:
        return

    if source_price.price_list != SOURCE_PRICE_LIST:
        return

    if not source_price.item_code:
        return

    try:
        buying_rate = float(
            source_price.price_list_rate or 0
        )
    except (TypeError, ValueError):
        return

    if buying_rate <= 0:
        return

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

    if not item_data or item_data.disabled:
        return

    rules = load_active_rules()

    if not rules:
        return

    winning_rule = find_winning_rule(
        rules=rules,
        item_code=source_price.item_code,
        item_group=item_data.item_group or "",
        brand=item_data.brand or "",
    )

    if not winning_rule:
        return

    update_from_rule(
        source_price=source_price,
        winning_rule=winning_rule,
    )


# =========================================================
# LOAD ALL ACTIVE RULES ONCE
# =========================================================

def load_active_rules():
    """
    Loads all active B2B Pricing Rules and their conditions.

    This is deliberately done in bulk instead of using
    frappe.db.exists() repeatedly for every Item.
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


# =========================================================
# FIND WINNING RULE
# =========================================================

def find_winning_rule(
    rules,
    item_code,
    item_group,
    brand,
):
    """
    Rule priority:

    1. Higher priority number
    2. Item Code
    3. Brand
    4. Item Group
    5. Transaction
    6. Older rule if everything else is equal
    """

    matched = []

    for rule in rules:
        apply_on = rule.apply_on

        if apply_on == "Item Code":

            if item_code in rule["_item_codes"]:
                matched.append(rule)

        elif apply_on == "Brand":

            if brand and brand in rule["_brands"]:
                matched.append(rule)

        elif apply_on == "Item Group":

            groups = rule["_item_groups"]

            if (
                item_group in groups
                or "All Item Groups" in groups
            ):
                matched.append(rule)

        elif apply_on in (
            "Transaction",
            "",
            None,
        ):
            matched.append(rule)

    if not matched:
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
        matched,
        key=sort_key,
    )


# =========================================================
# APPLY RULE
# =========================================================

def update_from_rule(
    source_price,
    winning_rule,
):
    if winning_rule.margin_type != "Percentage":
        return

    try:
        margin = float(
            winning_rule.margin_rate_or_amount or 0
        )
    except (TypeError, ValueError):
        return

    try:
        buying_rate = float(
            source_price.price_list_rate or 0
        )
    except (TypeError, ValueError):
        return

    if buying_rate <= 0:
        return

    b2b_rate = round(
        buying_rate * (1 + margin / 100.0),
        6,
    )

    update_b2b_item_price(
        item_code=source_price.item_code,
        b2b_rate=b2b_rate,
        uom=source_price.uom or "",
        batch_no=source_price.batch_no or "",
        currency=source_price.currency,
    )


# =========================================================
# FULL REBUILD
# =========================================================

def rebuild_all_b2b_prices():
    """
    Full B2B rebuild.

    Used when a Pricing Rule is inserted, edited,
    disabled, or deleted.

    Rules are loaded ONCE.

    Source Item Prices are processed in batches.

    No background job is created for individual Items.
    """

    rules = load_active_rules()

    if not rules:
        return

    offset = 0

    while True:

        source_prices = frappe.get_all(
            "Item Price",
            filters={
                "price_list": SOURCE_PRICE_LIST,
            },
            fields=[
                "name",
                "item_code",
                "price_list_rate",
                "uom",
                "batch_no",
                "currency",
            ],
            limit_start=offset,
            limit_page_length=BATCH_SIZE,
            order_by="name asc",
        )

        if not source_prices:
            break

        item_codes = {
            row.item_code
            for row in source_prices
            if row.item_code
        }

        if not item_codes:
            offset += BATCH_SIZE
            continue

        # One Item query for the entire batch.
        item_rows = frappe.get_all(
            "Item",
            filters={
                "name": ["in", list(item_codes)],
                "disabled": 0,
            },
            fields=[
                "name",
                "item_group",
                "brand",
            ],
        )

        item_map = {
            row.name: row
            for row in item_rows
        }

        for source_price in source_prices:

            item_data = item_map.get(
                source_price.item_code
            )

            if not item_data:
                continue

            winning_rule = find_winning_rule(
                rules=rules,
                item_code=source_price.item_code,
                item_group=item_data.item_group or "",
                brand=item_data.brand or "",
            )

            if not winning_rule:
                continue

            update_from_rule(
                source_price=source_price,
                winning_rule=winning_rule,
            )

        offset += BATCH_SIZE


# =========================================================
# B2B ITEM PRICE UPDATE
# =========================================================

def update_b2b_item_price(
    item_code,
    b2b_rate,
    uom,
    batch_no,
    currency,
):
    """
    Updates an existing B2B price or creates one.

    Existing records use direct DB update to avoid
    unnecessary document events.
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

    if existing:

        try:
            old_rate = float(
                existing.price_list_rate or 0
            )
        except (TypeError, ValueError):
            old_rate = 0

        if (
            old_rate == b2b_rate
            and existing.currency == currency
        ):
            return

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
