# apps/my_custom_app/my_custom_app/dashboard.py


import frappe
from frappe import _
from frappe.utils import add_months, getdate, nowdate
from pos_next.api.dashboard import get_day_book as _get_day_book

@frappe.whitelist()
def get_store_day_book(filters=None):
    frappe.has_permission("Sales Invoice", throw=True)
    
    # Parse filters into dict if passed as JSON string
    if isinstance(filters, str):
        filters = frappe.parse_json(filters) or {}
    elif not isinstance(filters, dict):
        filters = {}

    user = frappe.session.user
    user_roles = frappe.get_roles(user)

    # Roles allowed unlimited historical date access
    unrestricted_roles = ["System Manager", "Accounts Manager"]

    # Enforce 2-month restriction for restricted roles
    if not any(role in user_roles for role in unrestricted_roles):
        from_date = getdate(filters.get("from_date") or nowdate())
        to_date = getdate(filters.get("to_date") or nowdate())

        today = getdate(nowdate())
        first_of_this_month = today.replace(day=1)
        min_allowed_date = add_months(first_of_this_month, -1)

        if from_date < min_allowed_date:
            filters["from_date"] = str(min_allowed_date)

        if to_date > today:
            filters["to_date"] = str(today)

    return _get_day_book(filters)
