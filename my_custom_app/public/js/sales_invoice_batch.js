
(() => {
    "use strict";

    const VERSION = "8.5";
    const FLAG = "__styleToneSalesInvoiceBatchV85";
    const PATCH_FLAG = "__styleToneBatchV85Installed";

    if (window[FLAG]) return;
    window[FLAG] = true;

    const LOOKUP_METHOD =
        "my_custom_app.sales_invoice_batch.scan_barcode_with_variants";

    const BATCH_METHOD =
        "my_custom_app.sales_invoice_batch.get_available_batches";

    // Cache successful barcode lookups only.
    // Batch availability is always fetched live.
    const lookupCache = new Map();
    const MAX_CACHE = 100;

    function supported(frm) {
        return Boolean(
            frm &&
            frm.doc &&
            frm.doctype === "Sales Invoice" &&
            !Number(frm.doc.is_pos || 0) &&
            !frm.doc.pos_profile
        );
    }

    function text(value) {
        return String(value ?? "").trim();
    }

    function esc(value) {
        return frappe.utils.escape_html(String(value ?? ""));
    }

    function getWarehouse(frm) {
        return text(
            frm.doc.source_warehouse ||
            frm.doc.set_warehouse
        );
    }

    function getBarcode(value) {
        if (typeof value === "string") return value.trim();

        if (value && typeof value === "object") {
            return text(
                value.barcode ||
                value.value ||
                value.text ||
                value.decodedText
            );
        }

        return "";
    }

    function hasField(doctype, fieldname) {
        return Boolean(frappe.meta.has_field(doctype, fieldname));
    }

    function call(method, args) {
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

    function reportError(error) {
        console.error(`[STYLETONE Batch ${VERSION}]`, error);

        frappe.msgprint({
            title: __("Barcode / Batch Processing Failed"),
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
        barcode = text(barcode);
        if (!barcode) return { found: false };

        if (lookupCache.has(barcode)) {
            const cached = lookupCache.get(barcode);

            // Refresh LRU position.
            lookupCache.delete(barcode);
            lookupCache.set(barcode, cached);

            return cached;
        }

        const result = await call(LOOKUP_METHOD, { barcode });
        const response = result || { found: false };

        if (response.found === true) {
            if (lookupCache.size >= MAX_CACHE) {
                lookupCache.delete(
                    lookupCache.keys().next().value
                );
            }

            lookupCache.set(barcode, response);
        }

        return response;
    }

    function normalize(response) {
        const item = response?.item || response;

        return {
            item,
            isTemplate:
                Number(response?.has_variants) === 1 ||
                Number(item?.has_variants) === 1,
            variants:
                response?.variants ||
                item?.variants ||
                []
        };
    }

    // --------------------------------------------------------
    // SELECTOR TABLE
    // --------------------------------------------------------

    function selectTable(title, rows, columns) {
        return new Promise(resolve => {
            if (!Array.isArray(rows) || !rows.length) {
                resolve(null);
                return;
            }

            let settled = false;

            const dialog = new frappe.ui.Dialog({
                title: __(title),
                size: "large",
                fields: [{
                    fieldtype: "HTML",
                    fieldname: "selection_table"
                }]
            });

            function finish(value) {
                if (settled) return;

                settled = true;
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
                                class="btn btn-primary btn-xs st-v85-select"
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
                     style="max-height:55vh;overflow:auto">
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
                "click.styleToneV85",
                ".st-v85-select",
                function () {
                    const index = Number(
                        this.getAttribute("data-index")
                    );

                    finish(rows[index] || null);
                }
            );

            dialog.$wrapper.on(
                "hidden.bs.modal.styleToneV85",
                () => {
                    finish(null);
                    dialog.$wrapper.off(".styleToneV85");
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
    // VARIANT SELECTION
    // --------------------------------------------------------

    async function chooseVariant(response) {
        const data = normalize(response);

        if (!data.variants.length) {
            frappe.msgprint({
                title: __("No Variants Found"),
                message: __(
                    "The template barcode returned no selectable variants."
                ),
                indicator: "orange"
            });

            return null;
        }

        return selectTable(
            __("Select Item Variant"),
            data.variants,
            [
                { field: "item_code", label: __("Item Code") },
                { field: "item_name", label: __("Item Name") },
                { field: "has_batch_no", label: __("Batch Tracked") }
            ]
        );
    }

    // --------------------------------------------------------
    // VALIDATE A CONCRETE ITEM
    // --------------------------------------------------------

    async function getConcreteItem(itemCode) {
        itemCode = text(itemCode);

        if (!itemCode) {
            throw new Error(__("No Item Code was selected."));
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

        const item = response?.message;

        if (!item?.name) {
            throw new Error(
                __("Item {0} does not exist.", [itemCode])
            );
        }

        if (Number(item.disabled) === 1) {
            throw new Error(
                __("Item {0} is disabled.", [itemCode])
            );
        }

        if (
            Number(item.has_variants) === 1 &&
            !item.variant_of
        ) {
            throw new Error(
                __("Item {0} is a template. Select a variant.", [
                    itemCode
                ])
            );
        }

        return item;
    }

    // --------------------------------------------------------
    // BATCH SELECTION
    // --------------------------------------------------------

    async function chooseBatch(itemCode, warehouse) {
        const result = await call(BATCH_METHOD, {
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

        return selectTable(
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
    // FIND MATCHING OR BLANK ROW
    // --------------------------------------------------------

    function findMatchingRow(frm, itemCode, warehouse, batchNo) {
        return (frm.doc.items || []).find(row =>
            row.item_code === itemCode &&
            (row.warehouse || warehouse) === warehouse &&
            text(row.batch_no) === text(batchNo)
        );
    }

    function findFirstBlankRow(frm) {
        return (frm.doc.items || []).find(row =>
            !row.item_code &&
            !row.item_name &&
            !row.batch_no
        );
    }

    // --------------------------------------------------------
    // ADD SCANNED ITEM
    // Reuse the first blank row before creating another row.
    // --------------------------------------------------------

    async function addSelectedItem(
        frm,
        item,
        warehouse,
        batchNo,
        barcodeUom
    ) {
        const itemCode = text(item.item_code);
        const master = await getConcreteItem(itemCode);

        if (
            Number(master.has_batch_no) === 1 &&
            !Number(master.has_serial_no) &&
            !batchNo
        ) {
            throw new Error(
                __("Select a batch for item {0}.", [master.name])
            );
        }

        const existing = findMatchingRow(
            frm,
            master.name,
            warehouse,
            batchNo
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

        const blankRow = findFirstBlankRow(frm);
        const row = blankRow || frm.add_child("items");
        const reusedBlank = Boolean(blankRow);

        let success = false;

        try {
            await frappe.model.set_value(
                row.doctype,
                row.name,
                "item_code",
                master.name
            );

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

            if (row.item_code !== master.name) {
                throw new Error(
                    __(
                        "Selected variant {0} changed to {1}.",
                        [master.name, row.item_code || "-"]
                    )
                );
            }

            success = true;
        } finally {
            if (!success) {
                if (reusedBlank) {
                    try {
                        await frappe.model.set_value(
                            row.doctype,
                            row.name,
                            "item_code",
                            ""
                        );

                        await frappe.model.set_value(
                            row.doctype,
                            row.name,
                            "batch_no",
                            ""
                        );

                        await frappe.model.set_value(
                            row.doctype,
                            row.name,
                            "qty",
                            0
                        );
                    } catch (cleanupError) {
                        console.warn(
                            "[STYLETONE] Blank row cleanup failed",
                            cleanupError
                        );
                    }
                } else {
                    const index = (
                        frm.doc.items || []
                    ).findIndex(entry => entry.name === row.name);

                    if (index >= 0) {
                        frm.doc.items.splice(index, 1);
                    }
                }

                frm.refresh_field("items");
            }
        }

        frm.refresh_field("items");
        frm.dirty();

        return row;
    }

    // --------------------------------------------------------
    // MAIN BARCODE FLOW
    // --------------------------------------------------------

    async function processBarcode(frm, rawBarcode) {
        if (!supported(frm)) return false;

        const barcode = getBarcode(rawBarcode);
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

        const data = normalize(response);

        const chosen = data.isTemplate
            ? await chooseVariant(response)
            : data.item;

        if (!chosen) return false;

        if (!text(chosen.item_code)) {
            throw new Error(
                __("The selected item has no Item Code.")
            );
        }

        const master = await getConcreteItem(chosen.item_code);

        let batchNo = "";

        if (
            Number(master.has_batch_no) === 1 &&
            !Number(master.has_serial_no)
        ) {
            const selectedBatch = await chooseBatch(
                master.name,
                warehouse
            );

            if (!selectedBatch) return false;

            batchNo = selectedBatch.batch_no;
        }

        const barcodeUom = data.isTemplate
            ? ""
            : (chosen.barcode_uom || response.barcode_uom || "");

        await addSelectedItem(
            frm,
            {
                ...chosen,
                item_code: master.name
            },
            warehouse,
            batchNo,
            barcodeUom
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
    // MANUAL ITEM SELECTION — SALES INVOICE
    // --------------------------------------------------------

    async function handleManualSalesInvoiceItem(frm, cdt, cdn) {
        if (
            !supported(frm) ||
            frm.__styleToneBatchV85Busy
        ) {
            return;
        }

        const row = locals[cdt]?.[cdn];
        if (!row?.item_code) return;

        const itemCode = text(row.item_code);

        if (
            row.__styleToneManualBatchBusy ||
            row.__styleToneBatchHandledFor === itemCode
        ) {
            return;
        }

        row.__styleToneManualBatchBusy = true;

        try {
            // Allow ERPNext's normal item-details handler to start.
            await new Promise(resolve => setTimeout(resolve, 350));

            if (
                !supported(frm) ||
                frm.__styleToneBatchV85Busy ||
                text(row.item_code) !== itemCode
            ) {
                return;
            }

            const item = await getConcreteItem(itemCode);

            // No popup for non-batch or serial-and-batch items.
            if (
                Number(item.has_batch_no) !== 1 ||
                Number(item.has_serial_no) === 1
            ) {
                row.__styleToneBatchHandledFor = itemCode;
                return;
            }

            // Do not reopen a batch picker if ERPNext already set it.
            if (text(row.batch_no)) {
                row.__styleToneBatchHandledFor = itemCode;
                return;
            }

            const warehouse = text(
                row.warehouse || getWarehouse(frm)
            );

            if (!warehouse) {
                frappe.msgprint({
                    title: __("Warehouse Required"),
                    message: __(
                        "Select Source Warehouse or Set Warehouse before selecting a batch."
                    ),
                    indicator: "orange"
                });

                return;
            }

            const selectedBatch = await chooseBatch(
                itemCode,
                warehouse
            );

            if (!selectedBatch?.batch_no) {
                // Cancelled: leave the item row unchanged.
                return;
            }

            // Prevent assigning a batch to a changed item.
            if (text(row.item_code) !== itemCode) {
                return;
            }

            await frappe.model.set_value(
                cdt,
                cdn,
                "batch_no",
                selectedBatch.batch_no
            );

            row.__styleToneBatchHandledFor = itemCode;

            frm.refresh_field("items");
            frm.dirty();

        } catch (error) {
            reportError(error);
        } finally {
            row.__styleToneManualBatchBusy = false;
        }
    }

    frappe.ui.form.on("Sales Invoice Item", {
        item_code(frm, cdt, cdn) {
            handleManualSalesInvoiceItem(frm, cdt, cdn);
        }
    });

    // --------------------------------------------------------
    // BARCODE SCANNER INTEGRATION
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

            if (frm.__styleToneBatchV85Busy) {
                return Promise.resolve();
            }

            const field = this.scan_barcode_field;

            const barcode =
                getBarcode(args[0]) ||
                getBarcode(field?.value) ||
                getBarcode(frm.doc.scan_barcode);

            if (!barcode) {
                return original.apply(this, args);
            }

            frm.__styleToneBatchV85Busy = true;

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
                    reportError(error);
                    return false;
                })
                .finally(() => {
                    frm.__styleToneBatchV85Busy = false;
                    frm.refresh_field("items");
                });
        };

        Object.defineProperty(prototype, PATCH_FLAG, {
            value: true,
            configurable: false
        });

        console.info(
            `[STYLETONE] Sales Invoice Batch V${VERSION} installed.`
        );

        return true;
    }

    frappe.ui.form.on("Sales Invoice", {
        refresh() {
            installScannerHook();
        }
    });

    window.StyleToneSalesInvoiceBatch = {
        version: VERSION,
        processBarcode,
        lookupBarcode,
        installScannerHook,
        clearBarcodeCache() {
            lookupCache.clear();
        }
    };

    installScannerHook();
})();
