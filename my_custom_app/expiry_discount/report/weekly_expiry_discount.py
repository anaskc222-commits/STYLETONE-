import json

import frappe


def execute(filters=None):

    filters = frappe._dict(filters or {})

    snapshot = get_snapshot(filters)

    columns = get_columns()

    if not snapshot:
        return columns, []

    return columns, snapshot.get("rows", [])


def get_snapshot(filters):

    cache = frappe.cache()

    # ---------------------------------------------------------
    # Explicit date
    # ---------------------------------------------------------

    if filters.get("as_of_date"):

        warehouse = (
            filters.get("warehouse")
            or "Arakkinar Store - ST"
        )

        key = (
            f"weekly_expiry:"
            f"{warehouse}:"
            f"{filters.as_of_date}"
        )

    # ---------------------------------------------------------
    # Latest
    # ---------------------------------------------------------

    else:

        key = cache.get_value(
            "weekly_expiry:latest"
        )

        if not key:
            return None

    data = cache.get_value(key)

    if not data:
        return None

    if isinstance(data, str):
        return json.loads(data)

    return data


def get_columns():

    return [

        {
            "fieldname": "item_code",
            "label": "Item Code",
            "fieldtype": "Link",
            "options": "Item",
            "width": 150,
        },

        {
            "fieldname": "item_name",
            "label": "Item Name",
            "fieldtype": "Data",
            "width": 220,
        },

        {
            "fieldname": "batch_no",
            "label": "Batch No",
            "fieldtype": "Link",
            "options": "Batch",
            "width": 130,
        },

        {
            "fieldname": "expiry_date",
            "label": "Expiry Date",
            "fieldtype": "Date",
            "width": 110,
        },

        {
            "fieldname": "months_left",
            "label": "Months Left",
            "fieldtype": "Float",
            "width": 100,
        },

        {
            "fieldname": "expiry_remaining",
            "label": "Expiry Remaining",
            "fieldtype": "Data",
            "width": 145,
        },

        {
            "fieldname": "quantity_available",
            "label": "Quantity Available",
            "fieldtype": "Float",
            "width": 120,
        },

        {
            "fieldname": "mrp",
            "label": "MRP",
            "fieldtype": "Currency",
            "width": 110,
        },

        {
            "fieldname": "movement",
            "label": "Movement",
            "fieldtype": "Data",
            "width": 110,
        },

        {
            "fieldname": "minimum_safe_selling_price",
            "label": "Minimum Safe Selling Price",
            "fieldtype": "Currency",
            "width": 165,
        },

        {
            "fieldname": "maximum_safe_discount",
            "label": "Maximum Safe Discount",
            "fieldtype": "Percent",
            "width": 150,
        },

        {
            "fieldname": "recommended_discount",
            "label": "Recommended Discount",
            "fieldtype": "Percent",
            "width": 160,
        },

        {
            "fieldname": "recommended_selling_price",
            "label": "Recommended Selling Price",
            "fieldtype": "Currency",
            "width": 175,
        },

        {
            "fieldname": "action",
            "label": "Action",
            "fieldtype": "Data",
            "width": 150,
        },

    ]