
(() => {
    "use strict";

    if (window.__styleToneQuotationBatchV12) return;
    window.__styleToneQuotationBatchV12 = true;

    const API = "my_custom_app.quotation_batch";
    const SCAN_METHOD = `${API}.scan_barcode_with_variants`;
    const BATCH_METHOD = `${API}.get_available_batches`;
    const PRICE_METHOD = `${API}.get_batch_item_price`;
    const DETAILS_METHOD = "erpnext.stock.get_item_details.get_item_details";

    let processing = false;

    function call(method, args) {
        return new Promise((resolve, reject) => {
            frappe.call({
                method,
                args,
                callback: (r) => resolve(r.message),
                error: reject,
            });
        });
    }

    function isQuotation(frm) {
        return !!(
            frm &&
            frm.doctype === "Quotation" &&
            !frm.doc.is_pos
        );
    }

    function getWarehouse(frm) {
        return (
            frm.doc.custom_warehouse ||
            frm.doc.set_warehouse ||
            ""
        );
    }

    function getPriceList(frm) {
        return frm.doc.selling_price_list || "";
    }

    function esc(value) {
        return frappe.utils.escape_html(String(value ?? ""));
    }

    function showMessage(message, title = "Quotation Batch") {
        frappe.msgprint({
            title,
            message: esc(message),
            indicator: "orange",
        });
    }

    // ---------------------------------------------------------
    // SELECTION DIALOG
    // ---------------------------------------------------------

    function chooseFromTable(title, headers, rows, getValues) {
        return new Promise((resolve) => {
            if (!rows || !rows.length) {
                resolve(null);
                return;
            }

            let settled = false;
            let dialog;

            const finish = (value) => {
                if (settled) return;
                settled = true;
                resolve(value);
                if (dialog) dialog.hide();
            };

            const head = headers
                .map((header) => `<th>${esc(header)}</th>`)
                .join("");

            const body = rows.map((item, index) => {
                const cells = getValues(item)
                    .map((value) => `<td>${esc(value)}</td>`)
                    .join("");

                return `
                    <tr>
                        ${cells}
                        <td>
                            <button type="button"
                                class="btn btn-primary btn-xs st-choose"
                                data-index="${index}">
                                Select
                            </button>
                        </td>
                    </tr>`;
            }).join("");

            dialog = new frappe.ui.Dialog({
                title,
                fields: [
                    {
                        fieldtype: "HTML",
                        fieldname: "choice_table",
                    },
                ],
                primary_action_label: "Cancel",
                primary_action() {
                    finish(null);
                },
            });

            dialog.fields_dict.choice_table.$wrapper.html(`
                <div style="max-height:55vh;overflow:auto">
                    <table class="table table-bordered table-hover">
                        <thead>
                            <tr>${head}<th></th></tr>
                        </thead>
                        <tbody>${body}</tbody>
                    </table>
                </div>
            `);

            dialog.fields_dict.choice_table.$wrapper.on(
                "click",
                ".st-choose",
                function () {
                    const index = Number(this.dataset.index);
                    finish(rows[index] || null);
                }
            );

            dialog.$wrapper.on("hidden.bs.modal", () => {
                if (!settled) {
                    settled = true;
                    resolve(null);
                }
            });

            dialog.show();
        });
    }

    function chooseVariant(variants) {
        return chooseFromTable(
            "Select Item Variant",
            ["Item Code", "Item Name", "Batch Tracked", "Available Qty"],
            variants,
            (item) => [
                item.item_code,
                item.item_name,
                item.has_batch_no ? "Yes" : "No",
                item.available_qty ?? 0,
            ]
        );
    }

    function chooseBatch(batches) {
        return chooseFromTable(
            "Select Batch",
            ["Batch No", "Expiry Date", "Available Qty"],
            batches,
            (batch) => [
                batch.batch_no,
                batch.expiry_date || "-",
                batch.qty,
            ]
        );
    }

    // ---------------------------------------------------------
    // STANDARD ERPNext ITEM DETAILS
    // ---------------------------------------------------------

    async function fetchStandardItemDetails(
        frm,
        itemCode,
        warehouse,
        batchNo
    ) {
        const ctx = {
            item_code: itemCode,
            company: frm.doc.company,
            customer: frm.doc.party_name,
            quotation_to: frm.doc.quotation_to,
            transaction_date: frm.doc.transaction_date,
            selling_price_list: getPriceList(frm),
            price_list: getPriceList(frm),
            price_list_currency: frm.doc.currency,
            currency: frm.doc.currency,
            plc_conversion_rate: frm.doc.plc_conversion_rate || 1,
            conversion_rate: frm.doc.conversion_rate || 1,
            warehouse,
            set_warehouse: warehouse,
            qty: 1,
            doctype: "Quotation",
            ignore_pricing_rule: 0,
        };

        // Item Price uses batch_no, but the Quotation child field is
        // custom_batch_no. Do not assume the standard details API supports
        // custom batch pricing.
        if (batchNo) {
            ctx.batch_no = batchNo;
        }

        const details = await call(DETAILS_METHOD, {
            args: ctx,
            doc: frm.doc,
        });

        if (!details) {
            throw new Error("ERPNext did not return item details.");
        }

        return details;
    }

    // ---------------------------------------------------------
    // BATCH-SPECIFIC PRICE
    // ---------------------------------------------------------

    async function fetchBatchPrice(frm, itemCode, batchNo, uom) {
        if (!batchNo) return { found: false };

        return await call(PRICE_METHOD, {
            item_code: itemCode,
            batch_no: batchNo,
            price_list: getPriceList(frm),
            transaction_date: frm.doc.transaction_date,
            customer: frm.doc.party_name,
            uom: uom || undefined,
        });
    }

    // ---------------------------------------------------------
    // QUOTATION ROW HELPERS
    // ---------------------------------------------------------

    function findReusableRow(frm, itemCode, batchNo) {
        return (frm.doc.items || []).find((row) => {
            if (row.item_code !== itemCode) return false;

            return (row.custom_batch_no || "") === (batchNo || "");
        });
    }

    function getTargetRow(frm, itemCode, batchNo) {
        const existing = findReusableRow(frm, itemCode, batchNo);

        if (existing) {
            return { row: existing, existing: true };
        }

        const row = frappe.model.add_child(
            frm.doc,
            "Quotation Item",
            "items"
        );

        row.item_code = itemCode;
        row.qty = 1;

        return { row, existing: false };
    }

    async function setRowValue(row, fieldname, value) {
        if (value === undefined) return;

        if (!frappe.meta.has_field(row.doctype, fieldname)) {
            return;
        }

        await frappe.model.set_value(
            row.doctype,
            row.name,
            fieldname,
            value
        );
    }

    async function applyStandardDetails(
        frm,
        row,
        details,
        warehouse,
        batchNo
    ) {
        const fields = [
            "item_name",
            "description",
            "item_group",
            "brand",
            "image",
            "uom",
            "stock_uom",
            "conversion_factor",
            "price_list_rate",
            "discount_percentage",
            "discount_amount",
            "rate",
            "income_account",
            "expense_account",
            "cost_center",
            "weight_per_unit",
            "weight_uom",
        ];

        for (const field of fields) {
            if (Object.prototype.hasOwnProperty.call(details, field)) {
                await setRowValue(row, field, details[field]);
            }
        }

        await setRowValue(row, "warehouse", warehouse);
        await setRowValue(row, "custom_batch_no", batchNo || "");
        await setRowValue(row, "qty", row.qty || 1);

        frm.refresh_field("items");
    }

    async function applyBatchPrice(frm, row, itemCode, batchNo) {
        if (!batchNo) return;

        // The server lookup uses Item Price.batch_no.
        const result = await fetchBatchPrice(
            frm,
            itemCode,
            batchNo,
            row.uom
        );

        if (!result || !result.found) {
            showMessage(
                `No matching Item Price found for item ${itemCode}, ` +
                `batch ${batchNo}, and price list ${getPriceList(frm)}. ` +
                "The standard ERPNext rate has been retained.",
                "Batch Price Not Found"
            );
            return;
        }

        const rate = flt(result.rate);

        // Persist the selected batch on the Quotation row.
        await setRowValue(row, "custom_batch_no", batchNo);

        // Apply the matched price after the standard item details.
        await setRowValue(row, "price_list_rate", rate);
        await setRowValue(row, "rate", rate);

        frm.refresh_field("items");

        // Recalculate dependent amounts, then restore the selected rate.
        if (
            frm.cscript &&
            typeof frm.cscript.calculate_taxes_and_totals === "function"
        ) {
            frm.cscript.calculate_taxes_and_totals();
        } else {
            await frm.trigger("calculate_taxes_and_totals");
        }

        await setRowValue(row, "price_list_rate", rate);
        await setRowValue(row, "rate", rate);
        await setRowValue(row, "custom_batch_no", batchNo);

        frm.refresh_field("items");
    }

    // ---------------------------------------------------------
    // MAIN BARCODE FLOW
    // ---------------------------------------------------------

    async function processBarcode(frm, barcode) {
        if (!isQuotation(frm) || processing) return;

        barcode = String(barcode || "").trim();
        if (!barcode) return;

        const warehouse = getWarehouse(frm);

        if (!warehouse) {
            showMessage(
                "Select a warehouse before scanning.",
                "Warehouse Required"
            );
            return;
        }

        if (!getPriceList(frm)) {
            showMessage(
                "Select a Selling Price List before scanning.",
                "Price List Required"
            );
            return;
        }

        processing = true;

        try {
            const response = await call(SCAN_METHOD, {
                barcode,
                warehouse,
            });

            if (!response || !response.found) {
                showMessage(
                    response?.message || `Barcode not found: ${barcode}`
                );
                return;
            }

            let selectedItem;

            if (response.is_template) {
                selectedItem = await chooseVariant(response.variants || []);
                if (!selectedItem) return;
            } else {
                selectedItem = response.item;
            }

            if (!selectedItem || !selectedItem.item_code) {
                showMessage("No item was selected.");
                return;
            }

            if (selectedItem.unsupported_serial_batch) {
                showMessage(
                    "This item uses both serial and batch tracking. " +
                    "The custom selector does not support that combination."
                );
                return;
            }

            let selectedBatch = "";

            if (selectedItem.has_batch_no) {
                const batches = await call(BATCH_METHOD, {
                    item_code: selectedItem.item_code,
                    warehouse,
                });

                const available = (batches || []).filter(
                    (batch) => flt(batch.qty) > 0
                );

                if (!available.length) {
                    showMessage(
                        `No positive-quantity batch is available for ` +
                        `${selectedItem.item_code} in ${warehouse}.`
                    );
                    return;
                }

                const batch = await chooseBatch(available);
                if (!batch) return;

                selectedBatch = batch.batch_no;
            }

            // Standard ERPNext pricing, UOM, accounts and other item details.
            const details = await fetchStandardItemDetails(
                frm,
                selectedItem.item_code,
                warehouse,
                selectedBatch
            );

            const target = getTargetRow(
                frm,
                selectedItem.item_code,
                selectedBatch
            );

            const row = target.row;

            if (target.existing) {
                await setRowValue(row, "qty", flt(row.qty) + 1);
                await setRowValue(row, "warehouse", warehouse);
                await setRowValue(
                    row,
                    "custom_batch_no",
                    selectedBatch || ""
                );
            } else {
                await applyStandardDetails(
                    frm,
                    row,
                    details,
                    warehouse,
                    selectedBatch
                );
            }

            // Always set Quotation Item.custom_batch_no explicitly.
            await setRowValue(
                row,
                "custom_batch_no",
                selectedBatch || ""
            );

            // Only batch-tracked items use the batch-specific price lookup.
            if (selectedBatch) {
                await applyBatchPrice(
                    frm,
                    row,
                    selectedItem.item_code,
                    selectedBatch
                );
            }

            frm.refresh_field("items");
            frm.dirty();
        } catch (error) {
            console.error("Quotation batch scan failed:", error);

            showMessage(
                error?.message || "Failed to process the scanned barcode."
            );
        } finally {
            processing = false;
        }
    }

    // ---------------------------------------------------------
    // QUOTATION SCAN FIELD
    // ---------------------------------------------------------

    frappe.ui.form.on("Quotation", {
        scan_barcode(frm) {
            if (!isQuotation(frm)) return;

            const barcode = frm.doc.scan_barcode;
            if (!barcode) return;

            processBarcode(frm, barcode).finally(() => {
                if (frm.doc.scan_barcode) {
                    frappe.model.set_value(
                        frm.doctype,
                        frm.doc.name,
                        "scan_barcode",
                        ""
                    );
                }
            });
        },

        refresh(frm) {
            installQuotationScannerPatch();
        },
    });

    // ---------------------------------------------------------
    // SCANNER INTERCEPTION
    // Only custom handling for Quotation; other forms call original.
    // ---------------------------------------------------------

    function installQuotationScannerPatch() {
        const Scanner = window.erpnext?.utils?.BarcodeScanner;

        if (
            !Scanner ||
            !Scanner.prototype ||
            typeof Scanner.prototype.process_scan !== "function"
        ) {
            return;
        }

        if (Scanner.prototype.__styleToneQuotationBatchV12Patched) {
            return;
        }

        const original = Scanner.prototype.process_scan;

        Scanner.prototype.process_scan = function (barcode, ...args) {
            const frm = this.frm || window.cur_frm;

            if (isQuotation(frm)) {
                const value =
                    typeof barcode === "string"
                        ? barcode
                        : barcode?.text || barcode?.barcode || "";

                if (value) {
                    processBarcode(frm, value);
                    return;
                }
            }

            return original.call(this, barcode, ...args);
        };

        Scanner.prototype.__styleToneQuotationBatchV12Patched = true;
    }
})();
