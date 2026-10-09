/* STYLETONE - ERPNext v16 Quotation Barcode / Batch Selector
 *
 * Flow:
 * Barcode -> Variant -> Batch -> ERPNext item details -> Add row
 *
 * Batch is passed to Python before item_code is written to the row.
 * Common warehouse: Quotation.custom_warehouse
 * Batch field: Quotation Item.custom_batch_no
 */

(() => {
    "use strict";

    const API = "my_custom_app.quotation_batch";
    const PATCH_FLAG = "__styleToneQuotationBarcodePatchV4";
    const busyForms = new Set();

    function supported(frm) {
        return Boolean(frm && frm.doc && frm.doc.doctype === "Quotation");
    }

    function esc(value) {
        return frappe.utils.escape_html(String(value ?? ""));
    }

    function show_error(error) {
        console.error("StyleTone Quotation barcode error:", error);

        frappe.msgprint({
            title: "Quotation Barcode / Batch Error",
            indicator: "red",
            message: esc(
                error?.message ||
                error?.exc ||
                "Barcode processing failed."
            )
        });
    }

    function get_warehouse(frm) {
        return String(frm.doc.custom_warehouse || "").trim();
    }

    function call(method, args) {
        return frappe.call({
            method: `${API}.${method}`,
            args
        }).then((response) => {
            if (response.exc) {
                throw new Error(
                    `Server error while running ${method}. Check Error Log.`
                );
            }

            if (response.message === undefined) {
                throw new Error(`No result returned by ${method}.`);
            }

            return response.message;
        });
    }

    function make_dialog(title, fieldname, html) {
        const dialog = new frappe.ui.Dialog({
            title,
            size: "large",
            fields: [{ fieldname, fieldtype: "HTML" }]
        });

        dialog.fields_dict[fieldname].$wrapper.html(html);
        return dialog;
    }

    function select_variant(variants) {
        return new Promise((resolve) => {
            if (!Array.isArray(variants) || !variants.length) {
                frappe.msgprint("No enabled variants are available.");
                resolve(null);
                return;
            }

            let finished = false;
            let dialog;

            function finish(value) {
                if (finished) return;
                finished = true;
                resolve(value);
            }

            const rows = variants.map((variant, index) => `
                <tr>
                    <td>${index + 1}</td>
                    <td><strong>${esc(variant.item_code)}</strong></td>
                    <td>${esc(variant.item_name || "")}</td>
                    <td>${variant.has_batch_no ? "Yes" : "No"}</td>
                    <td>${esc(variant.stock_uom || "")}</td>
                    <td>
                        <button type="button"
                            class="btn btn-primary btn-xs st-q-variant"
                            data-index="${index}">
                            Select
                        </button>
                    </td>
                </tr>
            `).join("");

            dialog = make_dialog(
                "Select Item Variant",
                "variant_table",
                `
                    <div class="table-responsive">
                        <table class="table table-bordered table-hover">
                            <thead>
                                <tr>
                                    <th>#</th>
                                    <th>Item Code</th>
                                    <th>Item Name</th>
                                    <th>Batch Tracked</th>
                                    <th>Stock UOM</th>
                                    <th>Action</th>
                                </tr>
                            </thead>
                            <tbody>${rows}</tbody>
                        </table>
                    </div>
                `
            );

            dialog.$wrapper.on(
                "click.stQuotationVariant",
                ".st-q-variant",
                function () {
                    const index = Number($(this).attr("data-index"));
                    const selected = variants[index];

                    if (!selected?.item_code) {
                        frappe.msgprint("Please select a valid variant.");
                        return;
                    }

                    finish(selected);
                    dialog.hide();
                }
            );

            dialog.$wrapper.on(
                "hidden.bs.modal.stQuotationVariant",
                () => {
                    finish(null);
                    dialog.$wrapper.off(".stQuotationVariant");
                }
            );

            dialog.show();
        });
    }

    function select_batch(item_code, warehouse) {
        return new Promise((resolve, reject) => {
            let finished = false;
            let dialog;

            function finish(value) {
                if (finished) return;
                finished = true;
                resolve(value);
            }

            call("get_available_batches", {
                item_code,
                warehouse
            }).then((batches) => {
                if (!Array.isArray(batches) || !batches.length) {
                    finish(null);

                    frappe.msgprint({
                        title: "No Available Batch",
                        indicator: "orange",
                        message:
                            `No positive-quantity batch was found for ` +
                            `<b>${esc(item_code)}</b> in warehouse ` +
                            `<b>${esc(warehouse)}</b>.`
                    });
                    return;
                }

                const rows = batches.map((batch, index) => `
                    <tr>
                        <td>${index + 1}</td>
                        <td><strong>${esc(batch.name)}</strong></td>
                        <td>${esc(batch.expiry_date || "Not set")}</td>
                        <td>${esc(batch.available_qty ?? "")}</td>
                        <td>
                            <button type="button"
                                class="btn btn-primary btn-xs st-q-batch"
                                data-index="${index}">
                                Select
                            </button>
                        </td>
                    </tr>
                `).join("");

                dialog = make_dialog(
                    `Select Batch — ${item_code}`,
                    "batch_table",
                    `
                        <p><b>Warehouse:</b> ${esc(warehouse)}</p>
                        <div class="table-responsive">
                            <table class="table table-bordered table-hover">
                                <thead>
                                    <tr>
                                        <th>#</th>
                                        <th>Batch No.</th>
                                        <th>Expiry Date</th>
                                        <th>Available Qty</th>
                                        <th>Action</th>
                                    </tr>
                                </thead>
                                <tbody>${rows}</tbody>
                            </table>
                        </div>
                    `
                );

                dialog.$wrapper.on(
                    "click.stQuotationBatch",
                    ".st-q-batch",
                    function () {
                        const index = Number($(this).attr("data-index"));
                        const selected = batches[index];

                        if (!selected?.name) {
                            frappe.msgprint("Please select a valid batch.");
                            return;
                        }

                        finish(selected.name);
                        dialog.hide();
                    }
                );

                dialog.$wrapper.on(
                    "hidden.bs.modal.stQuotationBatch",
                    () => {
                        finish(null);
                        dialog.$wrapper.off(".stQuotationBatch");
                    }
                );

                dialog.show();
            }).catch(reject);
        });
    }

    async function add_item(frm, item, warehouse, batch_no) {
        const item_code = item.item_code || item.name;

        if (!item_code) {
            throw new Error("The selected item has no item code.");
        }

        if (item.disabled) {
            throw new Error(`Item ${item_code} is disabled.`);
        }

        if (item.has_variants && !item.variant_of) {
            throw new Error(`Select a concrete variant for ${item_code}.`);
        }

        if (item.has_serial_no) {
            throw new Error(
                "Serial-number-tracked items are not supported by this selector."
            );
        }

        if (item.has_batch_no && !batch_no) {
            throw new Error(`A batch must be selected for ${item_code}.`);
        }

        if (!frappe.meta.has_field("Quotation Item", "custom_batch_no")) {
            throw new Error(
                "Quotation Item.custom_batch_no is missing. " +
                "Create this Custom Field before scanning."
            );
        }

        const has_row_warehouse = frappe.meta.has_field(
            "Quotation Item",
            "warehouse"
        );

        // Same item + same batch: increase quantity, do not add a duplicate.
        const existing = (frm.doc.items || []).find((row) =>
            row.item_code === item_code &&
            (row.custom_batch_no || "") === (batch_no || "")
        );

        if (existing) {
            await frappe.model.set_value(
                existing.doctype,
                existing.name,
                "qty",
                flt(existing.qty || 0) + 1
            );

            if (has_row_warehouse && warehouse) {
                await frappe.model.set_value(
                    existing.doctype,
                    existing.name,
                    "warehouse",
                    warehouse
                );
            }

            frm.refresh_field("items");

            frappe.show_alert({
                message: `Quantity increased: ${item_code}`,
                indicator: "green"
            });

            return;
        }

        const doc = frm.doc;
        const price_list = doc.selling_price_list || "";

        // Crucial: selected batch is sent BEFORE writing item_code to the row.
        const item_args = {
            doctype: "Quotation",
            item_code,
            batch_no: batch_no || "",
            warehouse,
            company: doc.company,
            customer: doc.party_name || doc.customer || "",
            quotation_to: doc.quotation_to || "Customer",
            party_name: doc.party_name || doc.customer || "",
            selling_price_list: price_list,
            price_list: price_list,
            price_list_currency: doc.price_list_currency || "",
            currency: doc.currency || "",
            conversion_rate: flt(doc.conversion_rate) || 1,
            plc_conversion_rate: flt(doc.plc_conversion_rate) || 1,
            transaction_date: doc.transaction_date || frappe.datetime.get_today(),
            qty: 1,
            uom: item.barcode_uom || item.stock_uom || "",
            stock_uom: item.stock_uom || "",
            project: doc.project || "",
            ignore_pricing_rule: 0
        };

        const response = await call("get_quotation_item_details", {
            item_code,
            batch_no: batch_no || "",
            warehouse,
            args: JSON.stringify(item_args),
            doc: JSON.stringify(doc)
        });

        const details = response?.details || response;

        if (!details || typeof details !== "object") {
            throw new Error("ERPNext returned no item details.");
        }

        // Reuse the empty first row when possible.
        const row = (frm.doc.items || []).find((child) =>
            !child.item_code && !child.custom_batch_no
        ) || frm.add_child("items");

        const row_name = row.name;
        const meta = frappe.get_meta("Quotation Item");
        const allowed_fields = new Set(
            (meta.fields || []).map((field) => field.fieldname)
        );

        // Apply the returned standard item details without triggering
        // the item_code handler and causing another price fetch.
        for (const [fieldname, value] of Object.entries(details)) {
            if (
                !allowed_fields.has(fieldname) ||
                [
                    "item_code",
                    "name",
                    "doctype",
                    "parent",
                    "parenttype",
                    "parentfield",
                    "idx",
                    "batch_no",
                    "custom_batch_no"
                ].includes(fieldname)
            ) {
                continue;
            }

            row[fieldname] = value;
        }

        // Assign these only after the batch-aware request has completed.
        row.item_code = item_code;
        row.qty = 1;
        row.custom_batch_no = batch_no || "";

        if (has_row_warehouse && warehouse) {
            row.warehouse = warehouse;
        }

        // Ensure the row still exists and refresh the grid.
        if (!(frm.doc.items || []).some((child) => child.name === row_name)) {
            throw new Error("The Quotation item row was unexpectedly removed.");
        }

        frm.refresh_field("items");
        frm.dirty();

        frappe.show_alert({
            message:
                `Added ${item_code}` +
                (batch_no ? ` — Batch ${batch_no}` : ""),
            indicator: "green"
        });
    }

    async function process_barcode(frm, raw_barcode) {
        if (!supported(frm)) return;

        const barcode = String(raw_barcode || "").trim();
        if (!barcode) return;

        const form_key = frm.docname || frm.doc.name || "new-quotation";

        if (busyForms.has(form_key)) {
            frappe.show_alert({
                message: "Finish the current item selection first.",
                indicator: "orange"
            });
            return;
        }

        busyForms.add(form_key);

        try {
            const lookup = await call("scan_barcode_with_variants", {
                search_value: barcode
            });

            let selected = lookup;

            if (lookup.has_variants) {
                selected = await select_variant(lookup.variants);
                if (!selected) return;
            }

            const item_code = selected.item_code || selected.name;

            if (!item_code) {
                throw new Error("No concrete item was selected.");
            }

            if (selected.disabled) {
                throw new Error(`Item ${item_code} is disabled.`);
            }

            if (selected.has_variants && !selected.variant_of) {
                throw new Error(`Select a concrete variant for ${item_code}.`);
            }

            if (selected.has_serial_no) {
                throw new Error(
                    "Serial-number-tracked items are not supported by this selector."
                );
            }

            const warehouse = get_warehouse(frm);

            if (!warehouse) {
                throw new Error(
                    "Please select Custom Warehouse on the Quotation " +
                    "before scanning items."
                );
            }

            let batch_no = "";

            if (selected.has_batch_no) {
                batch_no = await select_batch(item_code, warehouse);
                if (!batch_no) return;
            }

            await add_item(
                frm,
                {
                    ...selected,
                    item_code
                },
                warehouse,
                batch_no
            );
        } finally {
            busyForms.delete(form_key);
        }
    }

    function install_scanner_patch() {
        const Scanner = window.erpnext?.utils?.BarcodeScanner;

        if (!Scanner?.prototype?.process_scan) {
            console.warn(
                "StyleTone: BarcodeScanner.process_scan is not available yet."
            );
            return false;
        }

        const proto = Scanner.prototype;

        if (proto[PATCH_FLAG]) {
            return true;
        }

        const original = proto.process_scan;

        proto.process_scan = function (...args) {
            const frm = this.frm;

            // Leave all non-Quotation documents on ERPNext's original scanner.
            if (!supported(frm)) {
                return original.apply(this, args);
            }

            const field = this.scan_barcode_field;

            const barcode = String(
                frm.doc.scan_barcode ||
                field?.get_value?.() ||
                field?.$input?.val() ||
                frm.fields_dict.scan_barcode?.$input?.val() ||
                ""
            ).trim();

            if (!barcode) {
                return original.apply(this, args);
            }

            // Clear the standard scan field before opening dialogs.
            frm.doc.scan_barcode = "";

            if (field?.set_value) {
                field.set_value("");
            } else if (field?.$input) {
                field.$input.val("");
            }

            if (frm.fields_dict.scan_barcode?.$input) {
                frm.fields_dict.scan_barcode.$input.val("");
            }

            process_barcode(frm, barcode).catch(show_error);

            return Promise.resolve();
        };

        Object.defineProperty(proto, PATCH_FLAG, {
            value: true,
            configurable: false
        });

        console.info(
            "StyleTone: Quotation barcode scanner connected. " +
            "Batch is passed before item details are fetched."
        );

        return true;
    }

    frappe.ui.form.on("Quotation", {
        refresh(frm) {
            if (supported(frm)) {
                install_scanner_patch();
            }
        }
    });

    window.StyleToneQuotationBatch = {
        process_barcode,
        supported,
        install_scanner_patch
    };
})();