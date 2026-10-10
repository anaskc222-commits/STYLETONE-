
(() => {
    "use strict";

    const FLAG = "__styleToneSalesInvoiceBatchV83";
    const PATCH_FLAG = "__styleToneBatchV83Installed";

    if (window[FLAG]) return;
    window[FLAG] = true;

    const LOOKUP_METHOD =
        "my_custom_app.sales_invoice_batch.scan_barcode_with_variants";

    const BATCH_METHOD =
        "my_custom_app.sales_invoice_batch.get_available_batches";

    const lookupCache = new Map();
    const MAX_CACHE_SIZE = 100;

    function supported(frm) {
        return Boolean(
            frm &&
            frm.doc &&
            frm.doctype === "Sales Invoice" &&
            !Number(frm.doc.is_pos || 0) &&
            !frm.doc.pos_profile
        );
    }

    function esc(value) {
        return frappe.utils.escape_html(String(value ?? ""));
    }

    function getWarehouse(frm) {
        return (
            frm.doc.source_warehouse ||
            frm.doc.set_warehouse ||
            ""
        );
    }

    function getBarcodeValue(value) {
        if (typeof value === "string") return value.trim();

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

    function hasField(doctype, fieldname) {
        return Boolean(frappe.meta.has_field(doctype, fieldname));
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
                    __("Server request failed.")
                );
            }

            return response?.message;
        });
    }

    function showError(error) {
        console.error("[STYLETONE Sales Invoice V8.3]", error);

        frappe.msgprint({
            title: __("Barcode Processing Failed"),
            message: esc(
                error?.message ||
                (typeof error === "string"
                    ? error
                    : __("Unexpected error."))
            ),
            indicator: "red"
        });
    }

    // --------------------------------------------------------
    // BARCODE LOOKUP
    // --------------------------------------------------------

    async function lookupBarcode(barcode) {
        const key = String(barcode || "").trim();

        if (!key) return { found: false };

        if (lookupCache.has(key)) {
            const cached = lookupCache.get(key);
            lookupCache.delete(key);
            lookupCache.set(key, cached);
            return cached;
        }

        const result = await serverCall(LOOKUP_METHOD, {
            barcode: key
        });

        const lookup = result || { found: false };

        if (lookup.found === true) {
            if (lookupCache.size >= MAX_CACHE_SIZE) {
                lookupCache.delete(
                    lookupCache.keys().next().value
                );
            }

            lookupCache.set(key, lookup);
        }

        return lookup;
    }

    function normalizeLookup(response) {
        const item = response?.item || response;

        return {
            isTemplate:
                Number(response?.has_variants) === 1 ||
                Number(item?.has_variants) === 1,

            variants:
                response?.variants ||
                item?.variants ||
                [],

            item
        };
    }

    // --------------------------------------------------------
    // SELECTOR TABLE
    // --------------------------------------------------------

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
                    fieldtype: "HTML",
                    fieldname: "selection_table"
                }]
            });

            function finish(value) {
                if (finished) return;
                finished = true;
                dialog.hide();
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

                    if (
                        value === null ||
                        value === undefined ||
                        value === ""
                    ) {
                        value = "-";
                    }

                    return `<td>${esc(value)}</td>`;
                }).join("");

                return `
                    <tr>
                        <td>
                            <button
                                type="button"
                                class="btn btn-primary btn-xs st-v83-select"
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
                "click.styleToneV83",
                ".st-v83-select",
                function () {
                    const index = Number(
                        this.getAttribute("data-index")
                    );
                    finish(rows[index] || null);
                }
            );

            dialog.$wrapper.on(
                "hidden.bs.modal.styleToneV83",
                () => {
                    finish(null);
                    dialog.$wrapper.off(".styleToneV83");
                }
            );

            dialog.set_primary_action(
                __("Cancel"),
                () => finish(null)
            );

            dialog.show();
        });
    }

    // --------------------------------------------------------
    // VARIANT SELECTOR
    // --------------------------------------------------------

    async function selectVariant(response) {
        const normalized = normalizeLookup(response);
        const variants = normalized.variants;

        if (!Array.isArray(variants) || !variants.length) {
            frappe.msgprint({
                title: __("No Variants Found"),
                message: __(
                    "The barcode matched a template, but the server returned no variants."
                ),
                indicator: "orange"
            });

            return null;
        }

        return selectFromTable(
            __("Select Item Variant"),
            variants,
            [
                { field: "item_code", label: __("Item Code") },
                { field: "item_name", label: __("Item Name") },
                { field: "has_batch_no", label: __("Batch Tracked") }
            ]
        );
    }

    // --------------------------------------------------------
    // VALIDATE ACTUAL ITEM
    // --------------------------------------------------------

    async function validateConcreteItem(itemCode) {
        itemCode = String(itemCode || "").trim();

        if (!itemCode) {
            throw new Error(__("Selected item has no Item Code."));
        }

        const response = await frappe.db.get_value(
            "Item",
            itemCode,
            [
                "name",
                "disabled",
                "has_variants",
                "variant_of",
                "has_batch_no",
                "has_serial_no"
            ]
        );

        const master = response?.message;

        if (!master?.name) {
            throw new Error(
                __("Item {0} does not exist.", [itemCode])
            );
        }

        if (Number(master.disabled) === 1) {
            throw new Error(
                __("Item {0} is disabled.", [itemCode])
            );
        }

        if (
            Number(master.has_variants) === 1 &&
            !master.variant_of
        ) {
            throw new Error(
                __("Item {0} is a template. Select a variant.", [
                    itemCode
                ])
            );
        }

        return master;
    }

    // --------------------------------------------------------
    // BATCH SELECTOR
    // --------------------------------------------------------

    async function selectBatch(itemCode, warehouse) {
        const result = await serverCall(BATCH_METHOD, {
            item_code: itemCode,
            warehouse
        });

        const batches = (
            Array.isArray(result) ? result : []
        )
            .filter(batch =>
                batch?.batch_no &&
                Number(batch.qty ?? batch.available_qty ?? 0) > 0
            )
            .map(batch => ({
                ...batch,
                qty: Number(batch.qty ?? batch.available_qty)
            }));

        if (!batches.length) {
            frappe.msgprint({
                title: __("No Available Batches"),
                message: __(
                    "No positive-quantity batches are available for {0} in {1}.",
                    [itemCode, warehouse]
                ),
                indicator: "orange"
            });

            return null;
        }

        return selectFromTable(
            __("Select Batch — {0}", [itemCode]),
            batches,
            [
                { field: "batch_no", label: __("Batch No") },
                { field: "expiry_date", label: __("Expiry Date") },
                { field: "qty", label: __("Available Qty") }
            ]
        );
    }

    // --------------------------------------------------------
    // ADD SELECTED VARIANT
    // IMPORTANT: Do not set the scanned barcode on the row.
    // A template barcode could cause ERPNext to resolve the
    // template again and replace the selected variant.
    // --------------------------------------------------------

    async function addItem(
        frm,
        item,
        warehouse,
        batchNo,
        barcodeUom
    ) {
        const itemCode = String(item.item_code || "").trim();

        // Validate the selected variant, not the original template.
        const master = await validateConcreteItem(itemCode);

        if (
            Number(master.has_batch_no) === 1 &&
            !Number(master.has_serial_no) &&
            !batchNo
        ) {
            throw new Error(
                __("Select a batch for item {0}.", [itemCode])
            );
        }

        const existing = (frm.doc.items || []).find(row =>
            row.item_code === itemCode &&
            (row.warehouse || warehouse) === warehouse &&
            String(row.batch_no || "") === String(batchNo || "")
        );

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

        if (!frm.fields_dict.items?.grid) {
            throw new Error(
                __("Sales Invoice Items table is unavailable.")
            );
        }

        const row = frm.add_child("items");
        let success = false;

        try {
            // Set the selected variant code.
            await frappe.model.set_value(
                row.doctype,
                row.name,
                "item_code",
                master.name
            );

            // Do not set row.barcode here. The scanned code may
            // belong to the template rather than this variant.

            if (hasField(row.doctype, "warehouse")) {
                await frappe.model.set_value(
                    row.doctype,
                    row.name,
                    "warehouse",
                    warehouse
                );
            }

            if (
                barcodeUom &&
                hasField(row.doctype, "uom") &&
                !row.uom
            ) {
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

            // Catch any unexpected template substitution.
            if (row.item_code !== master.name) {
                throw new Error(
                    __(
                        "Variant mismatch: selected {0}, but the row contains {1}.",
                        [master.name, row.item_code || "-"]
                    )
                );
            }

            success = true;
        } finally {
            if (!success) {
                const index = (frm.doc.items || []).findIndex(
                    entry => entry.name === row.name
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

    // --------------------------------------------------------
    // MAIN WORKFLOW
    // --------------------------------------------------------

    async function processBarcode(frm, rawBarcode) {
        if (!supported(frm)) return false;

        const barcode = getBarcodeValue(rawBarcode);
        if (!barcode) return false;

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

        const response = await lookupBarcode(barcode);

        if (!response || response.found !== true) {
            frappe.msgprint({
                title: __("Item Not Found"),
                message: __("No item found for barcode {0}.", [barcode]),
                indicator: "red"
            });
            return false;
        }

        const normalized = normalizeLookup(response);

        // Step 1: If template, choose an actual variant.
        const chosen = normalized.isTemplate
            ? await selectVariant(response)
            : normalized.item;

        if (!chosen) return false;

        const chosenCode = String(chosen.item_code || "").trim();

        if (!chosenCode) {
            throw new Error(
                __("Lookup did not return the selected variant Item Code.")
            );
        }

        // Step 2: Validate the actual selected variant.
        const master = await validateConcreteItem(chosenCode);

        // Step 3: For batch-only Items, select a batch first.
        let batchNo = "";

        if (
            Number(master.has_batch_no) === 1 &&
            !Number(master.has_serial_no)
        ) {
            const batch = await selectBatch(master.name, warehouse);

            if (!batch) return false;

            batchNo = batch.batch_no;
        }

        // Step 4: Add selected variant with selected batch.
        await addItem(
            frm,
            {
                ...chosen,
                item_code: master.name
            },
            warehouse,
            batchNo,
            chosen.barcode_uom || (
                normalized.isTemplate ? "" : response.barcode_uom || ""
            )
        );

        frappe.show_alert({
            message: __("{0} added.", [
                chosen.item_name || master.name
            ]),
            indicator: "green"
        });

        return true;
    }

    // --------------------------------------------------------
    // STANDARD DESK SALES INVOICE SCANNER ONLY
    // --------------------------------------------------------

    function installScannerHook() {
        const prototype =
            window.erpnext?.utils?.BarcodeScanner?.prototype;

        if (
            !prototype ||
            typeof prototype.process_scan !== "function"
        ) {
            return false;
        }

        if (prototype[PATCH_FLAG]) return true;

        const original = prototype.process_scan;

        prototype.process_scan = function (...args) {
            const frm = this.frm || window.cur_frm;

            if (!supported(frm)) {
                return original.apply(this, args);
            }

            if (frm.__styleToneBatchV83Busy) {
                return Promise.resolve();
            }

            const field = this.scan_barcode_field;

            const barcode =
                getBarcodeValue(args[0]) ||
                getBarcodeValue(field?.value) ||
                getBarcodeValue(frm.doc.scan_barcode);

            if (!barcode) {
                return original.apply(this, args);
            }

            frm.__styleToneBatchV83Busy = true;

            if (field?.$input) field.$input.val("");

            if (frm.doc.scan_barcode) {
                frm.doc.scan_barcode = "";

                const scanField = frm.fields_dict?.scan_barcode;

                if (scanField?.$input) {
                    scanField.$input.val("");
                }
            }

            return processBarcode(frm, barcode)
                .catch(error => {
                    showError(error);
                    return false;
                })
                .finally(() => {
                    frm.__styleToneBatchV83Busy = false;
                    frm.refresh_field("items");
                });
        };

        Object.defineProperty(prototype, PATCH_FLAG, {
            value: true,
            configurable: false
        });

        console.info(
            "[STYLETONE] Sales Invoice Batch V8.3 scanner installed."
        );

        return true;
    }

    frappe.ui.form.on("Sales Invoice", {
        refresh() {
            installScannerHook();
        }
    });

    window.StyleToneSalesInvoiceBatch = {
        version: "8.3",
        processBarcode,
        lookupBarcode,
        installScannerHook,
        clearBarcodeCache() {
            lookupCache.clear();
        }
    };

    installScannerHook();
})();
