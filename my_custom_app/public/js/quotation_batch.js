
/* STYLETONE - ERPNext v16 Quotation Barcode / Batch / Price */

(() => {
    "use strict";

    const VERSION = "16.1";
    const PREFIX = "[STYLETONE Quotation Batch]";
    const PATCH_FLAG = "__styleToneQuotationBatchV161";

    if (window.__styleToneQuotationBatchV161Loaded) return;
    window.__styleToneQuotationBatchV161Loaded = true;

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

    // -----------------------------------------------------
    // HELPERS
    // -----------------------------------------------------

    function supported(frm) {
        return frm?.doc?.doctype === "Quotation";
    }

    function getWarehouse(frm) {
        return (
            frm.doc.custom_warehouse ||
            frm.doc.set_warehouse ||
            frappe.defaults.get_user_default("Warehouse") ||
            ""
        );
    }

    function getBarcodeValue(value) {
        if (typeof value === "string") {
            return value.trim();
        }

        if (value && typeof value === "object") {
            return String(
                value.barcode ||
                value.value ||
                value.text ||
                value.decodedText ||
                ""
            ).trim();
        }

        return "";
    }

    function esc(value) {
        return frappe.utils.escape_html(String(value ?? ""));
    }

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function showError(error) {
        console.error(PREFIX, error);

        frappe.msgprint({
            title: __("Quotation Barcode / Batch Error"),
            indicator: "red",
            message: esc(
                error?.message ||
                (typeof error === "string" ? error : null) ||
                __("Barcode processing failed.")
            )
        });
    }

    function notify(message, indicator = "green") {
        frappe.show_alert({
            message: __(message),
            indicator
        });
    }

    function serverCall(method, args) {
        return frappe.call({
            method,
            args,
            freeze: false
        }).then(response => {
            if (response?.exc) {
                throw new Error(
                    response._server_messages ||
                    __("The server request failed.")
                );
            }

            return response?.message;
        });
    }

    function getCustomer(frm) {
        return frm.doc.quotation_to === "Customer"
            ? frm.doc.party_name || ""
            : "";
    }

    function getSellingPriceList(frm) {
        return frm.doc.selling_price_list || "";
    }

    function getPriceListRate(priceResult) {
        if (!priceResult || priceResult.found !== true) {
            return 0;
        }

        const rate = Number(priceResult.price_list_rate);

        return Number.isFinite(rate) && rate >= 0 ? rate : 0;
    }

    async function recalculateTotals(frm) {
        if (frm.cscript?.calculate_taxes_and_totals) {
            await frm.cscript.calculate_taxes_and_totals();
        } else {
            await frm.trigger("calculate_taxes_and_totals");
        }
    }

    // -----------------------------------------------------
    // TABLE PICKER
    // -----------------------------------------------------

    function selectFromTable(title, rows, columns) {
        return new Promise(resolve => {
            if (!Array.isArray(rows) || !rows.length) {
                resolve(null);
                return;
            }

            let finished = false;

            const dialog = new frappe.ui.Dialog({
                title: __(title),
                size: "large",
                fields: [{
                    fieldname: "selection_table",
                    fieldtype: "HTML"
                }]
            });

            function finish(value) {
                if (finished) return;
                finished = true;
                resolve(value);
            }

            const headers = columns.map(column =>
                `<th>${esc(column.label)}</th>`
            ).join("");

            const body = rows.map((row, index) => {
                const cells = columns.map(column => {
                    let value = row[column.field];

                    if (column.field === "has_batch_no") {
                        value = Number(value) === 1
                            ? __("Yes")
                            : __("No");
                    }

                    return `<td>${esc(
                        value === null ||
                        value === undefined ||
                        value === ""
                            ? "-"
                            : value
                    )}</td>`;
                }).join("");

                return `
                    <tr>
                        <td>
                            <button
                                type="button"
                                class="btn btn-primary btn-xs st-select"
                                data-index="${index}">
                                ${__("Select")}
                            </button>
                        </td>
                        ${cells}
                    </tr>
                `;
            }).join("");

            dialog.fields_dict.selection_table.$wrapper.html(`
                <div class="table-responsive"
                     style="max-height:55vh;overflow:auto;">
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

            dialog.fields_dict.selection_table.$wrapper.on(
                "click.styleToneQuotationV161",
                ".st-select",
                function () {
                    const index = Number(
                        this.getAttribute("data-index")
                    );

                    finish(rows[index] || null);
                    dialog.hide();
                }
            );

            dialog.$wrapper.on(
                "hidden.bs.modal.styleToneQuotationV161",
                () => {
                    finish(null);
                    dialog.$wrapper.off(".styleToneQuotationV161");
                }
            );

            dialog.show();
        });
    }

    // -----------------------------------------------------
    // VARIANT PICKER
    // -----------------------------------------------------

    async function chooseVariant(response) {
        const variants = response?.variants || [];

        if (!variants.length) {
            notify(
                `No variants with positive available stock were found for ${
                    response?.item_name || response?.item_code || ""
                }.`,
                "orange"
            );

            return null;
        }

        return selectFromTable(
            __("Select Item Variant"),
            variants,
            [
                { field: "item_code", label: __("Item Code") },
                { field: "item_name", label: __("Item Name") },
                { field: "has_batch_no", label: __("Batch Tracked") },
                { field: "available_qty", label: __("Available Qty") }
            ]
        );
    }

    // -----------------------------------------------------
    // BATCH PICKER
    // -----------------------------------------------------

    async function chooseBatch(frm, itemCode) {
        const warehouse = getWarehouse(frm);

        if (!warehouse) {
            frappe.msgprint(
                __("Select a Warehouse before selecting a batch.")
            );
            return null;
        }

        const result = await serverCall(BATCH_METHOD, {
            item_code: itemCode,
            warehouse
        });

        const batches = (Array.isArray(result) ? result : [])
            .filter(batch =>
                batch?.batch_no &&
                Number(
                    batch.available_qty ??
                    batch.qty ??
                    0
                ) > 0
            );

        if (!batches.length) {
            notify(
                `No positive-quantity batches are available for ${itemCode}.`,
                "orange"
            );
            return null;
        }

        return selectFromTable(
            __("Select Batch"),
            batches,
            [
                { field: "batch_no", label: __("Batch No") },
                { field: "expiry_date", label: __("Expiry Date") },
                {
                    field: "available_qty",
                    label: __("Available Qty")
                }
            ]
        );
    }

    // -----------------------------------------------------
    // ERPNext STANDARD ITEM DETAILS
    // -----------------------------------------------------

    async function getStandardItemDetails(frm, itemCode, batchNo) {
        const warehouse = getWarehouse(frm);

        const ctx = {
            item_code: itemCode,
            company: frm.doc.company,
            doctype: "Quotation",
            parenttype: "Quotation",
            quotation_to: frm.doc.quotation_to,
            customer: getCustomer(frm),
            transaction_date: frm.doc.transaction_date,
            selling_price_list: getSellingPriceList(frm),
            price_list: getSellingPriceList(frm),
            price_list_currency: frm.doc.price_list_currency,
            currency: frm.doc.currency,
            plc_conversion_rate: frm.doc.plc_conversion_rate || 1,
            conversion_rate: frm.doc.conversion_rate || 1,
            warehouse,
            set_warehouse: frm.doc.set_warehouse || warehouse,
            qty: 1,
            batch_no: batchNo || "",
            ignore_pricing_rule: frm.doc.ignore_pricing_rule || 0
        };

        const details = await serverCall(DETAILS_METHOD, {
            ctx: JSON.stringify(ctx),
            doc: JSON.stringify(frm.doc)
        });

        if (!details) {
            throw new Error(
                __("ERPNext returned no item details.")
            );
        }

        if (details.item_code && details.item_code !== itemCode) {
            throw new Error(
                __("ERPNext returned details for a different item.")
            );
        }

        return details;
    }

    // -----------------------------------------------------
    // BATCH PRICE LOOKUP
    // -----------------------------------------------------

    async function getBatchPrice(frm, itemCode, batchNo, uom) {
        const priceList = getSellingPriceList(frm);

        if (!priceList) {
            return {
                found: false,
                price_list_rate: 0,
                match_type: "not_found"
            };
        }

        const result = await serverCall(PRICE_METHOD, {
            item_code: itemCode,
            batch_no: batchNo || "",
            price_list: priceList,
            transaction_date: frm.doc.transaction_date,
            customer: getCustomer(frm),
            uom: uom || ""
        });

        if (!result || result.found !== true) {
            return {
                found: false,
                price_list_rate: 0,
                match_type: "not_found"
            };
        }

        return {
            ...result,
            found: true,
            price_list_rate: Number(result.price_list_rate || 0)
        };
    }

    // -----------------------------------------------------
    // APPLY STANDARD ITEM DETAILS
    // -----------------------------------------------------

    function applyDetailsToRow(row, details) {
        const meta = frappe.get_meta("Quotation Item");

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
            if (excluded.has(field) || value === undefined) {
                continue;
            }

            const df = meta.fields.find(
                definition => definition.fieldname === field
            );

            if (df) {
                row[field] = value;
            }
        }
    }

    // -----------------------------------------------------
    // ENFORCE BATCH PRICE
    // -----------------------------------------------------

    async function enforcePrice(row, priceResult) {
        const finalRate = getPriceListRate(priceResult);
        const doctype = row.doctype;
        const name = row.name;
        const meta = frappe.get_meta(doctype);

        const hasField = field =>
            meta.fields.some(df => df.fieldname === field);

        if (hasField("discount_percentage")) {
            await frappe.model.set_value(
                doctype, name, "discount_percentage", 0
            );
        }

        if (hasField("discount_amount")) {
            await frappe.model.set_value(
                doctype, name, "discount_amount", 0
            );
        }

        await frappe.model.set_value(
            doctype, name, "price_list_rate", finalRate
        );

        await frappe.model.set_value(
            doctype, name, "rate", finalRate
        );

        await delay(150);

        const currentRow = locals[doctype]?.[name];

        if (!currentRow) {
            throw new Error(
                __("The Quotation Item row no longer exists.")
            );
        }

        currentRow.price_list_rate = finalRate;
        currentRow.rate = finalRate;

        if (hasField("discount_percentage")) {
            currentRow.discount_percentage = 0;
        }

        if (hasField("discount_amount")) {
            currentRow.discount_amount = 0;
        }

        return finalRate;
    }

    // -----------------------------------------------------
    // ADD ITEM OR UPDATE SAME ITEM + BATCH + WAREHOUSE
    // -----------------------------------------------------

    async function addQuotationItem(
        frm,
        itemCode,
        batch,
        details,
        priceResult
    ) {
        const batchNo = batch?.batch_no || "";
        const warehouse = getWarehouse(frm);
        const meta = frappe.get_meta("Quotation Item");

        const hasBatchField = meta.fields.some(
            field => field.fieldname === BATCH_FIELD
        );

        if (batchNo && !hasBatchField) {
            throw new Error(
                `Quotation Item does not have the ${BATCH_FIELD} field.`
            );
        }

        const existing = (frm.doc.items || []).find(row =>
            row.item_code === itemCode &&
            String(row[BATCH_FIELD] || "") === String(batchNo) &&
            String(row.warehouse || "") === String(warehouse)
        );

        if (existing) {
            const rowDoctype = existing.doctype;
            const rowName = existing.name;
            const nextQty = Number(existing.qty || 0) + 1;

            await frappe.model.set_value(
                rowDoctype, rowName, "qty", nextQty
            );

            if (hasBatchField) {
                await frappe.model.set_value(
                    rowDoctype, rowName, BATCH_FIELD, batchNo
                );
            }

            existing[BATCH_FIELD] = batchNo;
            existing.warehouse = warehouse;

            await recalculateTotals(frm);
            await enforcePrice(existing, priceResult);

            await recalculateTotals(frm);
            await enforcePrice(existing, priceResult);

            existing[BATCH_FIELD] = batchNo;
            existing.warehouse = warehouse;

            frm.refresh_field("items");
            frm.dirty();

            return existing;
        }

        let row = (frm.doc.items || []).find(child =>
            !child.item_code && !child[BATCH_FIELD]
        );

        if (!row) {
            row = frm.add_child("items");
        }

        row.item_code = itemCode;

        applyDetailsToRow(row, details);

        row.item_code = itemCode;
        row.qty = 1;
        row.warehouse = warehouse || row.warehouse || "";

        if (hasBatchField) {
            row[BATCH_FIELD] = batchNo;
        }

        await recalculateTotals(frm);
        await enforcePrice(row, priceResult);

        await recalculateTotals(frm);
        await enforcePrice(row, priceResult);

        if (hasBatchField) {
            row[BATCH_FIELD] = batchNo;
        }

        row.warehouse = warehouse || row.warehouse || "";

        frm.refresh_field("items");
        frm.dirty();

        return row;
    }

    // -----------------------------------------------------
    // MANUAL ITEM SELECTION — QUOTATION
    // Select batch and apply the matching batch price.
    // -----------------------------------------------------

    async function handleManualQuotationItem(frm, cdt, cdn) {
        if (!supported(frm) || processing) return;

        const row = locals[cdt]?.[cdn];
        if (!row?.item_code) return;

        const itemCode = String(row.item_code).trim();

        if (
            row.__styleToneManualBatchBusy ||
            row.__styleToneBatchHandledFor === itemCode
        ) {
            return;
        }

        row.__styleToneManualBatchBusy = true;

        try {
            // Let ERPNext populate standard item details first.
            await delay(350);

            if (
                !supported(frm) ||
                processing ||
                String(row.item_code || "").trim() !== itemCode
            ) {
                return;
            }

            const itemResult = await frappe.db.get_value(
                "Item",
                itemCode,
                [
                    "name",
                    "disabled",
                    "has_variants",
                    "variant_of",
                    "has_batch_no",
                    "is_stock_item"
                ]
            );

            const item = itemResult?.message;

            if (!item?.name || Number(item.disabled) === 1) {
                return;
            }

            // Do not handle an item template as a stock item.
            if (
                Number(item.has_variants) === 1 &&
                !item.variant_of
            ) {
                return;
            }

            // Preserve standard ERPNext handling for non-batch items.
            if (Number(item.has_batch_no) !== 1) {
                row.__styleToneBatchHandledFor = itemCode;
                return;
            }

            // Avoid opening the picker again if a batch is assigned.
            if (String(row[BATCH_FIELD] || "").trim()) {
                row.__styleToneBatchHandledFor = itemCode;
                return;
            }

            const warehouse = getWarehouse(frm);

            if (!warehouse) {
                frappe.msgprint({
                    title: __("Warehouse Required"),
                    message: __(
                        "Select a Warehouse before selecting a batch."
                    ),
                    indicator: "orange"
                });
                return;
            }

            const selectedBatch = await chooseBatch(frm, itemCode);

            if (!selectedBatch?.batch_no) {
                // Keep the user's item selection; no batch was assigned.
                return;
            }

            if (String(row.item_code || "").trim() !== itemCode) {
                return;
            }

            // Fetch the same standard details and price used by barcode flow.
            const details = await getStandardItemDetails(
                frm,
                itemCode,
                selectedBatch.batch_no
            );

            const uom =
                details.uom ||
                details.stock_uom ||
                row.uom ||
                "";

            const priceResult = await getBatchPrice(
                frm,
                itemCode,
                selectedBatch.batch_no,
                uom
            );

            if (String(row.item_code || "").trim() !== itemCode) {
                return;
            }

            // Keep the existing row; do not add a duplicate item row.
            applyDetailsToRow(row, details);

            row.item_code = itemCode;
            row.warehouse = warehouse;

            await frappe.model.set_value(
                cdt,
                cdn,
                BATCH_FIELD,
                selectedBatch.batch_no
            );

            row[BATCH_FIELD] = selectedBatch.batch_no;

            await recalculateTotals(frm);
            await enforcePrice(row, priceResult);

            await recalculateTotals(frm);
            await enforcePrice(row, priceResult);

            // Reassert custom batch field after standard calculations.
            row[BATCH_FIELD] = selectedBatch.batch_no;
            row.warehouse = warehouse;
            row.__styleToneBatchHandledFor = itemCode;

            frm.refresh_field("items");
            frm.dirty();

            if (priceResult.found) {
                notify(
                    `Batch ${selectedBatch.batch_no} selected for ${itemCode}. Price ${getPriceListRate(priceResult)} applied.`
                );
            } else {
                notify(
                    `Batch ${selectedBatch.batch_no} selected for ${itemCode}, but no matching Item Price was found; rate set to 0.`,
                    "orange"
                );
            }

        } catch (error) {
            showError(error);
        } finally {
            row.__styleToneManualBatchBusy = false;
        }
    }

    frappe.ui.form.on("Quotation Item", {
        item_code(frm, cdt, cdn) {
            handleManualQuotationItem(frm, cdt, cdn);
        }
    });

    // -----------------------------------------------------
    // MAIN BARCODE FLOW
    // -----------------------------------------------------

    async function processBarcode(frm, rawBarcode) {
        if (!supported(frm)) return;

        const barcode = getBarcodeValue(rawBarcode);

        if (!barcode || processing) return;

        if (!getWarehouse(frm)) {
            frappe.msgprint(
                __("Select a Warehouse before scanning.")
            );
            return;
        }

        processing = true;

        try {
            const response = await serverCall(SCAN_METHOD, {
                barcode,
                warehouse: getWarehouse(frm)
            });

            if (!response || response.found !== true) {
                notify(
                    response?.message ||
                    `No item was found for barcode ${barcode}.`,
                    "orange"
                );
                return;
            }

            let chosen;

            if (response.is_template === true) {
                chosen = await chooseVariant(response);
                if (!chosen) return;
            } else {
                chosen = response.item;

                if (!chosen?.item_code) {
                    throw new Error(
                        __("Barcode lookup did not return a concrete item.")
                    );
                }
            }

            const itemCode = chosen.item_code;

            const itemResult = await frappe.db.get_value(
                "Item",
                itemCode,
                [
                    "name",
                    "disabled",
                    "has_variants",
                    "variant_of",
                    "has_batch_no",
                    "is_stock_item"
                ]
            );

            const item = itemResult?.message;

            if (!item || Number(item.disabled) === 1) {
                throw new Error(
                    `Item ${itemCode} is missing or disabled.`
                );
            }

            if (
                Number(item.has_variants) === 1 &&
                !item.variant_of
            ) {
                throw new Error(
                    `${itemCode} is a template. Select a concrete variant.`
                );
            }

            if (Number(item.is_stock_item) !== 1) {
                throw new Error(
                    `${itemCode} is not a stock item.`
                );
            }

            let selectedBatch = null;

            if (Number(item.has_batch_no) === 1) {
                selectedBatch = await chooseBatch(frm, itemCode);

                if (!selectedBatch) return;
            }

            const batchNo = selectedBatch?.batch_no || "";

            const details = await getStandardItemDetails(
                frm,
                itemCode,
                batchNo
            );

            const priceUom =
                details.uom ||
                details.stock_uom ||
                "";

            const priceResult = await getBatchPrice(
                frm,
                itemCode,
                batchNo,
                priceUom
            );

            console.info(`${PREFIX} price result`, {
                item_code: itemCode,
                selected_batch: batchNo,
                price_list: getSellingPriceList(frm),
                price_result: priceResult
            });

            await addQuotationItem(
                frm,
                itemCode,
                selectedBatch,
                details,
                priceResult
            );

            if (priceResult.found) {
                notify(
                    `Added ${itemCode}` +
                    (batchNo ? `, batch ${batchNo}` : "") +
                    `. Applied price ${getPriceListRate(priceResult)}.`
                );
            } else {
                notify(
                    `Added ${itemCode}` +
                    (batchNo ? `, batch ${batchNo}` : "") +
                    `. No matching Item Price found; rate set to 0.`,
                    "orange"
                );
            }

        } catch (error) {
            showError(error);
        } finally {
            processing = false;
        }
    }

    // -----------------------------------------------------
    // SCANNER PATCH — QUOTATION ONLY
    // -----------------------------------------------------

    function installScannerPatch() {
        const Scanner = window.erpnext?.utils?.BarcodeScanner;

        if (!Scanner?.prototype) {
            return false;
        }

        const proto = Scanner.prototype;

        if (proto[PATCH_FLAG]) {
            return true;
        }

        const original = proto.process_scan;

        if (typeof original !== "function") {
            return false;
        }

        proto.process_scan = function (...args) {
            const frm = this.frm || window.cur_frm;

            if (!supported(frm)) {
                return original.apply(this, args);
            }

            const barcode =
                getBarcodeValue(args[0]) ||
                getBarcodeValue(frm.doc.scan_barcode);

            if (!barcode) {
                return original.apply(this, args);
            }

            if (frm.doc.scan_barcode) {
                frm.doc.scan_barcode = "";

                const field = frm.fields_dict?.scan_barcode;

                if (field?.$input) {
                    field.$input.val("");
                }
            }

            processBarcode(frm, barcode).catch(showError);

            // Prevent standard scanner processing from adding a duplicate row.
            return Promise.resolve();
        };

        Object.defineProperty(proto, PATCH_FLAG, {
            value: true,
            configurable: false
        });

        console.info(
            `${PREFIX} Quotation scanner connected (V${VERSION}).`
        );

        return true;
    }

    frappe.ui.form.on("Quotation", {
        refresh() {
            installScannerPatch();
        }
    });

    window.StyleToneQuotationBatch = {
        version: VERSION,
        processBarcode,
        installScannerPatch
    };

    installScannerPatch();

})();
