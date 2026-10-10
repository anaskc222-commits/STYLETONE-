(() => {
    "use strict";

    const FLAG = "__styleToneQuotationBatchV9";

    if (window[FLAG]) return;
    window[FLAG] = true;

    const API = "my_custom_app.quotation_batch";
    const SCAN_METHOD = `${API}.scan_barcode_with_variants`;
    const BATCH_METHOD = `${API}.get_available_batches`;
    const DETAILS_METHOD =
        "erpnext.stock.get_item_details.get_item_details";

    // ---------------------------------------------------------
    // HELPERS
    // ---------------------------------------------------------

    function isQuotation(frm) {
        return Boolean(
            frm &&
            frm.doc &&
            frm.doc.doctype === "Quotation"
        );
    }

    function getWarehouse(frm) {
        return String(frm.doc.custom_warehouse || "").trim();
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
            message: __(message),
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
        await setChildValue(
            row,
            "custom_batch_no",
            batchNo
        );
    }

    // ---------------------------------------------------------
    // VARIANT SELECTOR
    // ---------------------------------------------------------

    function chooseVariant(variants) {
        return new Promise((resolve) => {
            const available = (variants || []).filter(
                positiveQty
            );

            if (!available.length) {
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

            const rows = available.map((item, index) => `
                <tr>
                    <td>${escapeHtml(item.item_code)}</td>
                    <td>${escapeHtml(item.item_name || "")}</td>
                    <td>${escapeHtml(
                        item.available_qty ?? item.qty ?? 0
                    )}</td>
                    <td>
                        <button
                            type="button"
                            class="btn btn-primary btn-xs st-select-variant"
                            data-index="${index}">
                            ${__("Select")}
                        </button>
                    </td>
                </tr>
            `).join("");

            dialog = new frappe.ui.Dialog({
                title: __("Select Available Variant"),
                size: "large",
                fields: [{
                    fieldtype: "HTML",
                    fieldname: "variant_list"
                }],
                primary_action_label: __("Cancel"),
                primary_action() {
                    finish(null);
                }
            });

            dialog.fields_dict.variant_list.$wrapper.html(`
                <div class="table-responsive">
                    <table class="table table-bordered">
                        <thead>
                            <tr>
                                <th>${__("Item Code")}</th>
                                <th>${__("Item Name")}</th>
                                <th>${__("Available Qty")}</th>
                                <th>${__("Action")}</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            `);

            dialog.fields_dict.variant_list.$wrapper
                .find(".st-select-variant")
                .on("click", function () {
                    const index = Number(this.dataset.index);
                    finish(available[index] || null);
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
    // BATCH SELECTOR
    // ---------------------------------------------------------

    function chooseBatch(batches) {
        return new Promise((resolve) => {
            const available = (batches || []).filter(
                positiveQty
            );

            if (!available.length) {
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

            const rows = available.map((batch, index) => `
                <tr>
                    <td>${escapeHtml(
                        batch.batch_no || batch.name
                    )}</td>
                    <td>${escapeHtml(
                        batch.expiry_date || "-"
                    )}</td>
                    <td>${escapeHtml(
                        batch.available_qty ?? batch.qty ?? 0
                    )}</td>
                    <td>
                        <button
                            type="button"
                            class="btn btn-primary btn-xs st-select-batch"
                            data-index="${index}">
                            ${__("Select")}
                        </button>
                    </td>
                </tr>
            `).join("");

            dialog = new frappe.ui.Dialog({
                title: __("Select Available Batch"),
                size: "large",
                fields: [{
                    fieldtype: "HTML",
                    fieldname: "batch_list"
                }],
                primary_action_label: __("Cancel"),
                primary_action() {
                    finish(null);
                }
            });

            dialog.fields_dict.batch_list.$wrapper.html(`
                <div class="table-responsive">
                    <table class="table table-bordered">
                        <thead>
                            <tr>
                                <th>${__("Batch No")}</th>
                                <th>${__("Expiry Date")}</th>
                                <th>${__("Available Qty")}</th>
                                <th>${__("Action")}</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            `);

            dialog.fields_dict.batch_list.$wrapper
                .find(".st-select-batch")
                .on("click", function () {
                    const index = Number(this.dataset.index);
                    finish(available[index] || null);
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
    // STANDARD ERPNext ITEM DETAILS
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
            warehouse: warehouse,
            set_warehouse: warehouse,
            batch_no: batchNo || "",
            company: frm.doc.company,
            customer:
                frm.doc.party_name ||
                frm.doc.customer ||
                "",
            quotation_to: frm.doc.quotation_to || "Customer",
            transaction_date:
                frm.doc.transaction_date,
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
            conversion_rate:
                frm.doc.conversion_rate || 1,
            plc_conversion_rate:
                frm.doc.plc_conversion_rate || 1,
            ignore_pricing_rule:
                frm.doc.ignore_pricing_rule || 0,
            qty: 1
        };

        /*
         * ERPNext v16 uses the named parameter "ctx".
         * Pass ctx and doc as objects; frappe.call handles
         * serialization for the RPC request.
         */
        const response = await frappe.call({
            method: DETAILS_METHOD,
            args: {
                ctx: ctx,
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
    // FIND MATCHING ROW
    // ---------------------------------------------------------

    function findReusableRow(frm, itemCode, batchNo) {
        const items = frm.doc.items || [];
        const selectedBatch = String(batchNo || "");

        const existing = items.find((row) => {
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
            (row) => !row.item_code
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
    // APPLY ITEM DETAILS
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

        // Same item and same batch: increment quantity.
        if (match.row && match.existing) {
            const row = match.row;

            await setChildValue(
                row,
                "qty",
                (Number(row.qty) || 0) + 1
            );

            await setBatch(row, batchNo);

            await setChildValue(
                row,
                "warehouse",
                warehouse
            );

            frm.refresh_field("items");
            frm.dirty();

            await frm.trigger(
                "calculate_taxes_and_totals"
            );

            notify(
                __("Quantity increased for {0}.", [itemCode]),
                "green"
            );

            return;
        }

        const row = match.row || frm.add_child("items");

        row.item_code = itemCode;

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
         * Use the standard details returned by ERPNext.
         * Only set fields that exist on Quotation Item.
         */
        for (const [fieldname, value] of Object.entries(details)) {
            if (excluded.has(fieldname)) continue;
            if (value === undefined) continue;
            if (!hasChildField(fieldname)) continue;

            await setChildValue(
                row,
                fieldname,
                value
            );
        }

        await setChildValue(
            row,
            "warehouse",
            warehouse
        );

        await setChildValue(row, "qty", 1);
        await setBatch(row, batchNo);

        frm.refresh_field("items");
        frm.dirty();

        await frm.trigger(
            "calculate_taxes_and_totals"
        );

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
            const raw = await call(
                SCAN_METHOD,
                {
                    barcode: barcode,
                    warehouse: warehouse
                }
            );

            if (!raw) {
                throw new Error(
                    __("No item was found for this barcode.")
                );
            }

            const result = Array.isArray(raw)
                ? { variants: raw }
                : raw;

            let selected = null;

            // 2. Template barcode: select an available variant.
            if (
                result.is_template ||
                Array.isArray(result.variants)
            ) {
                const variants = (
                    result.variants || []
                ).filter(positiveQty);

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

            // 3. Validate the actual Item record.
            const item = await getItemInfo(itemCode);

            let batchNo = "";

            // 4. Batch-controlled item: select a positive-qty batch.
            if (Number(item.has_batch_no || 0)) {
                const batchResponse = await call(
                    BATCH_METHOD,
                    {
                        item_code: itemCode,
                        warehouse: warehouse
                    }
                );

                const batches = (
                    batchResponse || []
                ).filter(positiveQty);

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

            // 5. Fetch standard ERPNext pricing and item details.
            const details = await fetchCoreItemDetails(
                frm,
                itemCode,
                warehouse,
                batchNo
            );

            // 6. Add the item or update the matching row.
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
    // OPTIONAL ERPNext BARCODE SCANNER INTEGRATION
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

        if (Scanner.prototype.__styleToneQuotationBatchV9) {
            return;
        }

        const original = Scanner.prototype.process_scan;

        Scanner.prototype.process_scan = function (
            data,
            ...args
        ) {
            const frm = window.cur_frm;

            if (isQuotation(frm) && !frm.doc.is_pos) {
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

        Scanner.prototype.__styleToneQuotationBatchV9 = true;

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