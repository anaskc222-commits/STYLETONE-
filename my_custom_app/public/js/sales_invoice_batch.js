
/* STYLETONE - Sales Invoice barcode and batch selection
 *
 * Warehouse priority:
 * 1. source_warehouse
 * 2. set_warehouse
 *
 * No Item Price lookup.
 * No custom_batch_no.
 * Standard Sales Invoice Item.batch_no only.
 */

(() => {
    "use strict";

    if (window.__styleToneSalesInvoiceBatchV3) return;
    window.__styleToneSalesInvoiceBatchV3 = true;

    const SCAN_METHOD =
        "my_custom_app.sales_invoice_batch.scan_barcode_with_variants";

    const BATCH_METHOD =
        "my_custom_app.sales_invoice_batch.get_available_batches";

    const PATCH_FLAG = "__styleToneStandardBarcodePatchV3";

    function supported(frm) {
        return Boolean(
            frm &&
            frm.doc &&
            frm.doc.doctype === "Sales Invoice" &&
            !frm.doc.is_pos &&
            !frm.doc.pos_profile
        );
    }

    function esc(value) {
        return frappe.utils.escape_html(String(value ?? ""));
    }

    function show_error(error) {
        const message =
            error?.message ||
            error?.exc ||
            (typeof error === "string" ? error : null) ||
            __("Barcode processing failed.");

        frappe.msgprint({
            title: __("Barcode / Batch Error"),
            indicator: "red",
            message: esc(message),
        });
    }

    // Use Source Warehouse first, then standard Set Warehouse.
    function get_warehouse(frm) {
        return (
            frm.doc.source_warehouse ||
            frm.doc.set_warehouse ||
            ""
        );
    }

    function lookup_barcode(barcode, warehouse) {
        return frappe.call({
            method: SCAN_METHOD,
            args: {
                barcode,
                warehouse,
            },
        }).then((response) => {
            const result = response.message;

            if (!result) {
                throw new Error("No response returned for this barcode.");
            }

            if (!result.found) {
                throw new Error(result.message || "Barcode not found.");
            }

            return result;
        });
    }

    function make_dialog(title, fieldname, html) {
        const dialog = new frappe.ui.Dialog({
            title,
            size: "large",
            fields: [
                {
                    fieldname,
                    fieldtype: "HTML",
                },
            ],
        });

        dialog.fields_dict[fieldname].$wrapper.html(html);

        return dialog;
    }

    // ========================================================
    // SELECT VARIANT
    // ========================================================

    function select_variant(variants) {
        return new Promise((resolve) => {
            if (!Array.isArray(variants) || !variants.length) {
                frappe.msgprint(__("No enabled variants are available."));
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
                    <td>${esc(variant.item_name)}</td>
                    <td>${variant.has_batch_no ? __("Yes") : __("No")}</td>
                    <td>${esc(variant.stock_uom)}</td>
                    <td>
                        <button type="button"
                            class="btn btn-primary btn-xs st-select-variant"
                            data-index="${index}">
                            ${__("Select")}
                        </button>
                    </td>
                </tr>
            `).join("");

            const html = `
                <div class="table-responsive">
                    <table class="table table-bordered table-hover">
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>${__("Item Code")}</th>
                                <th>${__("Item Name")}</th>
                                <th>${__("Batch Tracked")}</th>
                                <th>${__("Stock UOM")}</th>
                                <th>${__("Action")}</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            `;

            dialog = make_dialog(
                __("Select Item Variant"),
                "variant_table",
                html
            );

            dialog.$wrapper.on(
                "click.styleToneVariant",
                ".st-select-variant",
                function () {
                    const index = Number($(this).attr("data-index"));
                    const selected = variants[index];

                    if (!selected?.item_code) {
                        frappe.msgprint(__("Select a valid item variant."));
                        return;
                    }

                    finish(selected);
                    dialog.hide();
                }
            );

            dialog.$wrapper.on(
                "hidden.bs.modal.styleToneVariant",
                function () {
                    finish(null);
                    dialog.$wrapper.off(".styleToneVariant");
                }
            );

            dialog.show();
        });
    }

    // ========================================================
    // SELECT AVAILABLE BATCH
    // ========================================================

    function select_batch(item_code, warehouse) {
        return frappe.call({
            method: BATCH_METHOD,
            args: {
                item_code,
                warehouse,
            },
        }).then((response) => {
            const batches = response.message || [];

            if (!batches.length) {
                frappe.msgprint({
                    title: __("No Available Batch"),
                    indicator: "orange",
                    message: __(
                        "No positive-quantity batches are available for {0} in warehouse {1}.",
                        [esc(item_code), esc(warehouse)]
                    ),
                });

                return null;
            }

            return new Promise((resolve) => {
                let finished = false;
                let dialog;

                function finish(value) {
                    if (finished) return;
                    finished = true;
                    resolve(value);
                }

                const rows = batches.map((batch, index) => `
                    <tr>
                        <td>${index + 1}</td>
                        <td><strong>${esc(batch.batch_no)}</strong></td>
                        <td>${esc(batch.expiry_date || __("Not set"))}</td>
                        <td class="text-right">${esc(batch.qty)}</td>
                        <td>
                            <button type="button"
                                class="btn btn-primary btn-xs st-select-batch"
                                data-index="${index}">
                                ${__("Select")}
                            </button>
                        </td>
                    </tr>
                `).join("");

                const html = `
                    <div class="table-responsive">
                        <table class="table table-bordered table-hover">
                            <thead>
                                <tr>
                                    <th>#</th>
                                    <th>${__("Batch No")}</th>
                                    <th>${__("Expiry Date")}</th>
                                    <th>${__("Available Qty")}</th>
                                    <th>${__("Action")}</th>
                                </tr>
                            </thead>
                            <tbody>${rows}</tbody>
                        </table>
                    </div>
                `;

                dialog = make_dialog(
                    __("Select Batch — {0}", [item_code]),
                    "batch_table",
                    html
                );

                dialog.$wrapper.on(
                    "click.styleToneBatch",
                    ".st-select-batch",
                    function () {
                        const index = Number($(this).attr("data-index"));
                        const selected = batches[index];

                        if (!selected?.batch_no) {
                            frappe.msgprint(__("Select a valid batch."));
                            return;
                        }

                        finish(selected.batch_no);
                        dialog.hide();
                    }
                );

                dialog.$wrapper.on(
                    "hidden.bs.modal.styleToneBatch",
                    function () {
                        finish(null);
                        dialog.$wrapper.off(".styleToneBatch");
                    }
                );

                dialog.show();
            });
        });
    }

    // ========================================================
    // ADD ITEM USING STANDARD ERPNext ITEM DETAILS
    // ========================================================

    async function add_item(frm, item_code, warehouse, batch_no) {
        const response = await frappe.db.get_value(
            "Item",
            item_code,
            [
                "name",
                "disabled",
                "has_variants",
                "variant_of",
                "has_batch_no",
                "has_serial_no",
            ]
        );

        const item = response?.message;

        if (!item || item.disabled) {
            throw new Error(`Item ${item_code} is missing or disabled.`);
        }

        if (item.has_variants && !item.variant_of) {
            throw new Error(`${item_code} is an item template.`);
        }

        if (item.has_batch_no && item.has_serial_no) {
            throw new Error(
                `Serial-and-batch item ${item_code} needs a separate selection workflow.`
            );
        }

        if (item.has_batch_no && !batch_no) {
            throw new Error(`Select a batch for ${item_code}.`);
        }

        const existing = (frm.doc.items || []).find((row) =>
            row.item_code === item_code &&
            (row.warehouse || "") === warehouse &&
            (row.batch_no || "") === (batch_no || "")
        );

        if (existing) {
            await frappe.model.set_value(
                existing.doctype,
                existing.name,
                "qty",
                flt(existing.qty || 0) + 1
            );

            frm.refresh_field("items");

            frappe.show_alert({
                message: __("Quantity increased for {0}", [item_code]),
                indicator: "green",
            });

            return;
        }

        // Reuse an empty standard item row if one exists.
        let row = (frm.doc.items || []).find(
            (child) => !child.item_code
        );

        let created_new = false;

        if (!row) {
            row = frm.add_child("items");
            created_new = true;
        }

        try {
            if (warehouse) {
                await frappe.model.set_value(
                    row.doctype,
                    row.name,
                    "warehouse",
                    warehouse
                );
            }

            // Standard ERPNext item processing populates item details.
            await frappe.model.set_value(
                row.doctype,
                row.name,
                "item_code",
                item_code
            );

            const current = (frm.doc.items || []).find(
                (child) => child.name === row.name
            );

            if (!current || current.item_code !== item_code) {
                throw new Error(`ERPNext did not accept item ${item_code}.`);
            }

            if (warehouse) {
                await frappe.model.set_value(
                    current.doctype,
                    current.name,
                    "warehouse",
                    warehouse
                );
            }

            // Standard Sales Invoice Item field only.
            if (batch_no) {
                await frappe.model.set_value(
                    current.doctype,
                    current.name,
                    "batch_no",
                    batch_no
                );
            }

            frm.refresh_field("items");

            frappe.show_alert({
                message: __("Added {0}", [item_code]),
                indicator: "green",
            });
        } catch (error) {
            if (created_new) {
                frm.doc.items = (frm.doc.items || []).filter(
                    (child) => child.name !== row.name
                );
            } else {
                await frappe.model.set_value(
                    row.doctype,
                    row.name,
                    "item_code",
                    ""
                );
            }

            frm.refresh_field("items");
            throw error;
        }
    }

    // ========================================================
    // COMPLETE BARCODE FLOW
    // ========================================================

    async function process_barcode(frm, raw_barcode) {
        if (!supported(frm)) return;

        const barcode = String(raw_barcode || "").trim();

        if (!barcode) return;

        const warehouse = get_warehouse(frm);

        if (!warehouse) {
            frappe.msgprint({
                title: __("Source Warehouse Required"),
                indicator: "orange",
                message: __(
                    "Select Source Warehouse or Set Warehouse before scanning."
                ),
            });
            return;
        }

        const lookup = await lookup_barcode(barcode, warehouse);

        let selected_item;

        if (lookup.has_variants) {
            selected_item = await select_variant(lookup.variants);
            if (!selected_item) return;
        } else {
            selected_item = lookup.item;
        }

        const item_code = selected_item?.item_code;

        if (!item_code) {
            throw new Error("A concrete item was not selected.");
        }

        if (
            selected_item.has_batch_no &&
            selected_item.has_serial_no
        ) {
            throw new Error(
                `Serial-and-batch item ${item_code} needs a separate selection workflow.`
            );
        }

        let batch_no = "";

        if (selected_item.has_batch_no) {
            batch_no = await select_batch(item_code, warehouse);
            if (!batch_no) return;
        }

        await add_item(frm, item_code, warehouse, batch_no);
    }

    // ========================================================
    // ERPNext BARCODE SCANNER INTEGRATION
    // ========================================================

    function install_scanner_patch() {
        const Scanner = window.erpnext?.utils?.BarcodeScanner;

        if (!Scanner?.prototype?.process_scan) {
            console.warn(
                "STYLETONE: BarcodeScanner.process_scan is unavailable."
            );
            return false;
        }

        const proto = Scanner.prototype;

        if (proto[PATCH_FLAG]) return true;

        const original = proto.process_scan;

        proto.process_scan = function (...args) {
            const frm = this.frm;

            if (!supported(frm)) {
                return original.apply(this, args);
            }

            const field = this.scan_barcode_field;

            const barcode = String(
                frm.doc.scan_barcode ||
                field?.get_value?.() ||
                args.find((value) => typeof value === "string") ||
                ""
            ).trim();

            if (!barcode) {
                return original.apply(this, args);
            }

            frm.doc.scan_barcode = "";

            if (field?.$input) {
                field.$input.val("");
            }

            process_barcode(frm, barcode).catch(show_error);

            return Promise.resolve();
        };

        Object.defineProperty(proto, PATCH_FLAG, {
            value: true,
            configurable: false,
        });

        console.info(
            "STYLETONE: standard Sales Invoice barcode flow installed."
        );

        return true;
    }

    frappe.ui.form.on("Sales Invoice", {
        refresh(frm) {
            if (supported(frm)) {
                install_scanner_patch();
            }
        },
    });

    window.StyleToneSalesInvoiceBatch = {
        process_barcode,
        supported,
        install_scanner_patch,
    };
})();
