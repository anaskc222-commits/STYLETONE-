
import frappe

BUYING_PRICE_LIST = "Standard Buying"
TARGET_PRICE_LIST = "B2B WHOLESALE"
TARGET_CUSTOMER_GROUP = "Wholesale Store Clients"

def background_update_b2b_price(
    item_code,
    price_list_rate,
    uom="",
    batch_no="",
    currency=None
):
    """
    Dispatcher function: Instantly queues the heavy lifting into Frappe's background worker.
    """
    if frappe.flags.get("updating_b2b_price"):
        return

    frappe.enqueue(
        method="my_custom_app.b2b_pricing.worker.process_b2b_price_background",
        queue="short",
        timeout=300,
        is_async=True,
        enqueue_after_commit=True,
        item_code=item_code,
        price_list_rate=price_list_rate,
        uom=uom,
        batch_no=batch_no,
        currency=currency
    )
