
(() => {
    "use strict";

    const FLAG = "__styleToneSalesInvoiceBatchV82";
    const PATCH_FLAG = "__styleToneBatchV82Installed";

    if (window[FLAG]) return;
    window[FLAG] = true;

    const LOOKUP_METHOD =
        "my_custom_app.sales_invoice_batch.scan_barcode_with_variants";

    const BATCH_METHOD =
        "my_custom_app.sales_invoice_batch.get_available_batches";

    const lookupCache = new Map();
    const MAX_CACHE_SIZE = 100;

    // --------------------------------------------------------
    // HELPERS
    // --------------------------------------------------------

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

    function positiveQty(value) {
        const qty = Number(value || 0);
        return Number.isFinite(qty) && qty > 0;
    }

    function hasField(doctype, fieldname) {
        return Boolean(frappe.meta.has_field(doctype, fieldname));
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
        console.error("[STYLETONE Sales Invoice V8.2]", error);

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
    // BARCODE LOOKUP CACHE
    // Cache item lookup only, never batch quantities.
    // --------------------------------------------------------

    async function lookupBarcode(barcode) {
        const key = String(barcode || "").trim();

        if (!key) {
            return { found: false };
        }

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
                const oldest = lookupCache.keys().next().value;
                lookupCache.delete(oldest);
            }

            lookupCache.set(key, lookup);
        }

        return lookup;
    }

    // --------------------------------------------------------
    // NORMALIZE RESPONSE
    // ERPNext Item field: has_variants.
    // --------------------------------------------------------

    function normalizeLookup(response) {
        const item = response?.item || response;

        return {
            isTemplate: (
                Number(response?.has_variants) === 1 ||
                Number(item?.has_variants) === 1
            ),

            variants:
                response?.variants ||
                item?.variants ||
                [],

            item
        };
    }

    // --------------------------------------------------------
    // TABLE SELECTOR
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
                                class="btn btn-primary btn-xs st-v82-select"
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
                "click.styleToneV82",
                ".st-v82-select",
                function () {
                    const index = Number(
                        this.getAttribute("data-index")
                    );

                    finish(rows[index] || null);
                }
            );

            dialog.$wrapper.on(
                "hidden.bs.modal.styleToneV82",
                () => {
                    finish(null);
                    dialog.$wrapper.off(".styleToneV82");
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
                    "The barcode matched an item template, but no variants were returned by the Python lookup method."
                ),
                indicator: "orange"
            });

            return null;
        }

        return selectFromTable(
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
                }
            ]
        );
    }

    // --------------------------------------------------------
    // ITEM MASTER VALIDATION
    // --------------------------------------------------------

    async function validateConcreteItem(itemCode) {
        if (!itemCode) {
            throw new Error(
                __("Selected item has no Item Code.")
            );
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
                __(
                    "Item {0} is a template. Select one of its variants.",
                    [itemCode]
                )
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
                positiveQty(batch.qty ?? batch.available_qty)
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
                {
                    field: "batch_no",
                    label: __("Batch No")
                },
                {
                    field: "expiry_date",
                    label: __("Expiry Date")
                },
                {
                    field: "qty",
                    label: __("Available Qty")
                }
            ]
        );
    }

    // --------------------------------------------------------
    // ADD ITEM
    // --------------------------------------------------------

    async function addItem(
        frm,
        item,
        warehouse,
        batchNo,
        barcode,
        barcodeUom
    ) {
        const itemCode = item.item_code;
        const master = await validateConcreteItem(itemCode);

        if (
            Number(master.has_batch_no) === 1 &&
            !batchNo &&
            !Number(master.has_serial_no)
        ) {
            throw new Error(
                __(
                    "Select a batch before adding batch-tracked item {0}.",
                    [itemCode]
                )
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
            // Let ERPNext run its standard item_code handler.
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

            if (row.item_code !== itemCode) {
                throw new Error(
                    __(
                        "Unexpected item after ERPNext processing. Expected {0}, received {1}.",
                        [itemCode, row.item_code || "-"]
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
    // MAIN BARCODE WORKFLOW
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
                message: __(
                    "No item found for barcode {0}.",
                    [barcode]
                ),
                indicator: "red"
            });

            return false;
        }

        const normalized = normalizeLookup(response);
        let chosen;

        if (normalized.isTemplate) {
            chosen = await selectVariant(response);
            if (!chosen) return false;
        } else {
            chosen = normalized.item;
        }

        if (!chosen?.item_code) {
            throw new Error(
                __("Barcode lookup did not return a valid Item Code.")
            );
        }

        const master = await validateConcreteItem(chosen.item_code);
        let batchNo = "";

        if (
            Number(master.has_batch_no) === 1 &&
            !Number(master.has_serial_no)
        ) {
            const batch = await selectBatch(
                master.name,
                warehouse
            );

            if (!batch) return false;
            batchNo = batch.batch_no;
        }

        await addItem(
            frm,
            {
                ...chosen,
                item_code: master.name
            },
            warehouse,
            batchNo,
            barcode,
            chosen.barcode_uom || response.barcode_uom || ""
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
    // SCANNER PATCH — STANDARD SALES INVOICE ONLY
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

        if (prototype[PATCH_FLAG]) {
            return true;
        }

        const original = prototype.process_scan;

        prototype.process_scan = function (...args) {
            const frm = this.frm || window.cur_frm;

            if (!supported(frm)) {
                return original.apply(this, args);
            }

            if (frm.__styleToneBatchV82Busy) {
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

            frm.__styleToneBatchV82Busy = true;

            if (field?.$input) {
                field.$input.val("");
            }

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
                    frm.__styleToneBatchV82Busy = false;
                    frm.refresh_field("items");
                });
        };

        Object.defineProperty(prototype, PATCH_FLAG, {
            value: true,
            configurable: false
        });

        console.info(
            "[STYLETONE] Sales Invoice Batch V8.2 scanner installed."
        );

        return true;
    }

    frappe.ui.form.on("Sales Invoice", {
        refresh() {
            installScannerHook();
        }
    });

    window.StyleToneSalesInvoiceBatch = {
        version: "8.2",
        processBarcode,
        lookupBarcode,
        installScannerHook,
        clearBarcodeCache() {
            lookupCache.clear();
        }
    };

    installScannerHook();

})();
