
(() => {
    "use strict";

    const FLAG = "__styleToneQuotationBatchV10";

    if (window[FLAG]) return;
    window[FLAG] = true;

    const API = "my_custom_app.quotation_batch";
    const SCAN_METHOD = `${API}.scan_barcode_with_variants`;
    const BATCH_METHOD = `${API}.get_available_batches`;
    const PRICE_METHOD = `${API}.get_batch_item_price`;
    const DETAILS_METHOD =
        "erpnext.stock.get_item_details.get_item_details";

    // ---------------------------------------------------------
    // HELPERS
    // ---------------------------------------------------------

    function isQuotation(frm) {
        return Boolean(
            frm?.doc?.doctype === "Quotation"
        );
    }

    function getWarehouse(frm) {
        return String(
            frm.doc.custom_warehouse ||
            frm.doc.set_warehouse ||
            ""
        ).trim();
    }

    function positiveQty(item) {
        const qty = Number(
            item?.available_qty ?? item?.qty ?? 0
        );

        return Number.isFinite(qty) && qty > 0;
    }

    function escapeHtml(value) {
        return frappe.utils.escape_html(
            String(value ?? "")
        );
    }

    function notify(message, indicator = "orange") {
        frappe.show_alert({
            message,
            indicator
        });
    }

    async function call(method, args) {
        const response = await frappe.call({
            method,
            args
        });

        return response?.message;
    }

    function hasChildField(fieldname) {
        return Boolean(
            frappe.meta.get_docfield(
                "Quotation Item",
                fieldname
            )
        );
    }

    async function setChildValue(row, fieldname, value) {
        if (!hasChildField(fieldname)) return;

        await frappe.model.set_value(
            row.doctype,
            row.name,
            fieldname,
            value
        );
    }

    async function setBatch(row, batchNo) {
        if (!batchNo) return;

        await setChildValue(row, "batch_no", batchNo);
        await setChildValue(row, "custom_batch_no", batchNo);
    }

    // ---------------------------------------------------------
    // GENERIC SELECTOR DIALOG
    // ---------------------------------------------------------

    function chooseRow({
        title,
        rows,
        columns,
        buttonClass
    }) {
        return new Promise((resolve) => {
            if (!rows?.length) {
                resolve(null);
                return;
            }

            let settled = false;
            let dialog;

            function finish(value) {
                if (settled) return;

                settled = true;

                if (dialog) dialog.hide();

                resolve(value || null);
            }

            const header = columns.map(
                column => `<th>${escapeHtml(column.label)}</th>`
            ).join("");

            const body = rows.map((item, index) => {
                const cells = columns.map(column => {
                    if (column.action) {
                        return `
                            <td>
                                <button
                                    type="button"
                                    class="btn btn-primary btn-xs ${buttonClass}"
                                    data-index="${index}">
                                    ${__("Select")}
                                </button>
                            </td>
                        `;
                    }

                    return `
                        <td>${escapeHtml(
                            column.value(item) ?? "-"
                        )}</td>
                    `;
                }).join("");

                return `<tr>${cells}</tr>`;
            }).join("");

            dialog = new frappe.ui.Dialog({
                title,
                size: "large",
                fields: [{
                    fieldtype: "HTML",
                    fieldname: "selector_html"
                }],
                primary_action_label: __("Cancel"),
                primary_action() {
                    finish(null);
                }
            });

            dialog.fields_dict.selector_html.$wrapper.html(`
                <div class="table-responsive">
                    <table class="table table-bordered">
                        <thead><tr>${header}</tr></thead>
                        <tbody>${body}</tbody>
                    </table>
                </div>
            `);

            dialog.fields_dict.selector_html.$wrapper
                .find(`.${buttonClass}`)
                .on("click", function () {
                    const index = Number(this.dataset.index);
                    finish(rows[index] || null);
                });

            dialog.onhide = () => {
                if (settled) return;
                settled = true;
                resolve(null);
            };

            dialog.show();
        });
    }

    function chooseVariant(variants) {
        return chooseRow({
            title: __("Select Available Variant"),
            rows: (variants || []).filter(positiveQty),
            buttonClass: "st-select-variant",
            columns: [
                {
                    label: __("Item Code"),
                    value: row => row.item_code
                },
                {
                    label: __("Item Name"),
                    value: row => row.item_name
                },
                {
                    label: __("Batch Tracked"),
                    value: row =>
                        Number(row.has_batch_no) ? __("Yes") : __("No")
                },
                {
                    label: __("Available Qty"),
                    value: row =>
                        row.available_qty ?? row.qty
                },
                {
                    label: __("Action"),
                    action: true
                }
            ]
        });
    }

    function chooseBatch(batches) {
        return chooseRow({
            title: __("Select Available Batch"),
            rows: (batches || []).filter(positiveQty),
            buttonClass: "st-select-batch",
            columns: [
                {
                    label: __("Batch No"),
                    value: row => row.batch_no || row.name
                },
                {
                    label: __("Expiry Date"),
                    value: row => row.expiry_date || "-"
                },
                {
                    label: __("Available Qty"),
                    value: row =>
                        row.available_qty ?? row.qty
                },
                {
                    label: __("Action"),
                    action: true
                }
            ]
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

        const item = response?.message;

        if (!item) {
            throw new Error(
                __("Item {0} was not found.", [itemCode])
            );
        }

        if (Number(item.disabled || 0)) {
            throw new Error(
                __("Item {0} is disabled.", [itemCode])
            );
        }

        if (!Number(item.is_stock_item || 0)) {
            throw new Error(
                __("Item {0} is not a stock item.", [itemCode])
            );
        }

        if (
            Number(item.has_batch_no || 0) &&
            Number(item.has_serial_no || 0)
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
    // STANDARD ERPNEXT ITEM DETAILS
    // ---------------------------------------------------------

    async function fetchCoreItemDetails(
        frm,
        itemCode,
        warehouse,
        batchNo
    ) {
        const ctx = {
            doctype: "Quotation",
            item_code: itemCode,
            warehouse,
            set_warehouse: warehouse,
            batch_no: batchNo || "",
            company: frm.doc.company,
            customer:
                frm.doc.party_name ||
                frm.doc.customer ||
                "",
            quotation_to: frm.doc.quotation_to || "Customer",
            transaction_date: frm.doc.transaction_date,
            price_list:
                frm.doc.selling_price_list ||
                frm.doc.price_list ||
                "",
            selling_price_list:
                frm.doc.selling_price_list ||
                frm.doc.price_list ||
                "",
            price_list_currency:
                frm.doc.price_list_currency ||
                frm.doc.currency,
            currency: frm.doc.currency,
            conversion_rate: frm.doc.conversion_rate || 1,
            plc_conversion_rate:
                frm.doc.plc_conversion_rate || 1,
            ignore_pricing_rule:
                frm.doc.ignore_pricing_rule || 0,
            qty: 1
        };

        const response = await frappe.call({
            method: DETAILS_METHOD,
            args: {
                ctx,
                doc: frm.doc
            },
            freeze: true,
            freeze_message: __("Loading item details...")
        });

        const details = response?.message;

        if (!details || typeof details !== "object") {
            throw new Error(
                __("ERPNext returned no item details for {0}.", [
                    itemCode
                ])
            );
        }

        return details;
    }

    // ---------------------------------------------------------
    // BATCH-SPECIFIC PRICE
    // ---------------------------------------------------------

    async function applyBatchPrice(
        frm,
        itemCode,
        batchNo,
        details
    ) {
        if (!batchNo) return details;

        const priceList =
            frm.doc.selling_price_list ||
            frm.doc.price_list ||
            "";

        if (!priceList) {
            console.warn(
                "[StyleTone Quotation Batch] No selling price list selected."
            );
            return details;
        }

        const result = await call(PRICE_METHOD, {
            item_code: itemCode,
            batch_no: batchNo,
            price_list: priceList,
            transaction_date: frm.doc.transaction_date,
            customer:
                frm.doc.party_name ||
                frm.doc.customer ||
                "",
            uom: details.uom || ""
        });

        if (result?.found) {
            const rate = Number(result.price_list_rate);

            if (!Number.isFinite(rate) || rate < 0) {
                throw new Error(
                    __("Invalid batch-specific Item Price.")
                );
            }

            details.price_list_rate = rate;
            details.rate = rate;

            console.info(
                "[StyleTone Quotation Batch] Batch price found.",
                {
                    item_code: itemCode,
                    batch_no: batchNo,
                    item_price: result.item_price,
                    rate
                }
            );
        } else {
            console.info(
                "[StyleTone Quotation Batch] No batch-specific price; " +
                "keeping ERPNext standard price.",
                {
                    item_code: itemCode,
                    batch_no: batchNo,
                    price_list: priceList,
                    reason: result?.reason || ""
                }
            );
        }

        return details;
    }

    // ---------------------------------------------------------
    // MATCH EXISTING ITEM ROW
    // ---------------------------------------------------------

    function findReusableRow(frm, itemCode, batchNo) {
        const items = frm.doc.items || [];
        const selectedBatch = String(batchNo || "");

        const existing = items.find(row => {
            if (row.item_code !== itemCode) return false;

            const rowBatch = String(
                row.batch_no ||
                row.custom_batch_no ||
                ""
            );

            return rowBatch === selectedBatch;
        });

        if (existing) {
            return {
                row: existing,
                existing: true
            };
        }

        const blankRow = items.find(
            row => !row.item_code
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
    // APPLY DETAILS AND BATCH PRICE
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

        if (match.row && match.existing) {
            const row = match.row;

            await setChildValue(
                row,
                "qty",
                (Number(row.qty) || 0) + 1
            );

            await setChildValue(row, "warehouse", warehouse);
            await setBatch(row, batchNo);

            // Apply batch-specific rate when one was found.
            if (details.price_list_rate != null) {
                await setChildValue(
                    row,
                    "price_list_rate",
                    details.price_list_rate
                );
            }

            if (details.rate != null) {
                await setChildValue(
                    row,
                    "rate",
                    details.rate
                );
            }

            frm.refresh_field("items");
            frm.dirty();

            await frm.trigger("calculate_taxes_and_totals");

            notify(
                __("Quantity increased for {0}.", [itemCode]),
                "green"
            );

            return;
        }

        const row = match.row || frm.add_child("items");

        const excluded = new Set([
            "name",
            "doctype",
            "parent",
            "parenttype",
            "parentfield",
            "idx",
            "docstatus",
            "item_code",
            "qty",
            "batch_no",
            "custom_batch_no"
        ]);

        /*
         * Populate ERPNext item details first.
         * Then explicitly apply item_code, warehouse, qty and batch.
         */
        for (const [fieldname, value] of Object.entries(details)) {
            if (excluded.has(fieldname)) continue;
            if (value === undefined || value === null) continue;
            if (!hasChildField(fieldname)) continue;

            await setChildValue(row, fieldname, value);
        }

        await setChildValue(row, "item_code", itemCode);
        await setChildValue(row, "warehouse", warehouse);
        await setChildValue(row, "qty", 1);
        await setBatch(row, batchNo);

        frm.refresh_field("items");
        frm.dirty();

        await frm.trigger("calculate_taxes_and_totals");

        notify(
            __("Added {0} to the Quotation.", [itemCode]),
            "green"
        );
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
                __("Select the Warehouse before scanning.")
            );
            return;
        }

        if (!frm.doc.company) {
            notify(
                __("Select a Company before scanning.")
            );
            return;
        }

        try {
            // 1. Resolve barcode.
            const raw = await call(SCAN_METHOD, {
                barcode,
                warehouse
            });

            if (!raw) {
                throw new Error(
                    __("No item was found for this barcode.")
                );
            }

            const result = Array.isArray(raw)
                ? { variants: raw }
                : raw;

            let selected = null;

            // 2. Select a variant when the barcode is a template.
            if (
                result.is_template ||
                Array.isArray(result.variants)
            ) {
                const variants = (result.variants || [])
                    .filter(positiveQty);

                if (!variants.length) {
                    throw new Error(
                        __("No variants have available stock.")
                    );
                }

                selected = await chooseVariant(variants);

                if (!selected) return;
            } else if (result.item_code) {
                selected = result;
            }

            if (!selected?.item_code) {
                throw new Error(
                    __("Could not resolve the scanned item.")
                );
            }

            const itemCode = selected.item_code;

            // 3. Validate the actual selected item.
            const item = await getItemInfo(itemCode);

            let batchNo = "";

            // 4. Ask for a batch only when the item is batch-controlled.
            if (Number(item.has_batch_no || 0)) {
                const batchResponse = await call(BATCH_METHOD, {
                    item_code: itemCode,
                    warehouse
                });

                const batches = (batchResponse || [])
                    .filter(positiveQty);

                if (!batches.length) {
                    throw new Error(
                        __(
                            "No positive-quantity batches are available " +
                            "for {0} in {1}.",
                            [itemCode, warehouse]
                        )
                    );
                }

                const chosen = await chooseBatch(batches);

                if (!chosen) return;

                batchNo = String(
                    chosen.batch_no ||
                    chosen.name ||
                    ""
                ).trim();

                if (!batchNo) {
                    throw new Error(
                        __("The selected batch has no batch number.")
                    );
                }
            }

            // 5. Fetch ERPNext standard item details.
            const details = await fetchCoreItemDetails(
                frm,
                itemCode,
                warehouse,
                batchNo
            );

            // 6. Override the rate only if a matching batch price exists.
            await applyBatchPrice(
                frm,
                itemCode,
                batchNo,
                details
            );

            // 7. Add/update the correct item and batch row.
            await applyItemDetails(
                frm,
                itemCode,
                warehouse,
                batchNo,
                details
            );

        } catch (error) {
            console.error(
                "[StyleTone Quotation Batch] Error:",
                error
            );

            frappe.msgprint({
                title: __("Barcode Processing Error"),
                indicator: "red",
                message: escapeHtml(
                    error?.message || error
                )
            });
        }
    }

    // ---------------------------------------------------------
    // ERPNext BARCODE SCANNER INTEGRATION
    // ---------------------------------------------------------

    function installScannerPatch() {
        const Scanner =
            window.erpnext?.utils?.BarcodeScanner;

        if (
            !Scanner?.prototype ||
            typeof Scanner.prototype.process_scan !== "function"
        ) {
            return;
        }

        if (
            Scanner.prototype.__styleToneQuotationBatchV10
        ) {
            return;
        }

        const original = Scanner.prototype.process_scan;

        Scanner.prototype.process_scan = function (
            data,
            ...args
        ) {
            const frm = window.cur_frm;

            if (
                isQuotation(frm) &&
                !frm.doc.is_pos
            ) {
                const barcode =
                    typeof data === "string"
                        ? data
                        : data?.barcode ||
                          data?.barcode_value ||
                          data?.text ||
                          "";

                if (barcode) {
                    processBarcode(frm, barcode);
                    return;
                }
            }

            return original.call(this, data, ...args);
        };

        Scanner.prototype.__styleToneQuotationBatchV10 = true;

        console.info(
            "[StyleTone Quotation Batch] Scanner integration installed."
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

            frm.set_value("scan_barcode", "");

            processBarcode(frm, barcode);
        }
    });

    installScannerPatch();
})();
