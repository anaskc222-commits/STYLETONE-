import json

import frappe

from my_custom_app.expiry_discount.weekly_expiry import (
    build_weekly_snapshot,
)


WAREHOUSE = "Arakkinar Store - ST"


def execute(filters=None):

    filters = frappe._dict(filters or {})

    snapshot = get_snapshot(filters)

    if not snapshot:
        return get_columns(), []

    return (
        get_columns(),
        snapshot.get("rows", []),
    )


def get_snapshot(filters):

    cache = frappe.cache()

    if filters.get("as_of_date"):

        as_of_date = filters.get(
            "as_of_date"
        )

        key = (
            "weekly_expiry:"
            f"{as_of_date}"
        )

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
            "fieldname":
                "minimum_safe_selling_price",
            "label":
                "Minimum Safe Selling Price",
            "fieldtype": "Currency",
            "width": 165,
        },

        {
            "fieldname":
                "maximum_safe_discount",
            "label":
                "Maximum Safe Discount",
            "fieldtype": "Percent",
            "width": 150,
        },

        {
            "fieldname":
                "recommended_discount",
            "label":
                "Recommended Discount",
            "fieldtype": "Percent",
            "width": 160,
        },

        {
            "fieldname":
                "recommended_selling_price",
            "label":
                "Recommended Selling Price",
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