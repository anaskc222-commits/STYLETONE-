
/* STYLETONE - ERPNext v16 Quotation Barcode / Batch Selector
 *
 * Standard Quotation only.
 * Barcode -> Variant selection -> Batch selection -> Item details -> Add row.
 *
 * Warehouse: Quotation.custom_warehouse
 * Custom batch field: Quotation Item.custom_batch_no
 *
 * Calls ERPNext core get_item_details directly.
 * Does not modify ERPNext core or intentionally change Sales Invoice/POSNext.
 */
(() => {
    "use strict";

    const API = "my_custom_app.quotation_batch";
    const PATCH_FLAG = "__styleToneQuotationBarcodePatchV5";
    const busyForms = new Set();

    function isQuotation(frm) {
        return Boolean(frm && frm.doc && frm.doc.doctype === "Quotation");
    }

    function esc(value) {
        if (frappe.utils && frappe.utils.escape_html) {
            return frappe.utils.escape_html(String(value ?? ""));
        }

        return String(value ?? "").replace(/[&<>"']/g, (char) => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        })[char]);
    }

    function rpc(method, args) {
        return frappe.call({
            method: `${API}.${method}`,
            args: args || {}
        }).then((response) => {
            if (response && response.exc) {
                throw new Error(`Request failed: ${method}`);
            }

            return response ? response.message : null;
        });
    }

    function getWarehouse(frm) {
        return frm.doc.custom_warehouse || "";
    }

    function normalizeScanResult(result) {
        const data = result || {};

        if (Array.isArray(data)) {
            return { variants: data };
        }

        const variants = data.variants ||
            data.items ||
            data.item_variants ||
            [];

        if (Array.isArray(variants) && variants.length) {
            return {
                ...data,
                variants
            };
        }

        const item = data.item && typeof data.item === "object"
            ? data.item
            : data;

        return {
            ...data,
            item_code: item.item_code || data.item_code || "",
            item_name: item.item_name || data.item_name || "",
            has_batch_no: Number(
                item.has_batch_no ?? data.has_batch_no ?? 0
            )
        };
    }

    function chooseVariant(variants) {
        return new Promise((resolve) => {
            const dialog = new frappe.ui.Dialog({
                title: __("Select Item Variant"),
                fields: [{
                    fieldtype: "HTML",
                    fieldname: "variant_list"
                }],
                primary_action_label: __("Cancel"),
                primary_action() {
                    dialog.hide();
                    resolve(null);
                }
            });

            const rows = (variants || []).map((variant, index) => {
                const code = variant.item_code ||
                    variant.name ||
                    variant.value ||
                    "";

                const name = variant.item_name ||
                    variant.description ||
                    "";

                const tracked = Number(
                    variant.has_batch_no ||
                    variant.has_batch ||
                    0
                ) === 1;

                return `
                    <tr>
                        <td>${esc(code)}</td>
                        <td>${esc(name)}</td>
                        <td>${tracked ? __("Yes") : __("No")}</td>
                        <td>
                            <button type="button"
                                class="btn btn-primary btn-xs style-tone-variant"
                                data-index="${index}">
                                ${__("Select")}
                            </button>
                        </td>
                    </tr>`;
            }).join("");

            dialog.fields_dict.variant_list.$wrapper.html(`
                <div style="max-height:55vh;overflow:auto">
                    <table class="table table-bordered">
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

            dialog.$wrapper.on(
                "click",
                ".style-tone-variant",
                function () {
                    const index = Number(this.dataset.index);
                    const selected = variants[index] || null;
                    dialog.hide();
                    resolve(selected);
                }
            );

            dialog.onhide = () => resolve(null);
            dialog.show();
        });
    }

    function chooseBatch(batches) {
        return new Promise((resolve) => {
            if (!Array.isArray(batches) || !batches.length) {
                resolve(null);
                return;
            }

            let completed = false;

            const finish = (value) => {
                if (completed) return;
                completed = true;
                dialog.hide();
                resolve(value);
            };

            const rows = batches.map((batch, index) => `
                <tr>
                    <td>${esc(batch.name || batch.batch_no || "")}</td>
                    <td>${esc(batch.expiry_date || __("Not set"))}</td>
                    <td style="text-align:right">
                        ${esc(batch.available_qty ?? batch.qty ?? 0)}
                    </td>
                    <td>
                        <button type="button"
                            class="btn btn-primary btn-xs style-tone-batch"
                            data-index="${index}">
                            ${__("Select")}
                        </button>
                    </td>
                </tr>
            `).join("");

            const dialog = new frappe.ui.Dialog({
                title: __("Select Batch"),
                fields: [{
                    fieldtype: "HTML",
                    fieldname: "batch_list"
                }],
                primary_action_label: __("Cancel"),
                primary_action() {
                    finish(null);
                }
            });

            dialog.fields_dict.batch_list.$wrapper.html(`
                <div style="max-height:55vh;overflow:auto">
                    <table class="table table-bordered">
                        <thead>
                            <tr>
                                <th>${__("Batch No")}</th>
                                <th>${__("Expiry Date")}</th>
                                <th style="text-align:right">
                                    ${__("Available Qty")}
                                </th>
                                <th>${__("Action")}</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            `);

            dialog.$wrapper.on(
                "click",
                ".style-tone-batch",
                function () {
                    const batch = batches[Number(this.dataset.index)];
                    finish(batch ? (batch.name || batch.batch_no) : null);
                }
            );

            dialog.onhide = () => {
                if (!completed) {
                    completed = true;
                    resolve(null);
                }
            };

            dialog.show();
        });
    }

    function getItemMeta() {
        return frappe.get_meta("Quotation Item");
    }

    function hasItemField(fieldname) {
        return Boolean(getItemMeta().fields.find(
            (field) => field.fieldname === fieldname
        ));
    }

    function getReusableRow(frm, itemCode, batchNo) {
        const items = frm.doc.items || [];

        // Same item + same batch: reuse the existing row.
        const existing = items.find((row) =>
            row.item_code === itemCode &&
            (row.batch_no || row.custom_batch_no || "") ===
                (batchNo || "")
        );

        if (existing) {
            return { row: existing, existing: true };
        }

        // Reuse an empty row before adding a new one.
        const blank = items.find((row) =>
            !row.item_code &&
            !row.custom_batch_no &&
            !row.batch_no
        );

        if (blank) {
            return { row: blank, existing: false };
        }

        return {
            row: frm.add_child("items"),
            existing: false
        };
    }

    function buildItemContext(frm, itemCode, warehouse, batchNo, row) {
        const doc = frm.doc;

        return {
            item_code: itemCode,
            batch_no: batchNo || "",
            warehouse: warehouse || "",
            company: doc.company || "",
            customer: doc.party_name || doc.customer || "",
            doctype: "Quotation",
            name: doc.name || "",
            child_doctype: "Quotation Item",
            child_docname: row.name || "",
            idx: row.idx || 1,
            transaction_date: doc.transaction_date || frappe.datetime.get_today(),
            selling_price_list: doc.selling_price_list || "",
            price_list_currency: doc.price_list_currency || doc.currency || "",
            plc_conversion_rate: doc.plc_conversion_rate || 1,
            currency: doc.currency || "",
            conversion_rate: doc.conversion_rate || 1,
            price_list: doc.selling_price_list || "",
            qty: 1,
            uom: row.uom || "",
            stock_uom: row.stock_uom || "",
            conversion_factor: row.conversion_factor || 1,
            ignore_pricing_rule: doc.ignore_pricing_rule || 0,
            is_return: 0
        };
    }

    async function fetchCoreItemDetails(frm, itemCode, warehouse, batchNo, row) {
        const ctx = buildItemContext(
            frm,
            itemCode,
            warehouse,
            batchNo,
            row
        );

        // ERPNext v16 core endpoint.
        // Pass batch_no BEFORE requesting item details.
        const response = await frappe.call({
            method: "erpnext.stock.get_item_details.get_item_details",
            args: {
                ctx,
                doc: frm.doc
            }
        });

        if (!response || response.exc || !response.message) {
            throw new Error(__("ERPNext could not load item details."));
        }

        return response.message;
    }

    async function applyItemDetails(frm, row, itemCode, batchNo, warehouse, details) {
        const cdt = row.doctype;
        const cdn = row.name;

        // Assign item_code directly to avoid firing a second item_code
        // handler that would request item details again without the batch.
        row.item_code = itemCode;

        const excluded = new Set([
            "doctype",
            "name",
            "parent",
            "parenttype",
            "parentfield",
            "idx",
            "item_code",
            "batch_no",
            "custom_batch_no"
        ]);

        // Populate only fields that exist on Quotation Item.
        // set_value allows normal dependent field handlers to run.
        for (const [fieldname, value] of Object.entries(details || {})) {
            if (
                excluded.has(fieldname) ||
                value === undefined ||
                value === null ||
                !hasItemField(fieldname)
            ) {
                continue;
            }

            await frappe.model.set_value(cdt, cdn, fieldname, value);
        }

        row.item_code = itemCode;
        row.warehouse = warehouse || row.warehouse || "";

        if (hasItemField("batch_no")) {
            row.batch_no = batchNo || "";
        }

        if (hasItemField("custom_batch_no")) {
            row.custom_batch_no = batchNo || "";
        }

        if (!row.qty || Number(row.qty) <= 0) {
            row.qty = 1;
        }

        frm.refresh_field("items");
        frm.dirty();
    }

    async function addSelectedItem(frm, itemCode, hasBatch, batchNo) {
        const warehouse = getWarehouse(frm);

        if (!warehouse) {
            frappe.msgprint({
                title: __("Warehouse Required"),
                message: __("Select the Quotation Warehouse before scanning items."),
                indicator: "orange"
            });
            return;
        }

        const match = getReusableRow(frm, itemCode, batchNo);
        const row = match.row;

        if (match.existing) {
            await frappe.model.set_value(
                row.doctype,
                row.name,
                "qty",
                (Number(row.qty) || 0) + 1
            );

            frm.refresh_field("items");
            frm.dirty();
            return;
        }

        try {
            const details = await fetchCoreItemDetails(
                frm,
                itemCode,
                warehouse,
                batchNo,
                row
            );

            await applyItemDetails(
                frm,
                row,
                itemCode,
                batchNo,
                warehouse,
                details
            );
        } catch (error) {
            // Remove the empty row created for this failed request.
            if (!row.item_code) {
                frm.doc.items = (frm.doc.items || []).filter(
                    (item) => item.name !== row.name
                );
                frm.refresh_field("items");
            }

            console.error("STYLETONE Quotation item details error:", error);

            frappe.msgprint({
                title: __("Item Details Error"),
                message: esc(error.message || __("Unable to add item.")),
                indicator: "red"
            });
        }
    }

    async function processBarcode(frm, barcode) {
        if (!isQuotation(frm)) return;

        barcode = String(
            barcode || frm.doc.scan_barcode || ""
        ).trim();

        if (!barcode) return;

        if (busyForms.has(frm)) return;
        busyForms.add(frm);

        try {
            const warehouse = getWarehouse(frm);

            if (!warehouse) {
                frappe.msgprint({
                    title: __("Warehouse Required"),
                    message: __("Select the Quotation Warehouse before scanning items."),
                    indicator: "orange"
                });
                return;
            }

            const raw = await rpc("scan_barcode_with_variants", {
                search_value: barcode
            });

            const result = normalizeScanResult(raw);
            let selected = result;

            const variants = result.variants || [];

            if (variants.length > 1 || result.is_template) {
                selected = await chooseVariant(variants);
                if (!selected) return;
            }

            const itemCode = selected.item_code ||
                selected.name ||
                selected.value;

            if (!itemCode) {
                frappe.msgprint(__("No item was found for barcode {0}.", [barcode]));
                return;
            }

            const hasBatch = Number(
                selected.has_batch_no ??
                selected.has_batch ??
                result.has_batch_no ??
                0
            ) === 1;

            let batchNo = "";

            if (hasBatch) {
                const batches = await rpc("get_available_batches", {
                    item_code: itemCode,
                    warehouse
                });

                if (!Array.isArray(batches) || !batches.length) {
                    frappe.msgprint({
                        title: __("No Available Batch"),
                        message: __(
                            "No positive-quantity batch is available for item {0} in warehouse {1}.",
                            [itemCode, warehouse]
                        ),
                        indicator: "orange"
                    });
                    return;
                }

                batchNo = await chooseBatch(batches);
                if (!batchNo) return;
            }

            await addSelectedItem(
                frm,
                itemCode,
                hasBatch,
                batchNo
            );

            if (frm.fields_dict.scan_barcode) {
                await frm.set_value("scan_barcode", "");
            }
        } catch (error) {
            console.error("STYLETONE Quotation barcode error:", error);

            frappe.msgprint({
                title: __("Barcode Processing Failed"),
                message: esc(error.message || __("Unable to process barcode.")),
                indicator: "red"
            });
        } finally {
            busyForms.delete(frm);
        }
    }

    function installScannerPatch() {
        const prototype = window.erpnext?.utils?.BarcodeScanner?.prototype;

        if (!prototype || typeof prototype.process_scan !== "function") {
            return;
        }

        if (prototype[PATCH_FLAG]) return;

        const originalProcessScan = prototype.process_scan;

        prototype.process_scan = function (barcode, ...rest) {
            const frm = this.frm || this.cur_frm || this.form;

            // Keep every non-Quotation scan on the original ERPNext path.
            if (!isQuotation(frm)) {
                return originalProcessScan.call(this, barcode, ...rest);
            }

            const value = typeof barcode === "string"
                ? barcode
                : (
                    barcode?.barcode ||
                    barcode?.value ||
                    frm.doc.scan_barcode ||
                    ""
                );

            return processBarcode(frm, value);
        };

        prototype[PATCH_FLAG] = true;
    }

    frappe.ui.form.on("Quotation", {
        refresh(frm) {
            installScannerPatch();
        },

        scan_barcode(frm) {
            // Fallback for deployments where scan_barcode is entered directly.
            const barcode = frm.doc.scan_barcode;
            if (barcode && !busyForms.has(frm)) {
                processBarcode(frm, barcode);
            }
        }
    });

    // The scanner class may load after this custom script.
    // Refreshing the Quotation installs the patch again if needed.
    installScannerPatch();
})();
