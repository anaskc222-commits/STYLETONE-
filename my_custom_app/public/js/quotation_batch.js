(() => {
    "use strict";

    const API = "my_custom_app.quotation_batch";
    const PATCH_FLAG = "__styleToneQuotationBarcodePatchV7";

    // --------------------------------------------------------
    // BASIC HELPERS
    // --------------------------------------------------------

    function isQuotation(frm) {
        return !!frm && frm.doctype === "Quotation";
    }

    function getWarehouse(frm) {
        return String(frm.doc.custom_warehouse || "").trim();
    }

    function esc(value) {
        return frappe.utils.escape_html(String(value ?? ""));
    }

    function notify(message, indicator = "orange") {
        frappe.show_alert({ message, indicator });
    }

    async function call(method, args) {
        const response = await frappe.call({
            method,
            args,
            freeze: false,
        });

        return response.message;
    }

    function normalizeResult(data) {
        if (!data) return {};

        if (Array.isArray(data)) {
            return { variants: data };
        }

        return {
            ...data,
            variants:
                data.variants ||
                data.item_variants ||
                data.items ||
                [],
        };
    }

    function positiveQty(item) {
        return Number(
            item?.available_qty ?? item?.qty ?? 0
        ) > 0;
    }

    function getItemBatchFlag(item) {
        return Number(
            item?.has_batch_no ??
            item?.has_batch ??
            item?.has_batch_item ??
            0
        ) === 1;
    }

    // --------------------------------------------------------
    // SAFE DIALOG RESOLUTION
    // --------------------------------------------------------

    function chooseVariant(variants) {
        return new Promise((resolve) => {
            if (!variants?.length) {
                resolve(null);
                return;
            }

            let settled = false;

            const finish = (value) => {
                if (settled) return;
                settled = true;
                resolve(value || null);
            };

            const rows = variants.map((item, index) => `
                <tr>
                    <td>${esc(item.item_code)}</td>
                    <td>${esc(item.item_name || "")}</td>
                    <td>${esc(item.available_qty ?? 0)}</td>
                    <td>${getItemBatchFlag(item) ? "Yes" : "No"}</td>
                    <td>
                        <button type="button"
                            class="btn btn-primary btn-xs choose-variant"
                            data-index="${index}">
                            ${__("Select")}
                        </button>
                    </td>
                </tr>
            `).join("");

            const dialog = new frappe.ui.Dialog({
                title: __("Select Available Variant"),
                size: "large",
                fields: [{
                    fieldtype: "HTML",
                    fieldname: "variant_list",
                }],
                primary_action_label: __("Close"),
                primary_action() {
                    finish(null);
                    dialog.hide();
                },
            });

            dialog.fields_dict.variant_list.$wrapper.html(`
                <div class="table-responsive">
                    <table class="table table-bordered">
                        <thead>
                            <tr>
                                <th>${__("Item Code")}</th>
                                <th>${__("Item Name")}</th>
                                <th>${__("Available Qty")}</th>
                                <th>${__("Batch Tracked")}</th>
                                <th>${__("Action")}</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            `);

            dialog.fields_dict.variant_list.$wrapper
                .find(".choose-variant")
                .on("click", function () {
                    const index = Number(this.dataset.index);
                    const selected = variants[index];

                    finish(selected);
                    dialog.hide();
                });

            dialog.onhide = () => finish(null);
            dialog.show();
        });
    }

    function chooseBatch(batches) {
        return new Promise((resolve) => {
            if (!batches?.length) {
                resolve(null);
                return;
            }

            let settled = false;

            const finish = (value) => {
                if (settled) return;
                settled = true;
                resolve(value || null);
            };

            const rows = batches.map((batch, index) => `
                <tr>
                    <td>${esc(batch.batch_no || batch.name)}</td>
                    <td>${esc(batch.expiry_date || "-")}</td>
                    <td>${esc(batch.available_qty ?? batch.qty ?? 0)}</td>
                    <td>
                        <button type="button"
                            class="btn btn-primary btn-xs choose-batch"
                            data-index="${index}">
                            ${__("Select")}
                        </button>
                    </td>
                </tr>
            `).join("");

            const dialog = new frappe.ui.Dialog({
                title: __("Select Available Batch"),
                size: "large",
                fields: [{
                    fieldtype: "HTML",
                    fieldname: "batch_list",
                }],
                primary_action_label: __("Close"),
                primary_action() {
                    finish(null);
                    dialog.hide();
                },
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
                .find(".choose-batch")
                .on("click", function () {
                    const index = Number(this.dataset.index);
                    const selected = batches[index];

                    finish(selected);
                    dialog.hide();
                });

            dialog.onhide = () => finish(null);
            dialog.show();
        });
    }

    // --------------------------------------------------------
    // ITEM FIELD LOOKUP
    // --------------------------------------------------------

    async function getItemHasBatch(itemCode) {
        const response = await frappe.db.get_value(
            "Item",
            itemCode,
            ["has_batch_no", "disabled", "is_stock_item"]
        );

        const item = response?.message;

        if (!item) {
            throw new Error(
                __("Item {0} was not found.", [itemCode])
            );
        }

        if (Number(item.disabled || 0)) {
            throw new Error(__("This item is disabled."));
        }

        if (!Number(item.is_stock_item || 0)) {
            throw new Error(__("This is not a stock item."));
        }

        return Number(item.has_batch_no || 0) === 1;
    }

    // --------------------------------------------------------
    // FETCH STANDARD ERPNext ITEM DETAILS
    // --------------------------------------------------------

    async function fetchCoreItemDetails(
        frm,
        itemCode,
        warehouse,
        batchNo
    ) {
        const args = {
            doctype: "Quotation",
            item_code: itemCode,
            warehouse,
            batch_no: batchNo || "",
            company: frm.doc.company,
            customer: frm.doc.party_name || frm.doc.customer || "",
            transaction_date: frm.doc.transaction_date,
            price_list: frm.doc.selling_price_list,
            selling_price_list: frm.doc.selling_price_list,
            currency: frm.doc.currency,
            conversion_rate: frm.doc.conversion_rate || 1,
            qty: 1,
        };

        const response = await frappe.call({
            method: "erpnext.stock.get_item_details.get_item_details",
            args: {
                args,
                doc: frm.doc,
            },
            freeze: true,
            freeze_message: __("Loading item details..."),
        });

        if (!response.message) {
            throw new Error(
                __("ERPNext did not return item details.")
            );
        }

        return response.message;
    }

    // --------------------------------------------------------
    // FIND OR CREATE ROW
    // --------------------------------------------------------

    function findReusableRow(frm, itemCode, batchNo) {
        const rows = frm.doc.items || [];
        const selectedBatch = String(batchNo || "");

        const existing = rows.find((row) => {
            if (row.item_code !== itemCode) {
                return false;
            }

            const rowBatch = String(
                row.batch_no || row.custom_batch_no || ""
            );

            return rowBatch === selectedBatch;
        });

        if (existing) {
            return {
                row: existing,
                existing: true,
            };
        }

        const empty = rows.find((row) => !row.item_code);

        if (empty) {
            return {
                row: empty,
                existing: false,
            };
        }

        return {
            row: null,
            existing: false,
        };
    }

    // --------------------------------------------------------
    // APPLY DETAILS AND INSERT ITEM
    // --------------------------------------------------------

    async function applyItemDetails(
        frm,
        itemCode,
        warehouse,
        batchNo,
        details
    ) {
        // Find a reusable row only after the server has returned
        // item details successfully.
        const match = findReusableRow(
            frm,
            itemCode,
            batchNo
        );

        if (match.existing) {
            const row = match.row;

            await frappe.model.set_value(
                row.doctype,
                row.name,
                "qty",
                (Number(row.qty) || 0) + 1
            );

            // Keep the selected batch mapping consistent.
            if (batchNo) {
                if ("batch_no" in row) {
                    await frappe.model.set_value(
                        row.doctype,
                        row.name,
                        "batch_no",
                        batchNo
                    );
                }

                if ("custom_batch_no" in row) {
                    await frappe.model.set_value(
                        row.doctype,
                        row.name,
                        "custom_batch_no",
                        batchNo
                    );
                }
            }

            frm.refresh_field("items");
            frm.dirty();
            return;
        }

        // Create a new child row only after item details are ready.
        const row = match.row || frm.add_child("items");

        // Avoid triggering a second asynchronous item lookup by
        // assigning item_code directly. Details were already fetched.
        row.item_code = itemCode;

        const excluded = new Set([
            "name",
            "doctype",
            "parent",
            "parenttype",
            "parentfield",
            "idx",
            "item_code",
            "batch_no",
            "custom_batch_no",
            "qty",
        ]);

        // Apply returned ERPNext fields, including rate, UOM,
        // description, conversion factors and other supported fields.
        for (const [field, value] of Object.entries(details)) {
            if (excluded.has(field)) continue;
            if (value === undefined) continue;
            if (!(field in row)) continue;

            await frappe.model.set_value(
                row.doctype,
                row.name,
                field,
                value
            );
        }

        // Always use the selected Quotation warehouse.
        if ("warehouse" in row) {
            await frappe.model.set_value(
                row.doctype,
                row.name,
                "warehouse",
                warehouse
            );
        }

        // Explicitly map the selected batch to both fields when present.
        if (batchNo) {
            if ("batch_no" in row) {
                await frappe.model.set_value(
                    row.doctype,
                    row.name,
                    "batch_no",
                    batchNo
                );
            }

            if ("custom_batch_no" in row) {
                await frappe.model.set_value(
                    row.doctype,
                    row.name,
                    "custom_batch_no",
                    batchNo
                );
            }
        }

        await frappe.model.set_value(
            row.doctype,
            row.name,
            "qty",
            1
        );

        frm.refresh_field("items");
        frm.dirty();

        // Ask the Quotation form to recalculate totals if its standard
        // handler is available.
        if (typeof frm.trigger === "function") {
            await frm.trigger("calculate_taxes_and_totals");
        }
    }

    // --------------------------------------------------------
    // BARCODE PROCESSING
    // --------------------------------------------------------

    async function processBarcode(frm, barcode) {
        if (!isQuotation(frm)) return;

        barcode = String(barcode || "").trim();

        if (!barcode) return;

        const warehouse = getWarehouse(frm);

        if (!warehouse) {
            frappe.msgprint(
                __("Please select the Quotation Warehouse first.")
            );
            return;
        }

        try {
            // Step 1: Resolve barcode and identify available variants.
            const raw = await call(
                `${API}.scan_barcode_with_variants`,
                {
                    barcode,
                    warehouse,
                }
            );

            const result = normalizeResult(raw);
            let selected = null;

            // Step 2: Template barcode -> variant popup.
            if (result.is_template || result.variants.length) {
                const variants = result.variants.filter(
                    positiveQty
                );

                if (!variants.length) {
                    notify(
                        __("No available stock in the selected warehouse.")
                    );
                    return;
                }

                selected = await chooseVariant(variants);

                if (!selected) return;
            } else if (result.no_stock) {
                notify(
                    result.message ||
                    __("No available stock in the selected warehouse.")
                );
                return;
            } else if (result.item_code) {
                selected = result;
            }

            if (!selected?.item_code) {
                notify(
                    __("No available item was found for this barcode.")
                );
                return;
            }

            const itemCode = selected.item_code;

            // Step 3: Verify batch tracking from the actual Item record.
            const hasBatch = await getItemHasBatch(itemCode);
            let batchNo = "";

            // Step 4: Batch-tracked item -> batch popup.
            if (hasBatch) {
                const batches = await call(
                    `${API}.get_available_batches`,
                    {
                        item_code: itemCode,
                        warehouse,
                    }
                );

                const availableBatches = (
                    batches || []
                ).filter(positiveQty);

                if (!availableBatches.length) {
                    notify(
                        __("No positive-quantity batches are available.")
                    );
                    return;
                }

                const chosenBatch = await chooseBatch(
                    availableBatches
                );

                if (!chosenBatch) return;

                batchNo = String(
                    chosenBatch.batch_no ||
                    chosenBatch.name ||
                    ""
                ).trim();

                if (!batchNo) {
                    throw new Error(
                        __("The selected batch has no batch number.")
                    );
                }
            }

            // Step 5: Fetch ERPNext item details only after the final
            // variant and batch have been selected.
            const details = await fetchCoreItemDetails(
                frm,
                itemCode,
                warehouse,
                batchNo
            );

            // Step 6: Add/update the row and explicitly map the batch.
            await applyItemDetails(
                frm,
                itemCode,
                warehouse,
                batchNo,
                details
            );

        } catch (error) {
            console.error(
                "StyleTone Quotation barcode error:",
                error
            );

            frappe.msgprint({
                title: __("Barcode Processing Error"),
                message: esc(
                    error?.message || error
                ),
                indicator: "red",
            });
        }
    }

    // --------------------------------------------------------
    // SCANNER PATCH
    // --------------------------------------------------------

    function installScannerPatch() {
        if (window[PATCH_FLAG]) return;

        const Scanner =
            window.erpnext?.utils?.BarcodeScanner;

        if (!Scanner?.prototype?.process_scan) {
            // The scanner class or method is not available yet.
            // A later Quotation refresh will retry installation.
            return;
        }

        const original = Scanner.prototype.process_scan;

        Scanner.prototype.process_scan = function (
            data,
            ...args
        ) {
            const frm = cur_frm;

            if (isQuotation(frm)) {
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

        window[PATCH_FLAG] = true;
        console.info(
            "StyleTone Quotation barcode patch installed."
        );
    }

    // --------------------------------------------------------
    // QUOTATION EVENTS
    // --------------------------------------------------------

    frappe.ui.form.on("Quotation", {
        refresh(frm) {
            installScannerPatch();
        },

        scan_barcode(frm) {
            const barcode = frm.doc.scan_barcode;

            if (!barcode) return;

            // Clear first to prevent the same barcode being processed
            // again by a subsequent field refresh.
            frm.set_value("scan_barcode", "");

            processBarcode(frm, barcode);
        },
    });
})();