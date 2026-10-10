(() => {
    "use strict";

    const VERSION_FLAG = "__styleToneSalesInvoiceBatchV6";

    if (window[VERSION_FLAG]) return;
    window[VERSION_FLAG] = true;

    const LOOKUP_METHOD =
        "my_custom_app.sales_invoice_batch.scan_barcode_with_variants";

    const BATCH_METHOD =
        "my_custom_app.sales_invoice_batch.get_available_batches";

    const MAX_CACHE_SIZE = 100;
    const lookupCache = new Map();

    const USE_STANDARD_SCANNER = "__STYLETONE_USE_STANDARD_SCANNER__";


    // ========================================================
    // BASIC HELPERS
    // ========================================================

    function supported(frm) {
        return Boolean(
            frm &&
            frm.doctype === "Sales Invoice" &&
            !Number(frm.doc.is_pos || 0) &&
            !frm.doc.pos_profile
        );
    }

    function escapeHTML(value) {
        return frappe.utils.escape_html(String(value ?? ""));
    }

    function warehouseFor(frm) {
        return (
            frm.doc.source_warehouse ||
            frm.doc.set_warehouse ||
            ""
        );
    }

    function positiveQty(value) {
        const qty = Number(value || 0);
        return Number.isFinite(qty) && qty > 0;
    }

    function hasRowField(row, fieldname) {
        return Boolean(
            row &&
            frappe.meta.has_field(row.doctype, fieldname)
        );
    }

    function clearBarcodeCache() {
        lookupCache.clear();
    }


    // ========================================================
    // LOW-LOAD BARCODE LOOKUP CACHE
    // ========================================================

    async function lookupBarcode(barcode) {
        const key = String(barcode || "").trim();

        if (!key) {
            return { found: false };
        }

        if (lookupCache.has(key)) {
            // Refresh insertion order so frequently used keys stay longer.
            const cached = lookupCache.get(key);
            lookupCache.delete(key);
            lookupCache.set(key, cached);

            return cached;
        }

        const response = await frappe.call({
            method: LOOKUP_METHOD,
            args: {
                barcode: key,
            },
        });

        const result = response.message || { found: false };

        // Cache only successful results; never cache failed lookups.
        if (result.found === true) {
            if (
                !lookupCache.has(key) &&
                lookupCache.size >= MAX_CACHE_SIZE
            ) {
                const oldestKey = lookupCache.keys().next().value;
                lookupCache.delete(oldestKey);
            }

            lookupCache.set(key, result);
        }

        return result;
    }


    // ========================================================
    // VARIANT SELECTION
    // ========================================================

    function selectVariant(variants) {
        return new Promise((resolve) => {
            if (!Array.isArray(variants) || !variants.length) {
                frappe.msgprint(
                    __("No active variants were found for this template.")
                );
                resolve(null);
                return;
            }

            let finished = false;

            const rows = variants.map((item, index) => {
                const batchLabel = Number(item.has_batch_no)
                    ? __("Yes")
                    : __("No");

                return `
                    <tr>
                        <td>${escapeHTML(item.item_code)}</td>
                        <td>${escapeHTML(item.item_name)}</td>
                        <td>${batchLabel}</td>
                        <td>
                            <button
                                type="button"
                                class="btn btn-xs btn-primary st-select-variant"
                                data-index="${index}">
                                ${__("Select")}
                            </button>
                        </td>
                    </tr>
                `;
            }).join("");

            const dialog = new frappe.ui.Dialog({
                title: __("Select Item Variant"),
                size: "large",
                fields: [
                    {
                        fieldtype: "HTML",
                        fieldname: "variant_table",
                    },
                ],
            });

            const html = `
                <div class="table-responsive">
                    <table class="table table-bordered table-hover">
                        <thead>
                            <tr>
                                <th>${__("Item Code")}</th>
                                <th>${__("Item Name")}</th>
                                <th>${__("Batch Tracked")}</th>
                                <th>${__("Action")}</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            `;

            dialog.fields_dict.variant_table.$wrapper.html(html);

            function finish(value) {
                if (finished) return;
                finished = true;
                dialog.hide();
                resolve(value);
            }

            dialog.$wrapper.on(
                "click",
                ".st-select-variant",
                function () {
                    const index = Number(
                        this.getAttribute("data-index")
                    );

                    finish(
                        Number.isInteger(index)
                            ? variants[index] || null
                            : null
                    );
                }
            );

            dialog.set_primary_action(
                __("Cancel"),
                () => finish(null)
            );

            dialog.show();
        });
    }


    // ========================================================
    // BATCH SELECTION
    // ========================================================

    async function selectBatch(item, warehouse) {
        const response = await frappe.call({
            method: BATCH_METHOD,
            args: {
                item_code: item.item_code,
                warehouse: warehouse,
            },
        });

        // Quantities are fetched live for each batch selection.
        const batches = (response.message || [])
            .filter((batch) => positiveQty(batch.qty));

        if (!batches.length) {
            frappe.msgprint({
                title: __("No Available Batches"),
                message: __(
                    "No positive-quantity batches are available for {0} in warehouse {1}.",
                    [item.item_code, warehouse]
                ),
                indicator: "orange",
            });

            return null;
        }

        return new Promise((resolve) => {
            let finished = false;
            let selectedBatch = null;

            const rows = batches.map((batch, index) => `
                <tr class="st-batch-row" data-index="${index}">
                    <td>
                        <input
                            type="radio"
                            name="st_batch_choice"
                            value="${index}">
                    </td>
                    <td>${escapeHTML(batch.batch_no)}</td>
                    <td>${escapeHTML(batch.expiry_date || __("Not Set"))}</td>
                    <td class="text-right">
                        ${escapeHTML(batch.qty)}
                    </td>
                </tr>
            `).join("");

            const dialog = new frappe.ui.Dialog({
                title: __("Select Batch — {0}", [item.item_code]),
                size: "large",
                fields: [
                    {
                        fieldtype: "HTML",
                        fieldname: "batch_table",
                    },
                ],
            });

            dialog.fields_dict.batch_table.$wrapper.html(`
                <div class="table-responsive">
                    <table class="table table-bordered table-hover">
                        <thead>
                            <tr>
                                <th></th>
                                <th>${__("Batch No")}</th>
                                <th>${__("Expiry Date")}</th>
                                <th class="text-right">${__("Available Qty")}</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            `);

            function finish(value) {
                if (finished) return;
                finished = true;
                dialog.hide();
                resolve(value);
            }

            dialog.$wrapper.on("click", ".st-batch-row", function () {
                const index = Number(
                    this.getAttribute("data-index")
                );

                if (!Number.isInteger(index)) return;

                const batch = batches[index];

                if (!batch || !positiveQty(batch.qty)) return;

                selectedBatch = batch;

                dialog.$wrapper
                    .find('input[name="st_batch_choice"]')
                    .prop("checked", false);

                dialog.$wrapper
                    .find(
                        `input[name="st_batch_choice"][value="${index}"]`
                    )
                    .prop("checked", true);

                dialog.$wrapper
                    .find(".st-batch-row")
                    .removeClass("info");

                dialog.$wrapper
                    .find(this)
                    .addClass("info");
            });

            dialog.set_primary_action(
                __("Select Batch"),
                () => {
                    if (!selectedBatch) {
                        frappe.msgprint(
                            __("Select a batch before continuing.")
                        );
                        return;
                    }

                    finish(selectedBatch);
                }
            );

            dialog.set_secondary_action(() => finish(null));
            dialog.show();
        });
    }


    // ========================================================
    // ADD ITEM USING STANDARD ERPNext ITEM PROCESSING
    // ========================================================

    async function addItem(
        frm,
        item,
        warehouse,
        batchNo,
        barcode,
        barcodeUom
    ) {
        const itemCode = item.item_code;

        if (!itemCode) {
            throw new Error(__("The selected Item has no Item Code."));
        }

        const items = frm.doc.items || [];

        // Reuse only the exact item + warehouse + batch combination.
        // Different batches always get separate rows.
        const existing = items.find((row) => {
            return (
                row.item_code === itemCode &&
                (row.warehouse || warehouse) === warehouse &&
                String(row.batch_no || "") === String(batchNo || "")
            );
        });

        if (existing) {
            await frappe.model.set_value(
                existing.doctype,
                existing.name,
                "qty",
                Number(existing.qty || 0) + 1
            );

            if (barcode && hasRowField(existing, "barcode")) {
                await frappe.model.set_value(
                    existing.doctype,
                    existing.name,
                    "barcode",
                    barcode
                );
            }

            frm.refresh_field("items");
            return existing;
        }

        const grid = frm.fields_dict.items?.grid;

        if (!grid) {
            throw new Error(
                __("The Sales Invoice Items table is unavailable.")
            );
        }

        const row = frappe.model.add_child(
            frm.doc,
            grid.doctype,
            "items"
        );

        // When a batch has already been selected, prevent a second
        // native batch popup while ERPNext fills item details.
        const suppressNativeBatchDialog = Boolean(batchNo);
        const previousFlag = frappe.flags.hide_serial_batch_dialog;

        if (suppressNativeBatchDialog) {
            frappe.flags.hide_serial_batch_dialog = true;
        }

        try {
            // Setting item_code triggers ERPNext's standard item details:
            // price, UOM, taxes, defaults, and other row calculations.
            await frappe.model.set_value(
                row.doctype,
                row.name,
                "item_code",
                itemCode
            );

            if (hasRowField(row, "warehouse")) {
                await frappe.model.set_value(
                    row.doctype,
                    row.name,
                    "warehouse",
                    warehouse
                );
            }

            if (batchNo && hasRowField(row, "batch_no")) {
                await frappe.model.set_value(
                    row.doctype,
                    row.name,
                    "batch_no",
                    batchNo
                );
            }

            if (barcode && hasRowField(row, "barcode")) {
                await frappe.model.set_value(
                    row.doctype,
                    row.name,
                    "barcode",
                    barcode
                );
            }

            if (barcodeUom && hasRowField(row, "uom")) {
                await frappe.model.set_value(
                    row.doctype,
                    row.name,
                    "uom",
                    barcodeUom
                );
            }

            if (!Number(row.qty)) {
                await frappe.model.set_value(
                    row.doctype,
                    row.name,
                    "qty",
                    1
                );
            }
        } catch (error) {
            // Remove an incomplete row if standard item processing fails.
            if (row && row.name && frm.doc.items) {
                const currentIndex = frm.doc.items.findIndex(
                    (entry) => entry.name === row.name
                );

                if (currentIndex >= 0) {
                    frm.doc.items.splice(currentIndex, 1);
                }
            }

            frm.refresh_field("items");
            throw error;
        } finally {
            frappe.flags.hide_serial_batch_dialog = previousFlag;
        }

        frm.refresh_field("items");
        frm.dirty();

        return row;
    }


    // ========================================================
    // BARCODE WORKFLOW
    // ========================================================

    async function processBarcode(frm, barcode) {
        const warehouse = warehouseFor(frm);

        if (!warehouse) {
            frappe.msgprint({
                title: __("Warehouse Required"),
                message: __(
                    "Select Source Warehouse or Set Warehouse before scanning."
                ),
                indicator: "orange",
            });

            return false;
        }

        const lookup = await lookupBarcode(barcode);

        if (!lookup || lookup.found !== true) {
            frappe.msgprint({
                title: __("Item Not Found"),
                message: __("No Item was found for barcode {0}.", [barcode]),
                indicator: "red",
            });

            return false;
        }

        let selectedItem = lookup;

        // Template: choose the variant before any batch query.
        if (Number(lookup.has_variants)) {
            selectedItem = await selectVariant(lookup.variants);

            if (!selectedItem) {
                return false;
            }

            // Preserve the scanned barcode's UOM if supplied.
            if (!selectedItem.barcode_uom) {
                selectedItem.barcode_uom = lookup.barcode_uom;
            }
        }

        if (!selectedItem.item_code) {
            throw new Error(__("No valid Item Code was selected."));
        }

        let batchNo = null;

        // Serial-and-batch Items remain on ERPNext's native workflow.
        if (
            Number(selectedItem.has_batch_no) &&
            !Number(selectedItem.has_serial_no)
        ) {
            const batch = await selectBatch(selectedItem, warehouse);

            if (!batch) {
                return false;
            }

            batchNo = batch.batch_no;
        }

        await addItem(
            frm,
            selectedItem,
            warehouse,
            batchNo,
            barcode,
            selectedItem.barcode_uom
        );

        frappe.show_alert({
            message: __("{0} added to the invoice.", [
                selectedItem.item_name || selectedItem.item_code,
            ]),
            indicator: "green",
        });

        return true;
    }


    // ========================================================
    // SCANNER HOOK
    // ========================================================

    function installScannerHook() {
        const Scanner = window.erpnext?.utils?.BarcodeScanner;
        const prototype = Scanner?.prototype;

        if (
            !prototype ||
            typeof prototype.process_scan !== "function" ||
            prototype.__styleToneBatchV6Installed
        ) {
            return;
        }

        const originalProcessScan = prototype.process_scan;

        prototype.process_scan = function (...args) {
            const frm = this.frm;

            // POS and all other transaction types keep native behavior.
            if (!supported(frm)) {
                return originalProcessScan.apply(this, args);
            }

            const field = this.scan_barcode_field;
            const barcode = String(field?.value || "").trim();

            if (!barcode) {
                return Promise.resolve();
            }

            // Avoid duplicate overlapping processing on the same scanner.
            if (this.__styleToneBatchV6Busy) {
                return Promise.resolve();
            }

            this.__styleToneBatchV6Busy = true;

            if (field && typeof field.set_value === "function") {
                field.set_value("");
            }

            return processBarcode(frm, barcode)
                .then((result) => {
                    if (result) {
                        this.play_success_sound?.();
                    } else {
                        this.play_fail_sound?.();
                    }

                    return result;
                })
                .catch((error) => {
                    console.error(
                        "[STYLETONE] Barcode processing failed:",
                        error
                    );

                    frappe.msgprint({
                        title: __("Barcode Processing Failed"),
                        message: escapeHTML(
                            error?.message || __("An unexpected error occurred.")
                        ),
                        indicator: "red",
                    });

                    this.play_fail_sound?.();
                    return false;
                })
                .finally(() => {
                    this.__styleToneBatchV6Busy = false;

                    if (field && typeof field.set_value === "function") {
                        field.set_value("");
                    }

                    frm.refresh_field("items");
                });
        };

        prototype.__styleToneBatchV6Installed = true;
    }


    // ========================================================
    // FORM REGISTRATION
    // ========================================================

    frappe.ui.form.on("Sales Invoice", {
        refresh(frm) {
            installScannerHook();
        },
    });

    // Optional debugging/cache control.
    window.StyleToneSalesInvoiceBatch = {
        clearBarcodeCache,
        processBarcode,
        lookupBarcode,
        version: 6,
    };
})();