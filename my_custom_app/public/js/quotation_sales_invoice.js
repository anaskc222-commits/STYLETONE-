(() => {
    "use strict";

    if (window.__styleToneQuotationBatchMappingV3) return;
    window.__styleToneQuotationBatchMappingV3 = true;

    const PREFIX = "[STYLETONE Quotation Batch Mapping]";

    const SALES_ORDER_METHOD =
        "erpnext.selling.doctype.quotation.quotation.make_sales_order";

    const SALES_INVOICE_METHOD =
        "erpnext.selling.doctype.quotation.quotation.make_sales_invoice";

    /*
     * Find the original Quotation Item corresponding to a mapped row.
     * Prefer the source-row link fields created by ERPNext's mapper.
     */
    function findSourceRow(targetRow, sourceRows, targetIndex) {
        const sourceLinkFields = [
            "quotation_item",
            "prevdoc_detail_docname"
        ];

        for (const field of sourceLinkFields) {
            const sourceName = targetRow[field];

            if (sourceName) {
                const matched = sourceRows.find(
                    row => row.name === sourceName
                );

                if (matched) return matched;
            }
        }

        /*
         * Index matching is safe only when both tables have the same
         * number of rows and the item codes agree.
         */
        if (
            sourceRows.length === (targetRow.__source_count || 0) &&
            sourceRows[targetIndex] &&
            sourceRows[targetIndex].item_code === targetRow.item_code
        ) {
            return sourceRows[targetIndex];
        }

        /*
         * If the item occurs only once in the source, a unique item-code
         * match is safe even when the target contains fewer rows.
         */
        const matches = sourceRows.filter(
            row => row.item_code === targetRow.item_code
        );

        if (matches.length === 1) return matches[0];

        return null;
    }

    /*
     * Register a guard so batch numbers are copied before Frappe opens
     * the mapped Sales Order or Sales Invoice.
     */
    if (
        frappe.model.add_mapped_doc_guard &&
        !window.__styleToneQuotationBatchGuardRegistered
    ) {
        window.__styleToneQuotationBatchGuardRegistered = true;

        frappe.model.add_mapped_doc_guard(async (mappedDoc, opts) => {
            const method = opts && opts.method;

            if (
                method !== SALES_ORDER_METHOD &&
                method !== SALES_INVOICE_METHOD
            ) {
                return true;
            }

            const sourceForm = opts && opts.frm;

            if (
                !sourceForm ||
                sourceForm.doctype !== "Quotation"
            ) {
                return true;
            }

            if (
                !mappedDoc ||
                !["Sales Order", "Sales Invoice"].includes(
                    mappedDoc.doctype
                ) ||
                !Array.isArray(mappedDoc.items)
            ) {
                return true;
            }

            const sourceRows = sourceForm.doc.items || [];
            const targetRows = mappedDoc.items;

            let copied = 0;
            let skipped = 0;

            targetRows.forEach((targetRow, targetIndex) => {
                const rowForMatching = {
                    ...targetRow,
                    __source_count: sourceRows.length
                };

                const sourceRow = findSourceRow(
                    rowForMatching,
                    sourceRows,
                    targetIndex
                );

                if (!sourceRow) {
                    skipped++;
                    console.warn(
                        PREFIX + " Could not safely match mapped row.",
                        {
                            target_doctype: mappedDoc.doctype,
                            target_item: targetRow.item_code,
                            target_row: targetRow.name
                        }
                    );
                    return;
                }

                const batchNo = sourceRow.custom_batch_no;

                if (!batchNo) return;

                if (targetRow.item_code !== sourceRow.item_code) {
                    skipped++;
                    console.warn(
                        PREFIX + " Item mismatch; batch not copied.",
                        {
                            source_item: sourceRow.item_code,
                            target_item: targetRow.item_code
                        }
                    );
                    return;
                }

                // Copy Quotation custom field to the standard target field.
                targetRow.batch_no = batchNo;
                copied++;
            });

            console.info(PREFIX + " Mapping result", {
                target_doctype: mappedDoc.doctype,
                copied_batches: copied,
                skipped_rows: skipped,
                items: targetRows.map(row => ({
                    item_code: row.item_code,
                    batch_no: row.batch_no || ""
                }))
            });

            return true;
        });
    }

    /*
     * Add the direct Sales Invoice option.
     * ERPNext's standard Create -> Sales Order button remains available.
     */
    frappe.ui.form.on("Quotation", {
        refresh(frm) {
            if (frm.doc.docstatus !== 1) return;
            if (frm.doc.quotation_to !== "Customer") return;
            if (["Lost", "Cancelled"].includes(frm.doc.status)) return;
            if (!frappe.model.can_create("Sales Invoice")) return;

            frm.add_custom_button(
                __("Sales Invoice"),
                () => {
                    frappe.model.open_mapped_doc({
                        method: SALES_INVOICE_METHOD,
                        frm: frm
                    });
                },
                __("Create")
            );
        }
    });
})();