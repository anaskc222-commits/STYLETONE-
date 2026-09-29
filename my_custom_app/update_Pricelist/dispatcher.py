import frappe


def on_item_price_change(doc, method=None):
    frappe.log_error(
        message=(
            f"EVENT FIRED\n"
            f"Method: {method}\n"
            f"Name: {doc.name}\n"
            f"Item: {doc.item_code}\n"
            f"Price List: {doc.price_list}\n"
            f"Rate: {doc.price_list_rate}"
        ),
        title="B2B TEST - ITEM PRICE",
    )
