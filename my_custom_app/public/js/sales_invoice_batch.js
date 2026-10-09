
/* StyleTone - Sales Invoice Barcode and Batch Selector
 * ERPNext / Frappe v16
 *
 * Templates are never inserted into invoice rows.
 * POSNext invoices are excluded whenever pos_profile is populated.
 */

(() => {
    "use strict";

    const METHOD =
        "my_custom_app.sales_invoice_batch.scan_barcode_with_variants";

    const INSTALL_FLAG = "__styleToneSalesInvoiceBatchV7";

    if (window[INSTALL_FLAG]) {
        return;
    }
    window[INSTALL_FLAG] = true;

    console.info("StyleTone: Sales Invoice barcode selector loaded.");

    function is_supported_sales_invoice(frm) {
        return Boolean(
            frm &&
            frm.doc &&
            frm.doc.doctype === "Sales Invoice" &&
            !frm.doc.pos_profile
        );
    }

    function show_error(error, title = "Barcode Error") {
        const message =
            error?.message ||
            error?.exc ||
            (typeof error === "string" ? error : null) ||
            "The operation could not be completed.";

        frappe.msgprint({
            title,
            indicator: "red",
            message: frappe.utils.escape_html(String(message))
        });
    }

    function get_default_warehouse(frm) {
        return (
            frm.doc.set_warehouse ||
            frappe.defaults.get_user_default("Warehouse") ||
            ""
        );
    }

    function get_barcode_data(barcode) {
        return frappe.call({
            method: METHOD,
            args: {
                search_value: barcode
            }
        }).then((r) => {
            if (!r.message) {
                throw new Error("The barcode lookup returned no item.");
            }
            return r.message;
        });
    }

    function select_variant(variants) {
        return new Promise((resolve, reject) => {
            if (!Array.isArray(variants) || !variants.length) {
                reject(new Error("No enabled variants are available."));
                return;
            }

            const options = variants.map((variant) => ({
                label:
                    `${variant.item_code}` +
                    (variant.item_name
                        ? ` — ${variant.item_name}`
                        : ""),
                value: variant.item_code
            }));

            const dialog = new frappe.ui.Dialog({
                title: "Select Item Variant",
                fields: [
                    {
                        fieldname: "item_code",
                        fieldtype: "Select",
                        label: "Variant",
                        options: options,
                        reqd: 1
                    }
                ],
                primary_action_label: "Select Variant",
                primary_action(values) {
                    const selected = variants.find(
                        (v) => v.item_code === values.item_code
                    );

                    if (!selected) {
                        frappe.msgprint("Please select a valid variant.");
                        return;
                    }

                    dialog.hide();
                    resolve(selected);
                },
                secondary_action_label: "Cancel",
                secondary_action() {
                    dialog.hide();
                    resolve(null);
                }
            });

            dialog.show();
        });
    }

    function select_batch(item_code, warehouse) {
        return new Promise((resolve, reject) => {
            frappe.call({
                method: "frappe.client.get_list",
                args: {
                    doctype: "Batch",
                    fields: [
                        "name",
                        "expiry_date",
                        "batch_qty"
                    ],
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
                    reject(
                        new Error(
                            `No batches with positive batch quantity were found for ${item_code}.`
                        )
                    );
                    return;
                }

                const fields = [
                    {
                        fieldname: "batch_no",
                        fieldtype: "Select",
                        label: "Batch",
                        options: batches.map((batch) => ({
                            label:
                                `${batch.name}` +
                                (batch.expiry_date
                                    ? ` — Expiry: ${batch.expiry_date}`
                                    : ""),
                            value: batch.name
                        })),
                        reqd: 1
                    }
                ];

                const dialog = new frappe.ui.Dialog({
                    title: `Select Batch — ${item_code}`,
                    fields,
                    primary_action_label: "Select Batch",
                    primary_action(values) {
                        const selected = batches.find(
                            (batch) => batch.name === values.batch_no
                        );

                        if (!selected) {
                            frappe.msgprint("Please select a valid batch.");
                            return;
                        }

                        dialog.hide();
                        resolve(selected.name);
                    },
                    secondary_action_label: "Cancel",
                    secondary_action() {
                        dialog.hide();
                        resolve(null);
                    }
                });

                dialog.show();
            }).catch(reject);
        });
    }

    async function add_item_to_invoice(frm, data, warehouse, batch_no) {
        const item_code = data.item_code;

        if (!item_code) {
            throw new Error("No item variant was selected.");
        }

        // Server-side guard: never add a template.
        const item = await frappe.db.get_value(
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

        const details = item?.message;

        if (!details || details.disabled) {
            throw new Error(
                `Item ${item_code} does not exist or is disabled.`
            );
        }

        if (details.has_variants && !details.variant_of) {
            throw new Error(
                `${item_code} is an Item Template. Select one of its variants.`
            );
        }

        if (details.has_batch_no && !batch_no) {
            throw new Error(
                `A batch must be selected for ${item_code}.`
            );
        }

        // Increment an existing row only when item, warehouse and batch match.
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
            // Setting item_code triggers ERPNext's normal item details logic.
            await frappe.model.set_value(
                row.doctype,
                row.name,
                "item_code",
                item_code
            );

            // Re-fetch row after asynchronous item details processing.
            const current_row = (frm.doc.items || []).find(
                (r) => r.name === row.name
            );

            if (!current_row || current_row.item_code !== item_code) {
                throw new Error(
                    `ERPNext did not accept item ${item_code}.`
                );
            }

            if (warehouse) {
                await frappe.model.set_value(
                    current_row.doctype,
                    current_row.name,
                    "warehouse",
                    warehouse
                );
            }

            if (batch_no) {
                await frappe.model.set_value(
                    current_row.doctype,
                    current_row.name,
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
            // Remove the incomplete row so the invoice is not left half-filled.
            const failed_row = (frm.doc.items || []).find(
                (r) => r.name === row.name
            );

            if (failed_row) {
                frm.doc.items = frm.doc.items.filter(
                    (r) => r.name !== row.name
                );
                frm.refresh_field("items");
            }

            throw error;
        }
    }

    async function process_barcode(frm, barcode) {
        if (!is_supported_sales_invoice(frm)) {
            return;
        }

        barcode = (barcode || "").trim();

        if (!barcode) {
            return;
        }

        const lookup = await get_barcode_data(barcode);
        let selected_item = lookup;

        if (lookup.has_variants) {
            selected_item = await select_variant(lookup.variants);

            if (!selected_item) {
                return;
            }
        }

        // Do not rely on the lookup alone: verify the selected item.
        const selected_code =
            typeof selected_item === "string"
                ? selected_item
                : selected_item.item_code;

        if (!selected_code) {
            throw new Error("No valid item variant was selected.");
        }

        const item_result = await frappe.db.get_value(
            "Item",
            selected_code,
            [
                "name",
                "disabled",
                "has_variants",
                "variant_of",
                "has_batch_no"
            ]
        );

        const item = item_result?.message;

        if (!item || item.disabled) {
            throw new Error(
                `Selected item ${selected_code} does not exist or is disabled.`
            );
        }

        if (item.has_variants && !item.variant_of) {
            throw new Error(
                `Item ${selected_code} is a template. Select a variant.`
            );
        }

        const selected_data = {
            ...lookup,
            ...(typeof selected_item === "object" ? selected_item : {}),
            item_code: selected_code,
            has_batch_no: item.has_batch_no
        };

        const warehouse = get_default_warehouse(frm);
        let batch_no = "";

        if (item.has_batch_no) {
            batch_no = await select_batch(selected_code, warehouse);

            if (!batch_no) {
                return;
            }
        }

        await add_item_to_invoice(
            frm,
            selected_data,
            warehouse,
            batch_no
        );
    }

    function open_barcode_dialog(frm) {
        if (!is_supported_sales_invoice(frm)) {
            return;
        }

        const dialog = new frappe.ui.Dialog({
            title: "Scan Barcode",
            fields: [
                {
                    fieldname: "barcode",
                    fieldtype: "Data",
                    label: "Barcode",
                    reqd: 1,
                    description:
                        "Scan the barcode or enter it manually, then press Enter."
                }
            ],
            primary_action_label: "Find Item",
            primary_action(values) {
                const barcode = (values.barcode || "").trim();

                if (!barcode) {
                    frappe.msgprint("Please scan or enter a barcode.");
                    return;
                }

                dialog.get_primary_btn().prop("disabled", true);

                process_barcode(frm, barcode)
                    .then(() => {
                        dialog.get_primary_btn().prop("disabled", false);
                        dialog.set_value("barcode", "");
                        dialog.get_field("barcode").$input.focus();
                    })
                    .catch((error) => {
                        dialog.get_primary_btn().prop("disabled", false);
                        show_error(error);
                    });
            }
        });

        dialog.show();
        dialog.get_field("barcode").$input.focus();
    }

    frappe.ui.form.on("Sales Invoice", {
        refresh(frm) {
            if (!is_supported_sales_invoice(frm)) {
                return;
            }

            frm.add_custom_button(
                "Scan Barcode / Batch",
                () => open_barcode_dialog(frm),
                "Items"
            );
        }
    });

    // Expose a single entry point for testing and future integration.
    window.StyleToneSalesInvoiceBatch = {
        process_barcode,
        open_barcode_dialog,
        is_supported_sales_invoice
    };
})();
