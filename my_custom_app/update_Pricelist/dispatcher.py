import frappe
from frappe.utils import today


SOURCE_PRICE_LIST = "Standard Buying"


PRICE_TARGETS = [
    {
        "price_list": "B2B WHOLESALE",
    },
    {
        "price_list": "SALOON",
    },
    {
        "price_list": "BEAUTY PARLOUR",
    },
]


# Lower number = more specific.
#
# Existing rule priority logic is preserved:
#
# Item Code > Brand > Item Group > Transaction
#
# Priority is evaluated first.
# Specificity is used when priorities are equal.
# Creation time is the final tie-breaker.
RULE_SPECIFICITY = {
    "Item Code": 1,
    "Brand": 2,
    "Item Group": 3,
    "Transaction": 4,
    "": 4,
    None: 4,
}


# ----------------------------------------------------------------------
# ITEM PRICE EVENT
# ----------------------------------------------------------------------

def on_item_price_change(doc, method=None):
    """
    Triggered when Item Price is inserted or updated.

    Standard Buying is the only source price list.

    B2B WHOLESALE, SALOON and BEAUTY PARLOUR are generated
    target price lists and are never treated as source prices.
    """

    if not doc:
        return

    if not doc.item_code:
        return

    target_price_lists = {
        target["price_list"]
        for target in PRICE_TARGETS
    }

    # Prevent target -> target loops.
    if doc.price_list in target_price_lists:
        return

    # Only Standard Buying is the source.
    if doc.price_list != SOURCE_PRICE_LIST:
        return

    # On update, only process pricing-relevant changes.
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

    if not doc.price_list_rate:
        return

    if doc.price_list_rate <= 0:
        return

    enqueue_b2b_price_job(doc.name)


def enqueue_b2b_price_job(item_price_name):
    """
    Enqueue one Standard Buying Item Price for processing.
    """

    frappe.enqueue(
        "my_custom_app.update_Pricelist.dispatcher."
        "process_b2b_price_background",
        queue="long",
        enqueue_after_commit=True,
        job_name=f"b2b_price_{item_price_name}",
        item_price_name=item_price_name,
    )


# ----------------------------------------------------------------------
# PURCHASE INVOICE EVENT
# ----------------------------------------------------------------------

def on_purchase_invoice_submit(doc, method=None):
    """
    Purchase Invoice safety trigger.

    Processing is delayed until after commit so that any Item Price
    created or updated during the Purchase Invoice transaction is
    already committed.
    """

    if not doc:
        return

    frappe.enqueue(
        "my_custom_app.update_Pricelist.dispatcher."
        "process_purchase_invoice_background",
        queue="long",
        enqueue_after_commit=True,
        job_name=f"purchase_invoice_b2b_{doc.name}",
        purchase_invoice_name=doc.name,
    )


def process_purchase_invoice_background(purchase_invoice_name):
    """
    Reload the committed Purchase Invoice and find Standard Buying
    Item Prices matching:

    - Item Code
    - UOM
    - Batch No

    Every matching Standard Buying Item Price is then processed.
    """

    if not frappe.db.exists(
        "Purchase Invoice",
        purchase_invoice_name
    ):
        return

    invoice = frappe.get_doc(
        "Purchase Invoice",
        purchase_invoice_name
    )

    source_price_names = set()

    for row in invoice.items:

        if not row.item_code:
            continue

        source_uom = row.uom or ""
        source_batch = row.batch_no or ""

        source_prices = frappe.get_all(
            "Item Price",
            filters={
                "item_code": row.item_code,
                "price_list": SOURCE_PRICE_LIST,
            },
            fields=[
                "name",
                "uom",
                "batch_no",
                "price_list_rate",
            ],
        )

        for source_price in source_prices:

            price_uom = source_price.uom or ""
            price_batch = source_price.batch_no or ""

            if price_uom != source_uom:
                continue

            if price_batch != source_batch:
                continue

            if not source_price.price_list_rate:
                continue

            if source_price.price_list_rate <= 0:
                continue

            source_price_names.add(
                source_price.name
            )

    for item_price_name in source_price_names:
        enqueue_b2b_price_job(item_price_name)


# ----------------------------------------------------------------------
# MAIN BACKGROUND PROCESSOR
# ----------------------------------------------------------------------

def process_b2b_price_background(item_price_name):
    """
    Read one Standard Buying Item Price and update all three
    custom target price lists.

    Standard Buying
        |
        +--> B2B WHOLESALE
        |
        +--> SALOON
        |
        +--> BEAUTY PARLOUR
    """

    if not frappe.db.exists(
        "Item Price",
        item_price_name
    ):
        return

    source = frappe.db.get_value(
        "Item Price",
        item_price_name,
        [
            "item_code",
            "price_list",
            "price_list_rate",
            "uom",
            "batch_no",
            "currency",
        ],
        as_dict=True,
    )

    if not source:
        return

    # Safety check.
    if source.price_list != SOURCE_PRICE_LIST:
        return

    if not source.item_code:
        return

    if not source.price_list_rate:
        return

    if source.price_list_rate <= 0:
        return

    # --------------------------------------------------------------
    # GET ITEM DATA
    # --------------------------------------------------------------

    item = frappe.db.get_value(
        "Item",
        source.item_code,
        [
            "item_group",
            "brand",
            "disabled",
        ],
        as_dict=True,
    )

    if not item:
        return

    if item.disabled:
        return

    item_group = item.item_group
    brand = item.brand

    # --------------------------------------------------------------
    # LOAD ACTIVE PRICING RULES
    # --------------------------------------------------------------

    rules = load_active_rules()

    # --------------------------------------------------------------
    # PROCESS ALL TARGET PRICE LISTS
    # --------------------------------------------------------------

    for target in PRICE_TARGETS:

        target_price_list = target["price_list"]

        winning_rule = find_winning_rule(
            rules=rules,
            price_list=target_price_list,
            item_code=source.item_code,
            item_group=item_group,
            brand=brand,
        )

        if not winning_rule:
            continue

        margin_type = winning_rule.margin_type
        margin_value = winning_rule.margin_rate_or_amount

        # Current implementation supports percentage margins.
        if margin_type != "Percentage":
            continue

        try:
            margin_value = float(
                margin_value or 0
            )
        except (TypeError, ValueError):
            continue

        buying_rate = float(
            source.price_list_rate
        )

        target_rate = buying_rate * (
            1 + (margin_value / 100)
        )

        if target_rate <= 0:
            continue

        update_target_item_price(
            item_code=source.item_code,
            price_list=target_price_list,
            price_list_rate=target_rate,
            uom=source.uom,
            batch_no=source.batch_no,
            currency=source.currency,
        )


# ----------------------------------------------------------------------
# LOAD PRICING RULES
# ----------------------------------------------------------------------

def load_active_rules():
    """
    Load active selling Pricing Rules for:

        B2B WHOLESALE
        SALOON
        BEAUTY PARLOUR

    IMPORTANT:

    Customer Group is NOT used.

    Price List determines which rule belongs to which
    target calculation.

    Pricing Rule field is 'disable' in this ERPNext version.
    """

    target_price_lists = [
        target["price_list"]
        for target in PRICE_TARGETS
    ]

    rules = frappe.get_all(
        "Pricing Rule",
        filters={
            "disable": 0,
            "selling": 1,
            "for_price_list": [
                "in",
                target_price_lists,
            ],
        },
        fields=[
            "name",
            "priority",
            "creation",
            "apply_on",
            "margin_type",
            "margin_rate_or_amount",
            "for_price_list",
        ],
        ignore_permissions=True,
        limit_page_length=0,
    )

    if not rules:
        return []

    rule_names = [
        rule.name
        for rule in rules
    ]

    # --------------------------------------------------------------
    # ITEM CODE CONDITIONS
    # --------------------------------------------------------------

    item_code_rows = frappe.get_all(
        "Pricing Rule Item Code",
        filters={
            "parent": [
                "in",
                rule_names,
            ],
        },
        fields=[
            "parent",
            "item_code",
        ],
        ignore_permissions=True,
        limit_page_length=0,
    )

    item_codes = {}

    for row in item_code_rows:

        item_codes.setdefault(
            row.parent,
            set()
        ).add(row.item_code)

    # --------------------------------------------------------------
    # ITEM GROUP CONDITIONS
    # --------------------------------------------------------------

    item_group_rows = frappe.get_all(
        "Pricing Rule Item Group",
        filters={
            "parent": [
                "in",
                rule_names,
            ],
        },
        fields=[
            "parent",
            "item_group",
        ],
        ignore_permissions=True,
        limit_page_length=0,
    )

    item_groups = {}

    for row in item_group_rows:

        item_groups.setdefault(
            row.parent,
            set()
        ).add(row.item_group)

    # --------------------------------------------------------------
    # BRAND CONDITIONS
    # --------------------------------------------------------------

    brand_rows = frappe.get_all(
        "Pricing Rule Brand",
        filters={
            "parent": [
                "in",
                rule_names,
            ],
        },
        fields=[
            "parent",
            "brand",
        ],
        ignore_permissions=True,
        limit_page_length=0,
    )

    brands = {}

    for row in brand_rows:

        brands.setdefault(
            row.parent,
            set()
        ).add(row.brand)

    # --------------------------------------------------------------
    # ATTACH CONDITIONS
    # --------------------------------------------------------------

    for rule in rules:

        rule.item_codes = item_codes.get(
            rule.name,
            set(),
        )

        rule.item_groups = item_groups.get(
            rule.name,
            set(),
        )

        rule.brands = brands.get(
            rule.name,
            set(),
        )

    return rules


# ----------------------------------------------------------------------
# FIND WINNING RULE
# ----------------------------------------------------------------------

def find_winning_rule(
    rules,
    price_list,
    item_code,
    item_group,
    brand,
):
    """
    Find the winning Pricing Rule.

    Customer Group is completely ignored.

    Matching:

        Item Code
        Brand
        Item Group
        Transaction

    Priority remains the first deciding factor.

    Specificity is the second factor.

    Creation time is the final tie-breaker.

    All Item Groups is treated as the default Item Group match.
    """

    matched_rules = []

    for rule in rules:

        # ----------------------------------------------------------
        # PRICE LIST
        # ----------------------------------------------------------

        if rule.for_price_list != price_list:
            continue

        apply_on = rule.apply_on or ""

        # ----------------------------------------------------------
        # ITEM CODE
        # ----------------------------------------------------------

        if apply_on == "Item Code":

            if item_code not in rule.item_codes:
                continue

        # ----------------------------------------------------------
        # BRAND
        # ----------------------------------------------------------

        elif apply_on == "Brand":

            if brand not in rule.brands:
                continue

        # ----------------------------------------------------------
        # ITEM GROUP
        # ----------------------------------------------------------

        elif apply_on == "Item Group":

            groups = rule.item_groups

            # Specific Item Group OR All Item Groups.
            if (
                "All Item Groups" not in groups
                and item_group not in groups
            ):
                continue

        # ----------------------------------------------------------
        # TRANSACTION
        # ----------------------------------------------------------

        elif apply_on in (
            "Transaction",
            "",
            None,
        ):
            pass

        else:
            continue

        matched_rules.append(rule)

    if not matched_rules:
        return None

    # --------------------------------------------------------------
    # PRIORITY + SPECIFICITY + CREATION
    # --------------------------------------------------------------

    def sort_key(rule):

        try:
            priority = int(
                rule.priority or 0
            )
        except (TypeError, ValueError):
            priority = 0

        specificity = RULE_SPECIFICITY.get(
            rule.apply_on,
            4,
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


# ----------------------------------------------------------------------
# CREATE / UPDATE TARGET ITEM PRICE
# ----------------------------------------------------------------------

def update_target_item_price(
    item_code,
    price_list,
    price_list_rate,
    uom=None,
    batch_no=None,
    currency=None,
):
    """
    Update existing target Item Price or create a new one.

    Target identity:

        Item Code
        Price List
        UOM
        Batch No
        Selling = 1
    """

    uom = uom or ""
    batch_no = batch_no or ""

    existing_prices = frappe.get_all(
        "Item Price",
        filters={
            "item_code": item_code,
            "price_list": price_list,
            "selling": 1,
        },
        fields=[
            "name",
            "creation",
            "uom",
            "batch_no",
        ],
        order_by="creation asc",
        ignore_permissions=True,
        limit_page_length=0,
    )

    target_name = None

    for price in existing_prices:

        existing_uom = price.uom or ""
        existing_batch = price.batch_no or ""

        if existing_uom != uom:
            continue

        if existing_batch != batch_no:
            continue

        target_name = price.name
        break

    # --------------------------------------------------------------
    # UPDATE EXISTING ITEM PRICE
    # --------------------------------------------------------------

    if target_name:

        values = {
            "price_list_rate": price_list_rate,
        }

        if currency:
            values["currency"] = currency

        frappe.db.set_value(
            "Item Price",
            target_name,
            values,
            update_modified=True,
        )

        return

    # --------------------------------------------------------------
    # CREATE NEW ITEM PRICE
    # --------------------------------------------------------------

    item_price = frappe.get_doc(
        {
            "doctype": "Item Price",
            "item_code": item_code,
            "price_list": price_list,
            "price_list_rate": price_list_rate,
            "selling": 1,
            "uom": uom or None,
            "batch_no": batch_no or None,
            "currency": currency,
            "valid_from": today(),
        }
    )

    item_price.insert(
        ignore_permissions=True
    )
