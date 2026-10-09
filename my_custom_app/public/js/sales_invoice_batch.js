
/* STYLETONE - ERPNext v16 standard Sales Invoice scanner
 *
 * Normal item  -> batches -> add item
 * Concrete variant -> its batches -> add item
 * Item template -> select variant -> that variant's batches -> add item
 *
 * Does not edit POSNext or its APIs.
 */

(() => {
    "use strict";

    const METHOD =
        "my_custom_app.sales_invoice_batch.scan_barcode_with_variants";

    const PATCH_FLAG = "__styleToneStandardBarcodePatchV1";

    function supported(frm) {
        return Boolean(
            frm &&
            frm.doc &&
            frm.doc.doctype === "Sales Invoice" &&
            !frm.doc.pos_profile
        );
    }

    function show_error(error) {
        const message =
            error?.message ||
            error?.exc ||
            (typeof error === "string" ? error : null) ||
            "Barcode processing failed.";

        frappe.msgprint({
            title: "Barcode / Batch Error",
            indicator: "red",
            message: frappe.utils.escape_html(String(message))
        });
    }

    function esc(value) {
        return frappe.utils.escape_html(String(value ?? ""));
    }

    function get_warehouse(frm) {
        return (
            frm.doc.set_warehouse ||
            frappe.defaults.get_user_default("Warehouse") ||
            ""
        );
    }

    function lookup_barcode(barcode) {
        return frappe.call({
            method: METHOD,
            args: { search_value: barcode }
        }).then((r) => {
            if (!r.message) {
                throw new Error("No item was returned for this barcode.");
            }
            return r.message;
        });
    }

    // Render an HTML selection table in a dialog.
    function show_table_dialog(title, fieldname, html) {
        return new frappe.ui.Dialog({
            title,
            size: "large",
            fields: [
                {
                    fieldname,
                    fieldtype: "HTML"
                }
            ]
        });
    }

    function select_variant(variants) {
        return new Promise((resolve) => {
            if (!Array.isArray(variants) || !variants.length) {
                frappe.msgprint("No enabled variants are available.");
                resolve(null);
                return;
            }

            let finished = false;

            function finish(value) {
                if (finished) return;
                finished = true;
                resolve(value);
            }

            const rows = variants.map((v, i) => `
                <tr>
                    <td>${i + 1}</td>
                    <td><strong>${esc(v.item_code)}</strong></td>
                    <td>${esc(v.item_name || "")}</td>
                    <td>${v.has_batch_no ? "Yes" : "No"}</td>
                    <td>${esc(v.stock_uom || "")}</td>
                    <td>
                        <button type="button"
                            class="btn btn-primary btn-xs st-select-variant"
                            data-index="${i}">
                            Select
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
            `;

            const dialog = show_table_dialog(
                "Select Item Variant",
                "variant_table",
                html
            );

            dialog.show();
            dialog.fields_dict.variant_table.$wrapper.html(html);

            dialog.$wrapper.on(
                "click.styleToneVariant",
                ".st-select-variant",
                function () {
                    const selected = variants[
                        Number($(this).attr("data-index"))
                    ];

                    if (!selected?.item_code) {
                        frappe.msgprint("Please select a valid variant.");
                        return;
                    }

                    finish(selected);
                    dialog.hide();
                }
            );

            dialog.$wrapper.on(
                "hidden.bs.modal.styleToneVariant",
                () => {
                    finish(null);
                    dialog.$wrapper.off(".styleToneVariant");
                }
            );
        });
    }

    function select_batch(item_code) {
        return new Promise((resolve, reject) => {
            let finished = false;

            function finish(value) {
                if (finished) return;
                finished = true;
                resolve(value);
            }

            frappe.call({
                method: "frappe.client.get_list",
                args: {
                    doctype: "Batch",
                    fields: ["name", "expiry_date", "batch_qty"],
                    filters: {
                        item: item_code,
                        disabled: 0,
                        batch_qty: [">", 0]
                    },
                    order_by: "expiry_date asc, name asc",
                    limit_page_length: 500
                }
            }).then((r) => {
                const batches = r.message || [];

                if (!batches.length) {
                    reject(new Error(
                        `No positive-quantity batches were found for ${item_code}.`
                    ));
                    return;
                }

                const rows = batches.map((b, i) => `
                    <tr>
                        <td>${i + 1}</td>
                        <td><strong>${esc(b.name)}</strong></td>
                        <td>${esc(b.expiry_date || "Not set")}</td>
                        <td>${esc(b.batch_qty ?? "")}</td>
                        <td>
                            <button type="button"
                                class="btn btn-primary btn-xs st-select-batch"
                                data-index="${i}">
                                Select
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
                                    <th>Batch</th>
                                    <th>Expiry Date</th>
                                    <th>Batch Qty</th>
                                    <th>Action</th>
                                </tr>
                            </thead>
                            <tbody>${rows}</tbody>
                        </table>
                    </div>
                `;

                const dialog = show_table_dialog(
                    `Select Batch — ${item_code}`,
                    "batch_table",
                    html
                );

                dialog.show();
                dialog.fields_dict.batch_table.$wrapper.html(html);

                dialog.$wrapper.on(
                    "click.styleToneBatch",
                    ".st-select-batch",
                    function () {
                        const selected = batches[
                            Number($(this).attr("data-index"))
                        ];

                        if (!selected?.name) {
                            frappe.msgprint("Please select a valid batch.");
                            return;
                        }

                        finish(selected.name);
                        dialog.hide();
                    }
                );

                dialog.$wrapper.on(
                    "hidden.bs.modal.styleToneBatch",
                    () => {
                        finish(null);
                        dialog.$wrapper.off(".styleToneBatch");
                    }
                );
            }).catch(reject);
        });
    }

    async function add_item(frm, item_code, warehouse, batch_no) {
        const result = await frappe.db.get_value(
            "Item",
            item_code,
            [
                "name",
                "disabled",
                "has_variants",
                "variant_of",
                "has_batch_no"
            ]
        );

        const item = result?.message;

        if (!item || item.disabled) {
            throw new Error(`Item ${item_code} is missing or disabled.`);
        }

        if (item.has_variants && !item.variant_of) {
            throw new Error(
                `${item_code} is a template. Select a concrete variant.`
            );
        }

        if (item.has_batch_no && !batch_no) {
            throw new Error(`A batch must be selected for ${item_code}.`);
        }

        const existing = (frm.doc.items || []).find((row) =>
            row.item_code === item_code &&
            (row.warehouse || "") === (warehouse || "") &&
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
                message: `Quantity increased for ${item_code}`,
                indicator: "green"
            });

            return;
        }

        const row = frm.add_child("items");

        try {
            await frappe.model.set_value(
                row.doctype,
                row.name,
                "item_code",
                item_code
            );

            const current = (frm.doc.items || []).find(
                (r) => r.name === row.name
            );

            if (!current || current.item_code !== item_code) {
                throw new Error(`ERPNext did not accept ${item_code}.`);
            }

            if (warehouse) {
                await frappe.model.set_value(
                    current.doctype,
                    current.name,
                    "warehouse",
                    warehouse
                );
            }

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
                message: `Added ${item_code}`,
                indicator: "green"
            });
        } catch (error) {
            frm.doc.items = (frm.doc.items || []).filter(
                (r) => r.name !== row.name
            );
            frm.refresh_field("items");
            throw error;
        }
    }

    async function process_barcode(frm, raw_barcode) {
        if (!supported(frm)) return;

        const barcode = String(raw_barcode || "").trim();
        if (!barcode) return;

        const lookup = await lookup_barcode(barcode);
        let chosen = lookup;

        // A template barcode needs a variant choice first.
        if (lookup.has_variants) {
            chosen = await select_variant(lookup.variants);
            if (!chosen) return;
        }

        const item_code =
            typeof chosen === "string" ? chosen : chosen.item_code;

        if (!item_code) {
            throw new Error("No concrete item variant was selected.");
        }

        const result = await frappe.db.get_value(
            "Item",
            item_code,
            [
                "name",
                "disabled",
                "has_variants",
                "variant_of",
                "has_batch_no"
            ]
        );

        const item = result?.message;

        if (!item || item.disabled) {
            throw new Error(`Item ${item_code} is missing or disabled.`);
        }

        if (item.has_variants && !item.variant_of) {
            throw new Error(`${item_code} is a template, not a variant.`);
        }

        let batch_no = "";

        if (item.has_batch_no) {
            batch_no = await select_batch(item_code);
            if (!batch_no) return;
        }

        await add_item(
            frm,
            item_code,
            get_warehouse(frm),
            batch_no
        );
    }

    // Patch the ERPNext scanner only for eligible Sales Invoices.
    // All other doctypes and POS-profile invoices use the original method.
    function install_scanner_patch() {
        const Scanner = window.erpnext?.utils?.BarcodeScanner;

        if (!Scanner?.prototype?.process_scan) {
            console.warn(
                "StyleTone: ERPNext BarcodeScanner.process_scan is not available yet."
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
                ""
            ).trim();

            if (!barcode) {
                return original.apply(this, args);
            }

            // Clear the built-in scan field without triggering another scan.
            frm.doc.scan_barcode = "";
            if (field?.$input) field.$input.val("");

            process_barcode(frm, barcode).catch(show_error);

            return Promise.resolve();
        };

        Object.defineProperty(proto, PATCH_FLAG, {
            value: true,
            configurable: false
        });

        console.info("StyleTone: standard Sales Invoice scanner connected.");
        return true;
    }

    frappe.ui.form.on("Sales Invoice", {
        refresh(frm) {
            if (!supported(frm)) return;
            install_scanner_patch();
        }
    });

    window.StyleToneSalesInvoiceBatch = {
        process_barcode,
        supported,
        install_scanner_patch
    };
})();
