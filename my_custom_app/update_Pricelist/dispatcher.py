import frappe

def background_update_b2b_price(doc, method=None):
    """
    Dispatcher function: Triggered by Item Price doc_events.
    Instantly queues the heavy lifting into Frappe's background worker.
    """
    # Only fire for standard buying prices
    if doc.price_list != "Standard Buying" or doc.selling:
        return

    if frappe.flags.get("updating_b2b_price"):
        return

    frappe.enqueue(
        method="my_custom_app.update_Pricelist.worker.process_b2b_price_background",
        queue="short",
        timeout=300,
        is_async=True,
        enqueue_after_commit=True,
        item_code=doc.item_code,
        price_list_rate=doc.price_list_rate,
        uom=getattr(doc, "uom", ""),
        batch_no=getattr(doc, "batch_no", ""),
        currency=doc.currency
    )
