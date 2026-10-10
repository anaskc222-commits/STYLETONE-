(() => {
    "use strict";

    if (window.__styleToneQuotationBatchV8) return;
    window.__styleToneQuotationBatchV8 = true;

    const API = "my_custom_app.quotation_batch";
    const SCAN_METHOD = `${API}.scan_barcode_with_variants`;
    const BATCH_METHOD = `${API}.get_available_batches`;
    const DETAILS_METHOD =
        "erpnext.stock.get_item_details.get_item_details";

    // ---------------------------------------------------------
    // BASIC HELPERS
    // ---------------------------------------------------------

    function notify(message, indicator = "orange") {
        frappe.show_alert({
            message: __(message),
            indicator
        });
    }

    function getWarehouse(frm) {
        return (
            frm.doc.custom_warehouse ||
            ""
        ).trim();
    }

    function isQuotation(frm) {
        return Boolean(
            frm &&
            frm.doc &&
            frm.doc.doctype === "Quotation"
        );
    }

    function positiveQty(value) {
        const qty = Number(value || 0);
        return Number.isFinite(qty) && qty > 0;
    }

    function responseMessage(response) {
        return response && response.message !== undefined
            ? response.message
            : response;
    }

    function getErrorMessage(error) {
        if (!error) return __("Unknown error");

        if (typeof error === "string") return error;

        if (error.message) return error.message;

        if (error._server_messages) {
            try {
                const messages = JSON.parse(error._server_messages);
                return messages
                    .map((message) => {
                        try {
                            return JSON.parse(message);
                        } catch (_) {
                            return message;
                        }
                    })
                    .join("\n");
            } catch (_) {
                // Continue to the generic fallback.
            }
        }

        if (error.exc) return error.exc;

        try {
            return JSON.stringify(error);
        } catch (_) {
            return String(error);
        }
    }

    function hasChildField(fieldname) {
        return Boolean(
            frappe.meta.get_docfield(
                "Quotation Item",
                fieldname
            )
        );
    }

    function setChildValue(row, fieldname, value) {
        if (!hasChildField(fieldname)) return Promise.resolve();

        return frappe.model.set_value(
            row.doctype,
            row.name,
            fieldname,
            value
        );
    }

    function setRowBatch(row, batchNo) {
        if (!batchNo) return Promise.resolve();

        const updates = [];

        if (hasChildField("batch_no")) {
            updates.push(
                setChildValue(row, "batch_no", batchNo)
            );
        }

        if (hasChildField("custom_batch_no")) {
            updates.push(
                setChildValue(row, "custom_batch_no", batchNo)
            );
        }

        return Promise.all(updates);
    }

    // ---------------------------------------------------------
    // VARIANT DIALOG
    // ---------------------------------------------------------

    function chooseVariant(variants) {
        return new Promise((resolve) => {
            let settled = false;

            const finish = (value) => {
                if (settled) return;
                settled = true;
                dialog.hide();
                resolve(value || null);
            };

            const options = (variants || [])
                .filter((variant) =>
                    positiveQty(variant.available_qty ?? variant.qty)
                )
                .map((variant) => ({
                    label:
                        `${variant.item_code} — ` +
                        `${variant.item_name || variant.item_code} ` +
                        `(Available: ${variant.available_qty ?? variant.qty})`,
                    value: variant.item_code
                }));

            if (!options.length) {
                resolve(null);
                return;
            }

            const dialog = new frappe.ui.Dialog({
                title: __("Select Item Variant"),
                fields: [
                    {
                        fieldname: "variant",
                        fieldtype: "Select",
                        label: __("Variant"),
                        options: options,
                        reqd: 1
                    }
                ],
                primary_action_label: __("Continue"),
                primary_action(values) {
                    finish(values.variant);
                }
            });

            dialog.onhide = () => {
                if (settled) return;
                settled = true;
                resolve(null);
            };

            dialog.show();
        });
    }

    // ---------------------------------------------------------
    // BATCH DIALOG
    // ---------------------------------------------------------

    function chooseBatch(batches) {
        return new Promise((resolve) => {
            let settled = false;

            const validBatches = (batches || [])
                .filter((batch) =>
                    positiveQty(
                        batch.available_qty ?? batch.qty
                    )
                );

            if (!validBatches.length) {
                resolve(null);
                return;
            }

            const options = validBatches.map((batch) => {
                const expiry = batch.expiry_date
                    ? ` | Expiry: ${batch.expiry_date}`
                    : "";

                const qty =
                    batch.available_qty ?? batch.qty ?? 0;

                return {
                    label:
                        `${batch.batch_no} | Available: ${qty}` +
                        expiry,
                    value: batch.batch_no
                };
            });

            const finish = (value, dialog) => {
                if (settled) return;
                settled = true;
                dialog.hide();
                resolve(value || null);
            };

            const dialog = new frappe.ui.Dialog({
                title: __("Select Batch"),
                fields: [
                    {
                        fieldname: "batch_no",
                        fieldtype: "Select",
                        label: __("Batch No"),
                        options: options,
                        reqd: 1
                    }
                ],
                primary_action_label: __("Continue"),
                primary_action(values) {
                    finish(values.batch_no, dialog);
                }
            });

            dialog.onhide = () => {
                if (settled) return;
                settled = true;
                resolve(null);
            };

            dialog.show();
        });
    }

    // ---------------------------------------------------------
    // ITEM VALIDATION
    // ---------------------------------------------------------

    async function getItemInfo(itemCode) {
        const response = await frappe.db.get_value(
            "Item",
            itemCode,
            [
                "item_name",
                "has_batch_no",
                "has_serial_no",
                "disabled",
                "is_stock_item"
            ]
        );

        const item = response && response.message;

        if (!item) {
            throw new Error(
                __("Item {0} was not found.", [itemCode])
            );
        }

        if (Number(item.disabled)) {
            throw new Error(
                __("Item {0} is disabled.", [itemCode])
            );
        }

        if (!Number(item.is_stock_item)) {
            throw new Error(
                __("Item {0} is not a stock item.", [itemCode])
            );
        }

        if (
            Number(item.has_batch_no) &&
            Number(item.has_serial_no)
        ) {
            throw new Error(
                __(
                    "Item {0} uses both serial numbers and batches. " +
                    "This selector does not support serial selection.",
                    [itemCode]
                )
            );
        }

        return item;
    }

    // ---------------------------------------------------------
    // STANDARD ERPNext ITEM DETAILS
    // ---------------------------------------------------------

    function fetchCoreItemDetails(
        frm,
        itemCode,
        warehouse,
        batchNo
    ) {
        /*
         * ERPNext v16 expects the context under the parameter
         * named "ctx", not "args".
         *
         * Send ctx as a JSON string for Frappe's RPC argument
         * parser, and pass the current Quotation document.
         */

        const ctx = {
            doctype: "Quotation",
            item_code: itemCode,
            warehouse: warehouse,
            set_warehouse: warehouse,
            batch_no: batchNo || "",
            company: frm.doc.company,
            customer:
                frm.doc.party_name ||
                frm.doc.customer ||
                "",
            transaction_date:
                frm.doc.transaction_date,
            selling_price_list:
                frm.doc.selling_price_list ||
                frm.doc.price_list ||
                "",
            price_list:
                frm.doc.selling_price_list ||
                frm.doc.price_list ||
                "",
            price_list_currency:
                frm.doc.price_list_currency ||
                frm.doc.currency,
            currency: frm.doc.currency,
            conversion_rate:
                frm.doc.conversion_rate || 1,
            plc_conversion_rate:
                frm.doc.plc_conversion_rate || 1,
            ignore_pricing_rule:
                frm.doc.ignore_pricing_rule || 0,
            qty: 1
        };

        return frappe.call({
            method: DETAILS_METHOD,
            args: {
                ctx: JSON.stringify(ctx),
                doc: JSON.stringify(frm.doc)
            },
            freeze: true,
            freeze_message: __("Loading item details...")
        }).then((response) => {
            const details = responseMessage(response);

            if (!details || typeof details !== "object") {
                throw new Error(
                    __("ERPNext returned no item details for {0}.", [
                        itemCode
                    ])
                );
            }

            return details;
        });
    }

    // ---------------------------------------------------------
    // FIND AN EXISTING ITEM ROW
    // ---------------------------------------------------------

    function findReusableRow(frm, itemCode, batchNo) {
        const items = frm.doc.items || [];

        const normalizedBatch = String(batchNo || "");

        // Reuse a row only when both item and batch match.
        const matchingRow = items.find((row) => {
            const rowBatch = String(
                row.batch_no ||
                row.custom_batch_no ||
                ""
            );

            return (
                row.item_code === itemCode &&
                rowBatch === normalizedBatch
            );
        });

        if (matchingRow) {
            return {
                row: matchingRow,
                existing: true
            };
        }

        // Prefer an unused blank row.
        const blankRow = items.find((row) =>
            !row.item_code
        );

        if (blankRow) {
            return {
                row: blankRow,
                existing: false
            };
        }

        return {
            row: null,
            existing: false
        };
    }

    // ---------------------------------------------------------
    // APPLY STANDARD ITEM DETAILS TO THE QUOTATION
    // ---------------------------------------------------------

    async function applyItemDetails(
        frm,
        itemCode,
        warehouse,
        batchNo,
        details
    ) {
        const match = findReusableRow(
            frm,
            itemCode,
            batchNo
        );

        // Same item and same batch: increase quantity.
        if (match.row && match.existing) {
            const row = match.row;
            const currentQty = Number(row.qty || 0);

            await setChildValue(
                row,
                "qty",
                currentQty + 1
            );

            await setRowBatch(row, batchNo);

            if (hasChildField("warehouse")) {
                await setChildValue(
                    row,
                    "warehouse",
                    warehouse
                );
            }

            frm.refresh_field("items");
            frm.dirty();

            if (
                typeof frm.trigger === "function"
            ) {
                await frm.trigger(
                    "calculate_taxes_and_totals"
                );
            }

            notify(
                __("Quantity increased for {0}.", [itemCode]),
                "green"
            );

            return row;
        }

        let row = match.row;

        if (!row) {
            row = frm.add_child("items");
        }

        /*
         * Set item_code first, then apply the standard details
         * returned by ERPNext. Exclude identity, quantity and
         * batch fields from this generic assignment.
         */
        row.item_code = itemCode;

        const excludedFields = new Set([
            "name",
            "doctype",
            "parent",
            "parentfield",
            "parenttype",
            "idx",
            "docstatus",
            "item_code",
            "qty",
            "batch_no",
            "custom_batch_no"
        ]);

        const promises = [];

        for (const [fieldname, value] of Object.entries(details)) {
            if (excludedFields.has(fieldname)) continue;

            if (
                !frappe.meta.get_docfield(
                    "Quotation Item",
                    fieldname
                )
            ) {
                continue;
            }

            promises.push(
                setChildValue(row, fieldname, value)
            );
        }

        // Explicitly enforce the selected warehouse and quantity.
        if (hasChildField("warehouse")) {
            promises.push(
                setChildValue(
                    row,
                    "warehouse",
                    warehouse
                )
            );
        }

        promises.push(
            setChildValue(row, "qty", 1)
        );

        if (batchNo) {
            promises.push(
                setRowBatch(row, batchNo)
            );
        }

        await Promise.all(promises);

        frm.refresh_field("items");
        frm.dirty();

        if (typeof frm.trigger === "function") {
            await frm.trigger(
                "calculate_taxes_and_totals"
            );
        }

        notify(
            __("Added {0} to the Quotation.", [itemCode]),
            "green"
        );

        return row;
    }

    // ---------------------------------------------------------
    // MAIN BARCODE PROCESSOR
    // ---------------------------------------------------------

    async function processBarcode(frm, barcode) {
        if (!isQuotation(frm)) return;

        barcode = String(barcode || "").trim();

        if (!barcode) return;

        const warehouse = getWarehouse(frm);

        if (!warehouse) {
            notify(
                __("Select the Warehouse before scanning."),
                "orange"
            );
            return;
        }

        if (!frm.doc.company) {
            notify(
                __("Select a Company before scanning."),
                "orange"
            );
            return;
        }

        try {
            // 1. Resolve the scanned barcode.
            const scanResponse = await frappe.call({
                method: SCAN_METHOD,
                args: {
                    barcode: barcode,
                    warehouse: warehouse
                }
            });

            const result = responseMessage(scanResponse);

            if (!result) {
                throw new Error(
                    __("The barcode lookup returned no result.")
                );
            }

            let itemCode = result.item_code;

            // 2. If this is a template, ask for the variant.
            if (
                result.is_template ||
                Array.isArray(result.variants)
            ) {
                const variants = (result.variants || [])
                    .filter((variant) =>
                        positiveQty(
                            variant.available_qty ??
                            variant.qty
                        )
                    );

                if (!variants.length) {
                    throw new Error(
                        __("No variants have available stock.")
                    );
                }

                itemCode = await chooseVariant(variants);

                if (!itemCode) return;
            }

            if (!itemCode) {
                throw new Error(
                    __("Could not resolve the scanned item.")
                );
            }

            // 3. Validate the selected variant/item.
            const item = await getItemInfo(itemCode);

            let batchNo = "";

            // 4. If batch-controlled, show the batch selector.
            if (Number(item.has_batch_no)) {
                const batchResponse = await frappe.call({
                    method: BATCH_METHOD,
                    args: {
                        item_code: itemCode,
                        warehouse: warehouse
                    }
                });

                const batches = responseMessage(batchResponse) || [];

                const availableBatches = batches.filter((batch) =>
                    positiveQty(
                        batch.available_qty ?? batch.qty
                    )
                );

                if (!availableBatches.length) {
                    throw new Error(
                        __(
                            "No positive-quantity batches are available " +
                            "for {0} in {1}.",
                            [itemCode, warehouse]
                        )
                    );
                }

                batchNo = await chooseBatch(availableBatches);

                if (!batchNo) return;
            }

            // 5. Fetch standard ERPNext item details using ctx.
            const details = await fetchCoreItemDetails(
                frm,
                itemCode,
                warehouse,
                batchNo
            );

            // 6. Add the item or increment the matching row.
            await applyItemDetails(
                frm,
                itemCode,
                warehouse,
                batchNo,
                details
            );
        } catch (error) {
            console.error(
                "[StyleTone Quotation Batch] Barcode processing failed:",
                error
            );

            frappe.msgprint({
                title: __("Barcode Processing Error"),
                indicator: "red",
                message: frappe.utils.escape_html(
                    getErrorMessage(error)
                )
            });
        }
    }

    // ---------------------------------------------------------
    // PATCH ERPNext BARCODE SCANNER
    // ---------------------------------------------------------

    function installScannerPatch() {
        const scannerPrototype =
            window.erpnext &&
            window.erpnext.utils &&
            window.erpnext.utils.BarcodeScanner &&
            window.erpnext.utils.BarcodeScanner.prototype;

        if (
            !scannerPrototype ||
            typeof scannerPrototype.process_scan !== "function"
        ) {
            console.warn(
                "[StyleTone Quotation Batch] " +
                "ERPNext BarcodeScanner.process_scan was not found. " +
                "The scan_barcode field handler remains available."
            );
            return;
        }

        if (scannerPrototype.__styleToneQuotationBatchPatched) {
            return;
        }

        const originalProcessScan =
            scannerPrototype.process_scan;

        scannerPrototype.process_scan = function (...args) {
            const frm =
                this.frm ||
                (cur_frm && cur_frm);

            if (
                isQuotation(frm) &&
                !frm.doc.is_pos
            ) {
                const barcode =
                    args.find((value) =>
                        typeof value === "string" &&
                        value.trim()
                    );

                if (barcode) {
                    processBarcode(frm, barcode);
                    return;
                }
            }

            return originalProcessScan.apply(this, args);
        };

        scannerPrototype.__styleToneQuotationBatchPatched = true;

        console.info(
            "[StyleTone Quotation Batch] Barcode scanner patch installed."
        );
    }

    // ---------------------------------------------------------
    // QUOTATION EVENTS
    // ---------------------------------------------------------

    frappe.ui.form.on("Quotation", {
        refresh(frm) {
            installScannerPatch();
        },

        scan_barcode(frm) {
            const barcode = frm.doc.scan_barcode;

            if (!barcode) return;

            // Clear the input before processing the scan.
            frappe.model.set_value(
                frm.doctype,
                frm.docname,
                "scan_barcode",
                ""
            );

            processBarcode(frm, barcode);
        }
    });

    // Attempt installation after this script loads.
    installScannerPatch();
})();