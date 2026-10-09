
(() => {
    "use strict";

    const API = "my_custom_app.quotation_batch";
    const PATCH_FLAG = "__styleToneQuotationBarcodePatchV6";

    function isQuotation(frm) {
        return frm && frm.doctype === "Quotation";
    }

    function getWarehouse(frm) {
        return frm.doc.custom_warehouse || "";
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
        if (Array.isArray(data)) return { variants: data };

        const variants =
            data.variants ||
            data.item_variants ||
            data.items ||
            [];

        return { ...data, variants };
    }

    function chooseVariant(variants) {
        return new Promise((resolve) => {
            if (!variants.length) {
                resolve(null);
                return;
            }

            const rows = variants.map((item, index) => `
                <tr>
                    <td>${esc(item.item_code)}</td>
                    <td>${esc(item.item_name || "")}</td>
                    <td>${esc(item.available_qty || 0)}</td>
                    <td>${Number(item.has_batch_no) ? "Yes" : "No"}</td>
                    <td>
                        <button type="button"
                            class="btn btn-primary btn-xs choose-variant"
                            data-index="${index}">
                            Select
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
                    dialog.hide();
                    resolve(null);
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
                    dialog.hide();
                    resolve(selected || null);
                });

            dialog.onhide = () => {
                // If the user closes the dialog without selecting,
                // resolve(null) rather than leaving the scan pending.
                if (!dialog.__selected) {
                    resolve(null);
                }
            };

            dialog.show();
        });
    }

    function chooseBatch(batches) {
        return new Promise((resolve) => {
            if (!batches.length) {
                resolve(null);
                return;
            }

            const rows = batches.map((batch, index) => `
                <tr>
                    <td>${esc(batch.batch_no || batch.name)}</td>
                    <td>${esc(batch.expiry_date || "-")}</td>
                    <td>${esc(batch.available_qty ?? batch.qty ?? 0)}</td>
                    <td>
                        <button type="button"
                            class="btn btn-primary btn-xs choose-batch"
                            data-index="${index}">
                            Select
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
                    dialog.hide();
                    resolve(null);
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
                    const selected = batches[Number(this.dataset.index)];
                    dialog.hide();
                    resolve(selected || null);
                });

            dialog.onhide = () => resolve(null);
            dialog.show();
        });
    }

    function getReusableRow(frm, itemCode, batchNo) {
        const rows = frm.doc.items || [];

        // Reuse an existing row only for the same item and same batch.
        const existing = rows.find(row =>
            row.item_code === itemCode &&
            String(row.batch_no || row.custom_batch_no || "") ===
                String(batchNo || "")
        );

        if (existing) return { row: existing, existing: true };

        // Reuse a genuinely empty row if available.
        const empty = rows.find(row => !row.item_code);

        if (empty) return { row: empty, existing: false };

        const row = frm.add_child("items");
        return { row, existing: false };
    }

    async function fetchCoreItemDetails(frm, itemCode, warehouse, batchNo) {
        const ctx = {
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

        // Call ERPNext core directly; do not use a custom wrapper.
        const response = await frappe.call({
            method: "erpnext.stock.get_item_details.get_item_details",
            args: {
                args: ctx,
                doc: frm.doc,
            },
            freeze: true,
            freeze_message: __("Loading item details..."),
        });

        if (!response.message) {
            throw new Error(__("ERPNext did not return item details."));
        }

        return response.message;
    }

    async function applyItemDetails(
        frm, itemCode, warehouse, batchNo, details
    ) {
        const selected = getReusableRow(frm, itemCode, batchNo);
        const row = selected.row;

        // Standard item details may include pricing, UOM, description,
        // taxes and other fields. Preserve the chosen batch explicitly.
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
        ]);

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

        await frappe.model.set_value(
            row.doctype, row.name, "item_code", itemCode
        );

        if ("warehouse" in row) {
            await frappe.model.set_value(
                row.doctype, row.name, "warehouse", warehouse
            );
        }

        if (batchNo) {
            if ("batch_no" in row) {
                await frappe.model.set_value(
                    row.doctype, row.name, "batch_no", batchNo
                );
            }

            if ("custom_batch_no" in row) {
                await frappe.model.set_value(
                    row.doctype, row.name, "custom_batch_no", batchNo
                );
            }
        }

        if (!selected.existing) {
            await frappe.model.set_value(
                row.doctype, row.name, "qty", 1
            );
        } else {
            await frappe.model.set_value(
                row.doctype, row.name, "qty",
                (Number(row.qty) || 0) + 1
            );
        }

        frm.refresh_field("items");
        frm.dirty();
    }

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
            const raw = await call(
                `${API}.scan_barcode_with_variants`,
                { barcode, warehouse }
            );

            const result = normalizeResult(raw);

            let selected = null;

            if (result.is_template || result.variants.length) {
                // The Python endpoint has already filtered out variants
                // that have no positive available stock.
                const variants = result.variants.filter(item =>
                    Number(item.available_qty || 0) > 0
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
                    __("No available stock in the selected warehouse.")
                );
                return;
            } else if (result.item_code) {
                selected = result;
            }

            if (!selected || !selected.item_code) {
                notify(__("No available item was found for this barcode."));
                return;
            }

            const itemCode = selected.item_code;

            // Verify the actual selected Item record rather than relying
            // only on variant-picker data.
            let batchValue =
                selected.has_batch_no ??
                selected.has_batch ??
                selected.has_batch_item;

            if (batchValue === undefined ||
                batchValue === null ||
                batchValue === "") {
                const info = await frappe.db.get_value(
                    "Item", itemCode, "has_batch_no"
                );
                batchValue = info?.message?.has_batch_no;
            }

            const hasBatch = Number(batchValue || 0) === 1;
            let batchNo = "";

            if (hasBatch) {
                const batches = await call(
                    `${API}.get_available_batches`,
                    { item_code: itemCode, warehouse }
                );

                const availableBatches = (batches || []).filter(batch =>
                    Number(batch.available_qty ?? batch.qty ?? 0) > 0
                );

                if (!availableBatches.length) {
                    notify(
                        __("No positive-quantity batches are available.")
                    );
                    return;
                }

                const chosenBatch = await chooseBatch(availableBatches);
                if (!chosenBatch) return;

                batchNo = chosenBatch.batch_no || chosenBatch.name;
                if (!batchNo) return;
            }

            // Pass the selected batch before requesting core item details.
            const details = await fetchCoreItemDetails(
                frm, itemCode, warehouse, batchNo
            );

            await applyItemDetails(
                frm, itemCode, warehouse, batchNo, details
            );

        } catch (error) {
            console.error("Quotation barcode/batch error:", error);
            frappe.msgprint({
                title: __("Barcode Processing Error"),
                message: esc(error.message || error),
                indicator: "red",
            });
        }
    }

    function installScannerPatch() {
        if (window[PATCH_FLAG]) return;

        const Scanner = window.erpnext?.utils?.BarcodeScanner;
        if (!Scanner?.prototype?.process_scan) return;

        const original = Scanner.prototype.process_scan;

        Scanner.prototype.process_scan = function (data, ...args) {
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
    }

    frappe.ui.form.on("Quotation", {
        refresh(frm) {
            installScannerPatch();
        },

        scan_barcode(frm) {
            // Fallback for setups that trigger the Quotation field event.
            const barcode = frm.doc.scan_barcode;
            if (barcode) {
                processBarcode(frm, barcode);
                frm.set_value("scan_barcode", "");
            }
        },
    });
})();
