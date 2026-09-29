import frappe


def test_event(doc, method=None):
    frappe.log_error(
        message=f"HOOK WORKING\nDocType: {doc.doctype}\nName: {doc.name}\nMethod: {method}",
        title="STYLETONE HOOK TEST",
    )
