(() => {
    "use strict";

    const FLAG = "__styleToneSalesInvoiceBatchV7";

    if (window[FLAG]) return;
    window[FLAG] = true;

    const LOOKUP_METHOD =
        "my_custom_app.sales_invoice_batch.scan_barcode_with_variants";

    const BATCH_METHOD =
        "my_custom_app.sales_invoice_batch.get_available_batches";

    const lookupCache = new Map();
    const MAX_CACHE_SIZE = 100;

    // ========================================================
    // HELPERS
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

    function getWarehouse(frm) {
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

    function hasField(doctype, fieldname) {
        return Boolean(frappe.meta.has_field(doctype, fieldname));
    }

    // ========================================================
    // BARCODE LOOKUP CACHE
    // Cache item lookup only, never batch quantities.
    // ========================================================

    async function lookupBarcode(barcode) {
        const key = String(barcode || "").trim();

        if (!key) return { found: false };

        if (lookupCache.has(key)) {
            const cached = lookupCache.get(key);

            // Move frequently used entries to the end.
            lookupCache.delete(key);
            lookupCache.set(key, cached);

            return cached;
        }

        const response = await frappe.call({
            method: LOOKUP_METHOD,
            args: { barcode: key }
        });

        const result = response.message || { found: false };

        if (result.found === true) {
            if (
                !lookupCache.has(key) &&
                lookupCache.size >= MAX_CACHE_SIZE
            ) {
                lookupCache.delete(
                    lookupCache.keys().next().value
                );
            }

            lookupCache.set(key, result);
        }

        return result;
    }

    // ========================================================
    // VARIANT SELECTOR
    // ========================================================

    function selectVariant(template) {
        const variants = template.variants || [];

        return new Promise((resolve) => {
            if (!variants.length) {
                frappe.msgprint(
                    __("No active variants found for this template.")
                );
                resolve(null);
                return;
            }

            let finished = false;

            const dialog = new frappe.ui.Dialog({
                title: __("Select Item Variant"),
                size: "large",
                fields: [
                    {
                        fieldtype: "HTML",
                        fieldname: "variant_table"
                    }
                ]
            });

            const rows = variants.map((item, index) => `
                <tr>
                    <td>${escapeHTML(item.item_code)}</td>
                    <td>${escapeHTML(item.item_name)}</td>
                    <td>
                        ${Number(item.has_batch_no) ? __("Yes") : __("No")}
                    </td>
                    <td>
                        <button
                            type="button"
                            class="btn btn-xs btn-primary st-select-variant"
                            data-index="${index}">
                            ${__("Select")}
                        </button>
                    </td>
                </tr>
            `).join("");

            dialog.fields_dict.variant_table.$wrapper.html(`
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
            `);

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

                    const item = variants[index];

                    // Never pass the template itself to item processing.
                    if (
                        !item ||
                        !item.item_code ||
                        item.item_code === template.item_code
                    ) {
                        frappe.msgprint(
                            __("Please select a valid item variant.")
                        );
                        return;
                    }

                    finish({
                        ...item,
                        barcode_uom: item.barcode_uom ||
                            template.barcode_uom
                    });
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
    // BATCH SELECTOR
    // Each batch has its own Select button.
    // ========================================================

    async function selectBatch(item, warehouse) {
        const response = await frappe.call({
            method: BATCH_METHOD,
            args: {
                item_code: item.item_code,
                warehouse
            }
        });

        const batches = (response.message || [])
            .filter((batch) => (
                batch.batch_no &&
                positiveQty(batch.qty)
            ));

        if (!batches.length) {
            frappe.msgprint({
                title: __("No Available Batches"),
                message: __(
                    "No positive-quantity batches are available for {0} in {1}.",
                    [item.item_code, warehouse]
                ),
                indicator: "orange"
            });

            return null;
        }

        return new Promise((resolve) => {
            let finished = false;

            const dialog = new frappe.ui.Dialog({
                title: __("Select Batch — {0}", [item.item_code]),
                size: "large",
                fields: [
                    {
                        fieldtype: "HTML",
                        fieldname: "batch_table"
                    }
                ]
            });

            const rows = batches.map((batch, index) => `
                <tr>
                    <td>${escapeHTML(batch.batch_no)}</td>
                    <td>${escapeHTML(batch.expiry_date || __("Not Set"))}</td>
                    <td class="text-right">
                        ${escapeHTML(batch.qty)}
                    </td>
                    <td>
                        <button
                            type="button"
                            class="btn btn-xs btn-primary st-select-batch"
                            data-index="${index}">
                            ${__("Select")}
                        </button>
                    </td>
                </tr>
            `).join("");

            dialog.fields_dict.batch_table.$wrapper.html(`
                <div class="table-responsive">
                    <table class="table table-bordered table-hover">
                        <thead>
                            <tr>
                                <th>${__("Batch No")}</th>
                                <th>${__("Expiry Date")}</th>
                                <th class="text-right">${__("Available Qty")}</th>
                                <th>${__("Action")}</th>
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

            dialog.$wrapper.on(
                "click",
                ".st-select-batch",
                function () {
                    const index = Number(
                        this.getAttribute("data-index")
                    );

                    const batch = batches[index];

                    if (!batch || !positiveQty(batch.qty)) {
                        frappe.msgprint(
                            __("This batch has no available quantity.")
                        );
                        return;
                    }

                    // Selecting a batch closes the dialog immediately.
                    finish(batch);
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
    // ADD ITEM
    // Do not create a row until a real variant is selected.
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
            throw new Error(__("Item Code is missing."));
        }

        if (Number(item.has_variants)) {
            throw new Error(
                __("Select a variant instead of the template.")
            );
        }

        const existing = (frm.doc.items || []).find((row) => (
            row.item_code === itemCode &&
            (row.warehouse || warehouse) === warehouse &&
            String(row.batch_no || "") === String(batchNo || "")
        ));

        // Reuse an existing row only for the same item + batch.
        if (existing) {
            await frappe.model.set_value(
                existing.doctype,
                existing.name,
                "qty",
                Number(existing.qty || 0) + 1
            );

            frm.refresh_field("items");
            frm.dirty();

            return existing;
        }

        const grid = frm.fields_dict.items?.grid;

        if (!grid) {
            throw new Error(
                __("Sales Invoice Items table is unavailable.")
            );
        }

        // Create the row only after template and batch selection.
        const row = frappe.model.add_child(
            frm.doc,
            grid.doctype,
            "items"
        );

        let success = false;

        try {
            // Let ERPNext populate item details through its standard flow.
            await frappe.model.set_value(
                row.doctype,
                row.name,
                "item_code",
                itemCode
            );

            if (hasField(row.doctype, "warehouse")) {
                await frappe.model.set_value(
                    row.doctype,
                    row.name,
                    "warehouse",
                    warehouse
                );
            }

            if (barcode && hasField(row.doctype, "barcode")) {
                await frappe.model.set_value(
                    row.doctype,
                    row.name,
                    "barcode",
                    barcode
                );
            }

            if (barcodeUom && hasField(row.doctype, "uom")) {
                await frappe.model.set_value(
                    row.doctype,
                    row.name,
                    "uom",
                    barcodeUom
                );
            }

            if (batchNo && hasField(row.doctype, "batch_no")) {
                await frappe.model.set_value(
                    row.doctype,
                    row.name,
                    "batch_no",
                    batchNo
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

            success = true;
        } finally {
            if (!success) {
                // Remove only this failed row; do not leave an empty row.
                const index = (frm.doc.items || []).findIndex(
                    (entry) => entry.name === row.name
                );

                if (index >= 0) {
                    frm.doc.items.splice(index, 1);
                }

                frm.refresh_field("items");
            }
        }

        frm.refresh_field("items");
        frm.dirty();

        return row;
    }

    // ========================================================
    // SCAN WORKFLOW
    // ========================================================

    async function processBarcode(frm, barcode) {
        const warehouse = getWarehouse(frm);

        if (!warehouse) {
            frappe.msgprint({
                title: __("Warehouse Required"),
                message: __(
                    "Select Source Warehouse or Set Warehouse before scanning."
                ),
                indicator: "orange"
            });

            return false;
        }

        const lookup = await lookupBarcode(barcode);

        if (!lookup || lookup.found !== true) {
            frappe.msgprint({
                title: __("Item Not Found"),
                message: __("No Item found for barcode {0}.", [barcode]),
                indicator: "red"
            });

            return false;
        }

        let item = lookup;

        if (Number(lookup.has_variants)) {
            item = await selectVariant(lookup);

            if (!item) return false;
        }

        // Extra protection against the exact template error.
        if (
            !item.item_code ||
            item.item_code === lookup.item_code && Number(lookup.has_variants)
        ) {
            frappe.msgprint(
                __("A valid variant must be selected before adding the item.")
            );

            return false;
        }

        let batchNo = null;

        // Serial-tracked items remain on ERPNext's standard workflow.
        if (
            Number(item.has_batch_no) &&
            !Number(item.has_serial_no)
        ) {
            const batch = await selectBatch(item, warehouse);

            if (!batch) return false;

            batchNo = batch.batch_no;
        }

        await addItem(
            frm,
            item,
            warehouse,
            batchNo,
            barcode,
            item.barcode_uom
        );

        frappe.show_alert({
            message: __("{0} added.", [
                item.item_name || item.item_code
            ]),
            indicator: "green"
        });

        return true;
    }

    // ========================================================
    // SCANNER INTERCEPTION
    // ========================================================

    function installScannerHook() {
        const prototype =
            window.erpnext?.utils?.BarcodeScanner?.prototype;

        if (
            !prototype ||
            typeof prototype.process_scan !== "function" ||
            prototype.__styleToneBatchV7Installed
        ) {
            return;
        }

        const original = prototype.process_scan;

        prototype.process_scan = function (...args) {
            const frm = this.frm;

            // Preserve the native scanner on all unsupported forms.
            if (!supported(frm)) {
                return original.apply(this, args);
            }

            // Prevent a second scan while this scan is being handled.
            if (frm.__styleToneBatchV7Busy) {
                return Promise.resolve();
            }

            const field = this.scan_barcode_field;

            // Some versions pass the scanned value as a function argument;
            // others expose it in the scanner field.
            const argumentBarcode = args.find(
                (value) =>
                    typeof value === "string" &&
                    value.trim() !== ""
            );

            const barcode = String(
                argumentBarcode ||
                field?.value ||
                ""
            ).trim();

            if (!barcode) {
                return Promise.resolve();
            }

            frm.__styleToneBatchV7Busy = true;

            if (field && typeof field.set_value === "function") {
                field.set_value("");
            }

            return processBarcode(frm, barcode)
                .catch((error) => {
                    console.error(
                        "[STYLETONE] Barcode processing failed:",
                        error
                    );

                    frappe.msgprint({
                        title: __("Barcode Processing Failed"),
                        message: escapeHTML(
                            error?.message || __("Unexpected error.")
                        ),
                        indicator: "red"
                    });

                    return false;
                })
                .finally(() => {
                    frm.__styleToneBatchV7Busy = false;

                    if (field && typeof field.set_value === "function") {
                        field.set_value("");
                    }

                    frm.refresh_field("items");
                });
        };

        prototype.__styleToneBatchV7Installed = true;
    }

    frappe.ui.form.on("Sales Invoice", {
        refresh(frm) {
            installScannerHook();
        }
    });

    window.StyleToneSalesInvoiceBatch = {
        version: 7,
        processBarcode,
        lookupBarcode,
        clearBarcodeCache() {
            lookupCache.clear();
        }
    };
})();