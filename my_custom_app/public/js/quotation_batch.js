
(() => {
    "use strict";

    if (window.__styleToneQuotationBatchV13) return;
    window.__styleToneQuotationBatchV13 = true;

    const SCAN_METHOD =
        "my_custom_app.quotation_batch.scan_barcode_with_variants";

    const BATCH_METHOD =
        "my_custom_app.quotation_batch.get_available_batches";

    const PRICE_METHOD =
        "my_custom_app.quotation_batch.get_batch_item_price";

    const DETAILS_METHOD =
        "erpnext.stock.get_item_details.get_item_details";

    const BATCH_FIELD = "custom_batch_no";

    let processing = false;

    // ---------------------------------------------------------
    // BASIC HELPERS
    // ---------------------------------------------------------

    function isQuotation(frm) {
        return Boolean(
            frm &&
            frm.doc &&
            frm.doc.doctype === "Quotation"
        );
    }

    function getWarehouse(frm) {
        return (
            frm.doc.custom_warehouse ||
            frm.doc.set_warehouse ||
            ""
        );
    }

    function getBarcodeValue(data) {
        if (typeof data === "string") return data.trim();

        if (data && typeof data === "object") {
            return String(
                data.barcode ||
                data.value ||
                data.text ||
                data.decodedText ||
                ""
            ).trim();
        }

        return "";
    }

    function notify(message, indicator = "orange") {
        frappe.show_alert({
            message: __(message),
            indicator
        });
    }

    function escapeHTML(value) {
        return frappe.utils.escape_html(String(value ?? ""));
    }

    function call(method, args) {
        return frappe.call({
            method,
            args,
            freeze: false
        }).then((r) => {
            if (r && r.exc) {
                throw new Error(
                    r._server_messages ||
                    __("Server request failed.")
                );
            }

            return r ? r.message : null;
        });
    }

    function getCustomer(frm) {
        return frm.doc.quotation_to === "Customer"
            ? frm.doc.party_name
            : "";
    }

    // ---------------------------------------------------------
    // SELECT ONE ROW FROM A TABLE
    // ---------------------------------------------------------

    function chooseFromTable(title, rows, columns) {
        return new Promise((resolve) => {
            if (!rows || !rows.length) {
                resolve(null);
                return;
            }

            const dialog = new frappe.ui.Dialog({
                title: __(title),
                size: "large",
                fields: [
                    {
                        fieldname: "selection_html",
                        fieldtype: "HTML"
                    }
                ],
                primary_action_label: __("Cancel"),
                primary_action() {
                    dialog.hide();
                    resolve(null);
                },
                secondary_action_label: __("Cancel")
            });

            const headers = columns.map((col) =>
                `<th>${escapeHTML(col.label)}</th>`
            ).join("");

            const body = rows.map((row, index) => {
                const cells = columns.map((col) => {
                    const value = row[col.field];

                    return `<td>${escapeHTML(
                        value == null || value === ""
                            ? "-"
                            : value
                    )}</td>`;
                }).join("");

                return `
                    <tr>
                        <td>
                            <button
                                type="button"
                                class="btn btn-primary btn-xs st-select-row"
                                data-index="${index}">
                                ${__("Select")}
                            </button>
                        </td>
                        ${cells}
                    </tr>
                `;
            }).join("");

            dialog.fields_dict.selection_html.$wrapper.html(`
                <div style="max-height:55vh;overflow:auto;">
                    <table class="table table-bordered table-hover">
                        <thead>
                            <tr>
                                <th>${__("Action")}</th>
                                ${headers}
                            </tr>
                        </thead>
                        <tbody>${body}</tbody>
                    </table>
                </div>
            `);

            dialog.fields_dict.selection_html.$wrapper
                .off("click.stQuotationBatch")
                .on(
                    "click.stQuotationBatch",
                    ".st-select-row",
                    function () {
                        const index = Number(
                            this.getAttribute("data-index")
                        );

                        const selected = rows[index] || null;
                        dialog.hide();
                        resolve(selected);
                    }
                );

            dialog.onhide = () => {
                resolve(null);
            };

            dialog.show();
        });
    }

    // ---------------------------------------------------------
    // CHOOSE A VARIANT
    // ---------------------------------------------------------

    async function chooseVariant(response) {
        const variants = response.variants || [];

        if (!variants.length) {
            notify(
                `No variants of ${response.item_name || response.item_code} ` +
                "have positive available stock in the selected warehouse."
            );
            return null;
        }

        return chooseFromTable(
            __("Select Item Variant"),
            variants,
            [
                {
                    field: "item_code",
                    label: __("Item Code")
                },
                {
                    field: "item_name",
                    label: __("Item Name")
                },
                {
                    field: "has_batch_no",
                    label: __("Batch Tracked")
                },
                {
                    field: "available_qty",
                    label: __("Available Qty")
                }
            ]
        );
    }

    // ---------------------------------------------------------
    // CHOOSE A BATCH
    // ---------------------------------------------------------

    async function chooseBatch(frm, itemCode) {
        const warehouse = getWarehouse(frm);

        if (!warehouse) {
            frappe.msgprint(
                __("Select a Warehouse before scanning.")
            );
            return null;
        }

        const batches = await call(BATCH_METHOD, {
            item_code: itemCode,
            warehouse
        });

        if (!Array.isArray(batches) || !batches.length) {
            notify(
                `No positive-quantity batches are available for ${itemCode}.`
            );
            return null;
        }

        return chooseFromTable(
            __("Select Batch"),
            batches,
            [
                {
                    field: "batch_no",
                    label: __("Batch No")
                },
                {
                    field: "expiry_date",
                    label: __("Expiry Date")
                },
                {
                    field: "available_qty",
                    label: __("Available Qty")
                }
            ]
        );
    }

    // ---------------------------------------------------------
    // FETCH STANDARD ERPNext ITEM DETAILS
    //
    // IMPORTANT:
    // ERPNext v16 expects the first argument as "ctx".
    // Do not send it as "args".
    // ---------------------------------------------------------

    async function fetchCoreItemDetails(frm, itemCode, batchNo) {
        const warehouse = getWarehouse(frm);

        const ctx = {
            item_code: itemCode,
            barcode: "",
            batch_no: batchNo || "",
            company: frm.doc.company,
            doctype: "Quotation",
            parenttype: "Quotation",
            quotation_to: frm.doc.quotation_to,
            customer: getCustomer(frm),
            transaction_date: frm.doc.transaction_date,
            selling_price_list: frm.doc.selling_price_list,
            price_list: frm.doc.selling_price_list,
            price_list_currency: frm.doc.price_list_currency,
            currency: frm.doc.currency,
            plc_conversion_rate: frm.doc.plc_conversion_rate || 1,
            conversion_rate: frm.doc.conversion_rate || 1,
            warehouse,
            set_warehouse: frm.doc.set_warehouse || warehouse,
            qty: 1,
            ignore_pricing_rule: frm.doc.ignore_pricing_rule || 0,
            is_pos: 0
        };

        const result = await call(DETAILS_METHOD, {
            ctx: JSON.stringify(ctx),
            doc: JSON.stringify(frm.doc)
        });

        if (!result) {
            throw new Error(
                __("ERPNext returned no item details.")
            );
        }

        return result;
    }

    // ---------------------------------------------------------
    // APPLY STANDARD DETAILS TO A QUOTATION ITEM
    // ---------------------------------------------------------

    async function addQuotationItem(frm, itemCode, batch) {
        const batchNo = batch ? batch.batch_no : "";

        // Ask ERPNext for the actual selected variant's details.
        const details = await fetchCoreItemDetails(
            frm,
            itemCode,
            batchNo
        );

        // Do not add template items or a mismatched item.
        if (
            details.item_code &&
            details.item_code !== itemCode
        ) {
            throw new Error(
                __("ERPNext returned details for a different item.")
            );
        }

        const childMeta = frappe.get_meta("Quotation Item");

        // Reuse a row only when both item and selected batch match.
        let row = (frm.doc.items || []).find((d) =>
            d.item_code === itemCode &&
            String(d[BATCH_FIELD] || "") === String(batchNo || "")
        );

        let isNewRow = false;

        if (!row) {
            row = frappe.model.add_child(
                frm.doc,
                "Quotation Item",
                "items"
            );
            isNewRow = true;
        }

        const cdt = row.doctype;
        const cdn = row.name;

        // Set the actual item before applying returned details.
        await frappe.model.set_value(
            cdt,
            cdn,
            "item_code",
            itemCode
        );

        // Apply only fields that exist on Quotation Item.
        // Do not copy parent/document metadata into the child row.
        const excluded = new Set([
            "doctype",
            "name",
            "parent",
            "parentfield",
            "parenttype",
            "idx",
            "item_code",
            "batch_no",
            BATCH_FIELD
        ]);

        for (const [field, value] of Object.entries(details)) {
            if (excluded.has(field)) continue;
            if (value === undefined) continue;

            const df = childMeta.fields.find(
                (f) => f.fieldname === field
            );

            if (!df) continue;

            row[field] = value;
        }

        row.item_code = itemCode;
        row.qty = row.qty || 1;
        row.warehouse = row.warehouse || getWarehouse(frm);

        if (childMeta.fields.some(
            (f) => f.fieldname === BATCH_FIELD
        )) {
            row[BATCH_FIELD] = batchNo || "";
        } else if (batchNo) {
            throw new Error(
                `Quotation Item is missing the ${BATCH_FIELD} field.`
            );
        }

        frm.refresh_field("items");

        // Recalculate standard Quotation Item details.
        await frappe.model.set_value(
            cdt,
            cdn,
            "qty",
            row.qty || 1
        );

        // -----------------------------------------------------
        // OVERRIDE PRICE ONLY WHEN A MATCHING BATCH PRICE EXISTS
        // -----------------------------------------------------

        if (batchNo && frm.doc.selling_price_list) {
            const price = await call(PRICE_METHOD, {
                item_code: itemCode,
                batch_no: batchNo,
                price_list: frm.doc.selling_price_list,
                transaction_date: frm.doc.transaction_date,
                customer: getCustomer(frm),
                uom: row.uom || ""
            });

            if (price && price.found) {
                await frappe.model.set_value(
                    cdt,
                    cdn,
                    "price_list_rate",
                    price.price_list_rate
                );

                await frappe.model.set_value(
                    cdt,
                    cdn,
                    "rate",
                    price.price_list_rate
                );

                // Keep the selected batch on the quotation row.
                await frappe.model.set_value(
                    cdt,
                    cdn,
                    BATCH_FIELD,
                    batchNo
                );
            }
        }

        frm.refresh_field("items");

        if (frm.cscript && frm.cscript.calculate_taxes_and_totals) {
            frm.cscript.calculate_taxes_and_totals();
        } else {
            frm.trigger("calculate_taxes_and_totals");
        }

        frm.dirty();

        return {
            row,
            isNewRow
        };
    }

    // ---------------------------------------------------------
    // PROCESS BARCODE
    // ---------------------------------------------------------

    async function processBarcode(frm, barcode) {
        barcode = getBarcodeValue(barcode);

        if (!barcode || !isQuotation(frm)) return;

        if (processing) return;

        const warehouse = getWarehouse(frm);

        if (!warehouse) {
            frappe.msgprint(
                __("Select a Warehouse before scanning.")
            );
            return;
        }

        processing = true;

        try {
            const response = await call(SCAN_METHOD, {
                barcode,
                warehouse
            });

            if (!response || response.found !== true) {
                notify(
                    response && response.message
                        ? response.message
                        : `No matching item found for barcode ${barcode}.`
                );
                return;
            }

            let selectedItem;

            if (response.is_template === true) {
                selectedItem = await chooseVariant(response);

                if (!selectedItem) return;
            } else {
                selectedItem = response.item;

                if (!selectedItem || !selectedItem.item_code) {
                    notify("Barcode lookup returned no valid item.");
                    return;
                }
            }

            const itemCode = selectedItem.item_code;

            // Batch popup is shown only for batch-tracked items.
            let selectedBatch = null;

            if (Number(selectedItem.has_batch_no) === 1) {
                selectedBatch = await chooseBatch(frm, itemCode);

                if (!selectedBatch) return;
            }

            await addQuotationItem(
                frm,
                itemCode,
                selectedBatch
            );

            notify(
                `Added ${itemCode}` +
                (selectedBatch
                    ? ` — Batch ${selectedBatch.batch_no}`
                    : ""),
                "green"
            );
        } catch (error) {
            console.error(
                "[STYLETONE Quotation Batch]",
                error
            );

            frappe.msgprint({
                title: __("Quotation Barcode Error"),
                indicator: "red",
                message: escapeHTML(
                    error && error.message
                        ? error.message
                        : __("Unable to process barcode.")
                )
            });
        } finally {
            processing = false;
        }
    }

    // ---------------------------------------------------------
    // INTERCEPT BARCODE SCANS ONLY ON QUOTATION
    // Other doctypes use ERPNext's original scanner.
    // ---------------------------------------------------------

    function installScannerPatch() {
        const Scanner =
            window.erpnext &&
            erpnext.utils &&
            erpnext.utils.BarcodeScanner;

        if (!Scanner || !Scanner.prototype) return false;

        const proto = Scanner.prototype;

        if (proto.__styleToneQuotationBatchV13) return true;

        const originalProcessScan = proto.process_scan;

        if (typeof originalProcessScan !== "function") {
            return false;
        }

        proto.process_scan = function (data) {
            const frm =
                this.frm ||
                (this.dialog && this.dialog.frm) ||
                window.cur_frm;

            if (!isQuotation(frm)) {
                return originalProcessScan.apply(this, arguments);
            }

            const barcode = getBarcodeValue(data);

            if (!barcode) {
                return originalProcessScan.apply(this, arguments);
            }

            processBarcode(frm, barcode);

            return;
        };

        proto.__styleToneQuotationBatchV13 = true;

        return true;
    }

    // ---------------------------------------------------------
    // INSTALL WHEN ERPNext'S SCANNER IS AVAILABLE
    // ---------------------------------------------------------

    function install() {
        installScannerPatch();
    }

    install();

    // Form events are a fallback for scanner versions that trigger
    // the Quotation scan_barcode field directly.
    frappe.ui.form.on("Quotation", {
        refresh(frm) {
            installScannerPatch();
        },

        scan_barcode(frm) {
            const barcode = frm.doc.scan_barcode;

            if (!barcode || processing) return;

            // Clear the field before processing the scan.
            frappe.model.set_value(
                frm.doctype,
                frm.docname,
                "scan_barcode",
                ""
            );

            processBarcode(frm, barcode);
        }
    });
})();
