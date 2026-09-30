import frappe


TARGET_PRICE_LISTS = {
    "B2B WHOLESALE",
    "SALOON",
    "BEAUTY PARLOUR",
}


def set_ignore_pricing_rule(doc, method=None):
    """
    Automatically set Ignore Pricing Rule for the custom selling
    price lists.

    The generated Item Price remains the transaction's starting rate.
    The user can still manually change the rate if ERPNext allows
    Price List Rate editing.
    """

    if not doc:
        return

    price_list = getattr(doc, "selling_price_list", None)

    if not price_list:
        return

    if price_list not in TARGET_PRICE_LISTS:
        return

    meta = frappe.get_meta(doc.doctype)

    if meta.has_field("ignore_pricing_rule"):
        doc.ignore_pricing_rule = 1
