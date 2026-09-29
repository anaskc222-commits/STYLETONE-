import frappe


SOURCE_PRICE_LIST = "Standard Buying"


PRICE_TARGETS = [
    {
        "customer_group": "Wholesale Store Clients",
        "price_list": "B2B WHOLESALE",
    },
    {
        "customer_group": "Saloon",
        "price_list": "SALOON",
    },
    {
        "customer_group": "Beauty Parlour",
        "price_list": "BEAUTY PARLOUR",
    },
]


RULE_SPECIFICITY = {
    "Item Code": 1,
    "Brand": 2,
    "Item Group": 3,
    "Transaction": 4,
    "": 4,
    None: 4,
}


# ============================================================
# ITEM PRICE EVENT
# ============================================================

def on_item_price_change(doc, method=None):
    """
    Handles Standard Buying Item Price creation/update.

    Only Standard Buying is used as the source.

    Target price lists:
        - B2B WHOLESALE
        - SALOON
        - BEAUTY PARLOUR

    Retail is intentionally not handled here.
    """

    if not doc:
        return

    if not doc.item_code:
        return

    # Never process any custom target price list as a source.
    target_price_lists = {
        target["price_list"]
        for target in PRICE_TARGETS
    }

    if doc.price_list in target_price_lists:
        return

    # Only Standard Buying is our source.
    if doc.price_list != SOURCE_PRICE_LIST:
        return

    # On update, process only pricing-relevant changes.
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

    enqueue_b2b_price_job(doc.name)


def enqueue_b2b_price_job(item_price_name):
    """
    Enqueue one background job for one Standard Buying Item Price.
    """

    if not item_price_name:
        return

    frappe.enqueue(
        method=(
            "my_custom_app.update_Pricelist.dispatcher."
            "process_b2b_price_background"
        ),
        queue="long",
        enqueue_after_commit=True,
        job_name=f"b2b_price_{item_price_name}",
        item_price_name=item_price_name,
    )


# ============================================================
# PURCHASE INVOICE EVENT
# ============================================================

def on_purchase_invoice_submit(doc, method=None):
    """
    Handles Purchase Invoice submission/update-after-submit.

    ERPNext may create or update Standard Buying Item Price
    as part of Purchase Invoice processing.

    After the transaction commits, find the affected Standard
    Buying Item Prices and send them to the same pricing worker.

    Batch number and UOM are matched separately.
    """

    if not doc:
        return

    if not doc.items:
        return

    item_price_names = set()

    for invoice_item in doc.items:

        if not invoice_item.item_code:
            continue

        invoice_uom = (
            getattr(invoice_item, "uom", None)
            or ""
        )

        invoice_batch_no = (
            getattr(invoice_item, "batch_no", None)
            or ""
        )

        source_prices = frappe.get_all(
            "Item Price",
            filters={
                "item_code": invoice_item.item_code,
                "price_list": SOURCE_PRICE_LIST,
            },
            fields=[
                "name",
                "uom",
                "batch_no",
            ],
        )

        for source_price in source_prices:

            source_uom = (
                source_price.uom
                or ""
            )

            source_batch_no = (
                source_price.batch_no
                or ""
            )

            # Match UOM exactly.
            if source_uom != invoice_uom:
                continue

            # Match batch exactly.
            if source_batch_no != invoice_batch_no:
                continue

            item_price_names.add(
                source_price.name
            )

    # Enqueue only once per Item Price.
    for item_price_name in item_price_names:
        enqueue_b2b_price_job(item_price_name)


# ============================================================
# BACKGROUND WORKER
# ============================================================

def process_b2b_price_background(item_price_name):
    """
    Background worker.

    Reloads the latest committed Standard Buying Item Price,
    calculates prices for all configured customer groups,
    and updates/creates the corresponding selling Item Prices.

    If the source Item Price was deleted before this worker runs,
    nothing is changed.
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

    # Source Item Price may have been deleted.
    # Do not delete/change existing target prices.
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

    if not item_data:
        return

    if item_data.disabled:
        return

    rules = load_active_rules()

    if not rules:
        return

    # Process every configured customer group separately.
    for target in PRICE_TARGETS:

        target_price_list = target["price_list"]
        customer_group = target["customer_group"]

        winning_rule = find_winning_rule(
            rules=rules,
            price_list=target_price_list,
            customer_group=customer_group,
            item_code=source_price.item_code,
            item_group=item_data.item_group or "",
            brand=item_data.brand or "",
        )

        if not winning_rule:
            continue

        if winning_rule.margin_type != "Percentage":
            continue

        try:
            margin = float(
                winning_rule.margin_rate_or_amount or 0
            )
        except (TypeError, ValueError):
            continue

        target_rate = round(
            buying_rate * (1 + margin / 100.0),
            6,
        )

        update_target_item_price(
            item_code=source_price.item_code,
            target_price_list=target_price_list,
            target_rate=target_rate,
            uom=source_price.uom or "",
            batch_no=source_price.batch_no or "",
            currency=source_price.currency,
        )


# ============================================================
# PRICING RULE LOADING
# ============================================================

def load_active_rules():
    """
    Load all active Pricing Rules used by the three
    custom customer groups.

    Child table conditions are loaded in bulk.
    """

    target_price_lists = [
        target["price_list"]
        for target in PRICE_TARGETS
    ]

    customer_groups = [
        target["customer_group"]
        for target in PRICE_TARGETS
    ]

    rules = frappe.db.sql(
        """
        SELECT
            name,
            priority,
            creation,
            apply_on,
            margin_type,
            margin_rate_or_amount,
            for_price_list,
            customer_group
        FROM `tabPricing Rule`
        WHERE selling = 1
          AND disable = 0
          AND docstatus < 2
          AND for_price_list IN %(price_lists)s
          AND customer_group IN %(customer_groups)s
        ORDER BY priority DESC, creation ASC
        """,
        {
            "price_lists": tuple(target_price_lists),
            "customer_groups": tuple(customer_groups),
        },
        as_dict=True,
    )

    if not rules:
        return []

    rule_names = [
        rule.name
        for rule in rules
    ]

    # --------------------------------------------------------
    # Item Code
    # --------------------------------------------------------

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

    # --------------------------------------------------------
    # Item Group
    # --------------------------------------------------------

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

    # --------------------------------------------------------
    # Brand
    # --------------------------------------------------------

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

    # Attach child conditions to each rule.
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


# ============================================================
# PRICING RULE MATCHING
# ============================================================

def find_winning_rule(
    rules,
    price_list,
    customer_group,
    item_code,
    item_group,
    brand,
):
    """
    Find the winning Pricing Rule for one target price list
    and customer group.

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

        if rule.for_price_list != price_list:
            continue

        if rule.customer_group != customer_group:
            continue

        apply_on = rule.apply_on

        # ----------------------------------------------------
        # Item Code
        # ----------------------------------------------------

        if apply_on == "Item Code":

            if item_code in rule["_item_codes"]:
                matched_rules.append(rule)

        # ----------------------------------------------------
        # Brand
        # ----------------------------------------------------

        elif apply_on == "Brand":

            if brand and brand in rule["_brands"]:
                matched_rules.append(rule)

        # ----------------------------------------------------
        # Item Group
        # ----------------------------------------------------

        elif apply_on == "Item Group":

            groups = rule["_item_groups"]

            if (
                item_group in groups
                or "All Item Groups" in groups
            ):
                matched_rules.append(rule)

        # ----------------------------------------------------
        # Transaction
        # ----------------------------------------------------

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
            priority = int(
                rule.priority or 0
            )
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


# ============================================================
# TARGET ITEM PRICE UPDATE
# ============================================================

def update_target_item_price(
    item_code,
    target_price_list,
    target_rate,
    uom,
    batch_no,
    currency,
):
    """
    Update an existing target Item Price or create one.

    Matching is:

        Item
        + Price List
        + UOM
        + Batch
        + Selling

    Existing target Item Prices are never deleted.
    """

    existing = frappe.db.get_value(
        "Item Price",
        {
            "item_code": item_code,
            "price_list": target_price_list,
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

    # --------------------------------------------------------
    # Existing target price
    # --------------------------------------------------------

    if existing:

        try:
            old_rate = float(
                existing.price_list_rate or 0
            )
        except (TypeError, ValueError):
            old_rate = 0

        if (
            round(old_rate, 6)
            == round(target_rate, 6)
            and existing.currency == currency
        ):
            return

        frappe.db.set_value(
            "Item Price",
            existing.name,
            {
                "price_list_rate": target_rate,
                "currency": currency,
            },
            update_modified=False,
        )

        return

    # --------------------------------------------------------
    # Create target price
    # --------------------------------------------------------

    new_price = frappe.new_doc(
        "Item Price"
    )

    new_price.item_code = item_code
    new_price.price_list = target_price_list
    new_price.price_list_rate = target_rate
    new_price.currency = currency
    new_price.uom = uom or ""
    new_price.batch_no = batch_no or ""
    new_price.selling = 1
    new_price.valid_from = frappe.utils.today()

    new_price.insert(
        ignore_permissions=True,
    )
