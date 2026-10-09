
(() => {
    "use strict";

    const API = "my_custom_app.quotation_batch";

    function supported(frm) {
        return Boolean(
            frm &&
            frm.doc &&
            frm.doc.doctype === "Quotation"
        );
    }

    function escape(value) {
        return frappe.utils.escape_html(String(value ?? ""));
    }

    function warehouse_for(frm) {
        return (
            frm.doc.set_warehouse ||
            frappe.defaults.get_user_default("Warehouse") ||
            ""
        );
    }

    function call(method, args) {
        return frappe.call({
            method: `${API}.${method}`,
            args
        }).then((r) => {
            if (r.exc) {
                throw new Error("The server could not complete the request.");
            }
            return r.message;
        });
    }

    function choose_from_table(title, rows, columns, label) {
        return new Promise((resolve) => {
            if (!rows || !rows.length) {
                frappe.msgprint(`No ${label} available.`);
                resolve(null);
                return;
            }

            let finished = false;

            const finish = (value) => {
                if (finished) return;
                finished = true;
                resolve(value);
            };

            const htmlRows = rows.map((row, index) => {
                const cells = columns.map((column) =>
                    `<td>${escape(row[column.key] ?? column.empty ?? "")}</td>`
                ).join("");

                return `
                    <tr>
                        ${cells}
                        <td>
                            <button type="button"
                                class="btn btn-primary btn-xs st-choose"
                                data-index="${index}">
                                Select
                            </button>
                        </td>
                    </tr>
                `;
            }).join("");

            const headers = columns.map((column) =>
                `<th>${escape(column.label)}</th>`
            ).join("");

            const dialog = new frappe.ui.Dialog({
                title,
                size: "large",
                fields: [
                    {
                        fieldname: "selection",
                        fieldtype: "HTML"
                    }
                ]
            });

            const html = `
                <div class="table-responsive">
                    <table class="table table-bordered table-hover">
                        <thead>
                            <tr>${headers}<th>Action</th></tr>
                        </thead>
                        <tbody>${htmlRows}</tbody>
                    </table>
                </div>
            `;

            dialog.fields_dict.selection.$wrapper.html(html);

            dialog.$wrapper.on("click.stQuotation", ".st-choose", function () {
                const index = Number($(this).attr("data-index"));
                finish(rows[index] || null);
                dialog.hide();
            });

            dialog.$wrapper.on("hidden.bs.modal.stQuotation", () => {
                finish(null);
                dialog.$wrapper.off(".stQuotation");
            });

            dialog.show();
        });
    }

    async function choose_variant(result) {
        if (!result.has_variants) {
            return result;
        }

        const selected = await choose_from_table(
            "Select Item Variant",
            result.variants,
            [
                { key: "item_code", label: "Item Code" },
                { key: "item_name", label: "Item Name" },
                { key: "has_batch_no", label: "Batch Tracked" },
                { key: "stock_uom", label: "Stock UOM" }
            ],
            "variants"
        );

        return selected;
    }

    async function choose_batch(item_code, warehouse) {
        const batches = await call("get_available_batches", {
            item_code,
            warehouse
        });

        const selected = await choose_from_table(
            `Select Batch — ${item_code} (${warehouse})`,
            batches,
            [
                { key: "name", label: "Batch No." },
                { key: "expiry_date", label: "Expiry Date", empty: "Not set" },
                { key: "available_qty", label: "Ledger Qty" }
            ],
            "available batches"
        );

        return selected?.name || null;
    }

    async function add_item(frm, item_code, warehouse, batch_no) {
        const item_result = await frappe.db.get_value(
            "Item",
            item_code,
            [
                "disabled",
                "has_batch_no",
                "has_variants",
                "variant_of"
            ]
        );

        const item = item_result?.message;

        if (!item || item.disabled) {
            throw new Error(`Item ${item_code} is missing or disabled.`);
        }

        if (item.has_variants && !item.variant_of) {
            throw new Error("An item template cannot be added directly.");
        }

        if (item.has_batch_no && !batch_no) {
            throw new Error(`Select a batch for ${item_code}.`);
        }

        if (!item.has_batch_no) {
            batch_no = "";
        }

        const existing = (frm.doc.items || []).find((row) =>
            row.item_code === item_code &&
            (row.warehouse || "") === (warehouse || "") &&
            (row.custom_batch_no || "") === (batch_no || "")
        );

        if (existing) {
            await frappe.model.set_value(
                existing.doctype,
                existing.name,
                "qty",
                flt(existing.qty || 0) + 1
            );

            frm.refresh_field("items");
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
                throw new Error(`ERPNext did not accept item ${item_code}.`);
            }

            if (warehouse && frappe.meta.has_field("Quotation Item", "warehouse")) {
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
                    "custom_batch_no",
                    batch_no
                );
            }

            frm.refresh_field("items");
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

        const result = await call("scan_barcode_with_variants", {
            search_value: barcode
        });

        const selected = await choose_variant(result);
        if (!selected) return;

        const item_code = selected.item_code || selected.name;

        if (!item_code) {
            throw new Error("No concrete item was selected.");
        }

        const item_result = await frappe.db.get_value(
            "Item",
            item_code,
            ["disabled", "has_batch_no", "has_variants", "variant_of"]
        );

        const item = item_result?.message;

        if (!item || item.disabled) {
            throw new Error(`Item ${item_code} is missing or disabled.`);
        }

        if (item.has_variants && !item.variant_of) {
            throw new Error("Select a concrete variant first.");
        }

        let warehouse = warehouse_for(frm);

        if (frappe.meta.has_field("Quotation Item", "warehouse")) {
            warehouse = warehouse || "";
        } else {
            warehouse = "";
        }

        let batch_no = "";

        if (item.has_batch_no) {
            if (!warehouse) {
                frappe.throw(
                    "Select a default Warehouse on the Quotation or set your user default Warehouse before scanning batch-tracked items."
                );
                return;
            }

            batch_no = await choose_batch(item_code, warehouse);
            if (!batch_no) return;
        }

        await add_item(frm, item_code, warehouse, batch_no);

        frappe.show_alert({
            message: `Added ${item_code}${batch_no ? ` — Batch ${batch_no}` : ""}`,
            indicator: "green"
        });
    }

    function bind_barcode_field(frm) {
        const field = frm.fields_dict.custom_scan_barcode;
        if (!field || !field.$input) return;

        field.$input.off(".stQuotationBarcode");

        field.$input.on("keydown.stQuotationBarcode", function (event) {
            if (event.key !== "Enter") return;

            event.preventDefault();

            const barcode = String(field.$input.val() || "").trim();
            if (!barcode) return;

            field.$input.val("");

            process_barcode(frm, barcode).catch((error) => {
                frappe.msgprint({
                    title: "Quotation Barcode Error",
                    indicator: "red",
                    message: escape(
                        error?.message || "Barcode processing failed."
                    )
                });
            });
        });
    }

    frappe.ui.form.on("Quotation", {
        refresh(frm) {
            if (!supported(frm)) return;
            bind_barcode_field(frm);
        }
    });

    window.StyleToneQuotationBatch = {
        process_barcode,
        supported
    };
})();
