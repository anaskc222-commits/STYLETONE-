
/*
 * ================================================================
 * SALES INVOICE - MANUAL BATCH + VARIANT SELECTOR
 * ERPNext v16
 *
 * Standard Desk Sales Invoice only.
 * POS / POS Next is not modified.
 *
 * Features:
 * 1. Custom barcode lookup
 * 2. Template barcode -> Variant table
 * 3. All enabled variants shown
 * 4. Normal ERPNext item processing
 * 5. Batch popup on each batch-tracked scan
 * 6. Batch No, Expiry Date, Available Qty
 * 7. Positive-stock batches only
 * 8. Different batches use separate invoice rows
 * 9. Non-batch variants use normal processing
 * ================================================================
 */

(function () {
    "use strict";

    if (window.__styleToneSalesInvoiceBatchFinal) {
        return;
    }

    const pending_batch_rows = new Set();

    // ============================================================
    // CHECK BATCH REQUIREMENT
    // ============================================================

    async function check_batch_required(frm, item) {
        if (
            !frm ||
            !item ||
            !item.item_code ||
            frm.doc.doctype !== "Sales Invoice" ||
            frm.doc.is_pos
        ) {
            return false;
        }

        try {
            const r = await frappe.db.get_value(
                "Item",
                item.item_code,
                ["has_batch_no", "has_serial_no"]
            );

            const item_data = r && r.message;

            return !!(
                item_data &&
                item_data.has_batch_no &&
                !item_data.has_serial_no
            );
        } catch (error) {
            console.error(
                "Unable to check batch requirement:",
                error
            );

            return false;
        }
    }

    // ============================================================
    // ADD ITEM THROUGH ERPNext SCANNER
    //
    // For batch-tracked items, temporarily mark existing rows
    // of the same item as already scanned. ERPNext's scanner
    // will then create/use a new row instead of incrementing
    // an earlier batch row.
    // ============================================================

    async function update_scanned_item(scanner, data) {
        const frm = scanner && scanner.frm;

        if (!frm || !data || !data.item_code) {
            throw new Error("Missing scanner, invoice, or item.");
        }

        const force_new_batch_row =
            await check_batch_required(frm, data);

        const saved_flags = [];

        if (force_new_batch_row) {
            (frm.doc.items || []).forEach(function (row) {
                if (row.item_code !== data.item_code) {
                    return;
                }

                saved_flags.push({
                    row: row,
                    had_property: Object.prototype.hasOwnProperty.call(
                        row,
                        "has_item_scanned"
                    ),
                    old_value: row.has_item_scanned
                });

                row.has_item_scanned = 1;
            });
        }

        try {
            // Keep ERPNext's standard item processing.
            return await scanner.update_table(data);
        } finally {
            saved_flags.forEach(function (saved) {
                if (saved.had_property) {
                    saved.row.has_item_scanned =
                        saved.old_value;
                } else {
                    delete saved.row.has_item_scanned;
                }
            });
        }
    }

    // ============================================================
    // BATCH DIALOG
    // ============================================================

    function show_batch_dialog(frm, item) {
        if (
            !frm ||
            !item ||
            !item.item_code
        ) {
            return;
        }

        const row_key = item.name;

        if (!row_key || pending_batch_rows.has(row_key)) {
            return;
        }

        pending_batch_rows.add(row_key);

        const warehouse =
            item.warehouse ||
            frm.doc.set_warehouse;

        if (!warehouse) {
            pending_batch_rows.delete(row_key);

            frappe.msgprint({
                title: __("Warehouse Required"),
                message: __(
                    "Please select a source warehouse before selecting a batch."
                ),
                indicator: "orange"
            });

            return;
        }

        frappe.call({
            method:
                "my_custom_app.sales_invoice_batch.get_available_batches",

            args: {
                item_code: item.item_code,
                warehouse: warehouse
            },

            callback: function (r) {
                const batches = r.message || [];

                const current_row = frm.doc.items.find(
                    function (row) {
                        return row.name === row_key;
                    }
                );

                if (!current_row) {
                    pending_batch_rows.delete(row_key);
                    return;
                }

                // Do not replace a batch already assigned to this row.
                if (current_row.batch_no) {
                    pending_batch_rows.delete(row_key);
                    return;
                }

                if (!batches.length) {
                    pending_batch_rows.delete(row_key);

                    frappe.msgprint({
                        title: __("No Available Batch"),
                        message: __(
                            "No positive-stock batch is available for {0} in warehouse {1}.",
                            [current_row.item_code, warehouse]
                        ),
                        indicator: "orange"
                    });

                    return;
                }

                let html = `
                    <div class="style-tone-batch-list">
                        <table class="table table-bordered">
                            <thead>
                                <tr>
                                    <th style="width:45px;"></th>
                                    <th>${__("Batch No")}</th>
                                    <th>${__("Expiry Date")}</th>
                                    <th class="text-right">
                                        ${__("Available Qty")}
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                `;

                batches.forEach(function (batch, index) {
                    const batch_no =
                        frappe.utils.escape_html(
                            String(batch.batch_no || "")
                        );

                    const expiry_date = batch.expiry_date
                        ? frappe.datetime.str_to_user(
                            batch.expiry_date
                        )
                        : __("No Expiry Date");

                    const qty = frappe.utils.escape_html(
                        String(batch.qty ?? 0)
                    );

                    html += `
                        <tr
                            class="style-tone-batch-row"
                            data-index="${index}"
                            style="cursor:pointer;"
                        >
                            <td class="text-center">
                                <input
                                    type="radio"
                                    name="style-tone-batch-${row_key}"
                                    value="${index}"
                                >
                            </td>
                            <td>${batch_no}</td>
                            <td>${frappe.utils.escape_html(
                                String(expiry_date)
                            )}</td>
                            <td class="text-right">${qty}</td>
                        </tr>
                    `;
                });

                html += `
                            </tbody>
                        </table>
                    </div>
                `;

                const dialog = new frappe.ui.Dialog({
                    title: __("Select Batch"),

                    fields: [
                        {
                            fieldtype: "HTML",
                            fieldname: "batch_html"
                        }
                    ],

                    primary_action_label: __("Select"),

                    primary_action: async function () {
                        const selected_index = dialog.$wrapper
                            .find(
                                'input[name="style-tone-batch-' +
                                row_key +
                                '"]:checked'
                            )
                            .val();

                        if (
                            selected_index === undefined ||
                            selected_index === null
                        ) {
                            frappe.show_alert({
                                message: __("Please select a batch"),
                                indicator: "orange"
                            });

                            return;
                        }

                        const selected_batch =
                            batches[Number(selected_index)];

                        if (
                            !selected_batch ||
                            !selected_batch.batch_no
                        ) {
                            frappe.msgprint(
                                __("The selected batch is invalid.")
                            );
                            return;
                        }

                        const row = frm.doc.items.find(
                            function (d) {
                                return d.name === row_key;
                            }
                        );

                        if (!row) {
                            dialog.hide();
                            pending_batch_rows.delete(row_key);
                            return;
                        }

                        try {
                            await frappe.model.set_value(
                                row.doctype,
                                row.name,
                                "batch_no",
                                selected_batch.batch_no
                            );

                            frm.refresh_field("items");

                            dialog.hide();
                        } catch (error) {
                            console.error(
                                "Unable to set selected batch:",
                                error
                            );

                            frappe.msgprint({
                                title: __("Batch Selection Failed"),
                                message: __(
                                    "Unable to set the selected batch. Please try again."
                                ),
                                indicator: "red"
                            });
                        }
                    },

                    onhide: function () {
                        pending_batch_rows.delete(row_key);
                    }
                });

                dialog.fields_dict.batch_html.$wrapper.html(html);

                dialog.$wrapper.on(
                    "click",
                    ".style-tone-batch-row",
                    function () {
                        const index = $(this).attr("data-index");

                        dialog.$wrapper
                            .find(
                                'input[name="style-tone-batch-' +
                                row_key +
                                '"]'
                            )
                            .prop("checked", false);

                        dialog.$wrapper
                            .find(
                                'input[name="style-tone-batch-' +
                                row_key +
                                '"][value="' +
                                index +
                                '"]'
                            )
                            .prop("checked", true);

                        dialog.$wrapper
                            .find(".style-tone-batch-row")
                            .css("background-color", "");

                        $(this).css(
                            "background-color",
                            "var(--subtle-fg)"
                        );
                    }
                );

                dialog.show();
            },

            error: function (error) {
                pending_batch_rows.delete(row_key);

                console.error("Batch lookup failed:", error);

                frappe.msgprint({
                    title: __("Batch Lookup Failed"),
                    message: __(
                        "Unable to retrieve available batches."
                    ),
                    indicator: "red"
                });
            }
        });
    }

    // ============================================================
    // SCHEDULE BATCH DIALOG AFTER ITEM PROCESSING
    // ============================================================

    function schedule_batch_dialog(frm, row) {
        if (!frm || !row || !row.item_code) {
            return;
        }

        setTimeout(async function () {
            try {
                const current_row = frm.doc.items.find(
                    function (d) {
                        return d.name === row.name;
                    }
                );

                if (!current_row || current_row.batch_no) {
                    return;
                }

                const required = await check_batch_required(
                    frm,
                    current_row
                );

                if (required) {
                    show_batch_dialog(frm, current_row);
                }
            } catch (error) {
                console.error(
                    "Sales Invoice batch popup error:",
                    error
                );
            }
        }, 300);
    }

    // ============================================================
    // VARIANT TABLE DIALOG
    // ============================================================

    function show_variant_dialog(
        scanner,
        barcode,
        data,
        variants,
        resolve,
        reject
    ) {
        if (!variants || !variants.length) {
            frappe.msgprint({
                title: __("No Enabled Variants"),
                message: __(
                    "This template has no enabled variants available for selection."
                ),
                indicator: "orange"
            });

            reject(new Error("No enabled variants."));
            return;
        }

        let html = `
            <div class="style-tone-variant-list">
                <table class="table table-bordered">
                    <thead>
                        <tr>
                            <th style="width:45px;"></th>
                            <th>${__("Item Code")}</th>
                            <th>${__("Item Name")}</th>
                            <th>${__("Batch Tracked")}</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        variants.forEach(function (variant, index) {
            html += `
                <tr
                    class="style-tone-variant-row"
                    data-index="${index}"
                    style="cursor:pointer;"
                >
                    <td class="text-center">
                        <input
                            type="radio"
                            name="style-tone-variant"
                            value="${index}"
                        >
                    </td>
                    <td>${frappe.utils.escape_html(
                        String(variant.item_code || "")
                    )}</td>
                    <td>${frappe.utils.escape_html(
                        String(variant.item_name || "")
                    )}</td>
                    <td>
                        ${variant.has_batch_no
                            ? __("Yes")
                            : __("No")}
                    </td>
                </tr>
            `;
        });

        html += `
                    </tbody>
                </table>
            </div>
        `;

        const dialog = new frappe.ui.Dialog({
            title: __("Select Variant"),

            fields: [
                {
                    fieldtype: "HTML",
                    fieldname: "variant_html"
                }
            ],

            primary_action_label: __("Select"),

            primary_action: async function () {
                const selected_index = dialog.$wrapper
                    .find(
                        'input[name="style-tone-variant"]:checked'
                    )
                    .val();

                if (
                    selected_index === undefined ||
                    selected_index === null
                ) {
                    frappe.show_alert({
                        message: __("Please select a variant"),
                        indicator: "orange"
                    });
                    return;
                }

                const variant = variants[
                    Number(selected_index)
                ];

                if (!variant || !variant.item_code) {
                    frappe.msgprint(
                        __("The selected variant is invalid.")
                    );
                    return;
                }

                dialog.hide();

                // Use the selected variant's own tracking settings.
                const selected_data = Object.assign(
                    {},
                    data,
                    {
                        item_code: variant.item_code,
                        item_name: variant.item_name || "",
                        barcode: barcode,
                        has_batch_no: variant.has_batch_no ? 1 : 0,
                        has_serial_no: variant.has_serial_no ? 1 : 0,
                        is_variant: 1,
                        has_variants: 0
                    }
                );

                delete selected_data.variants;

                try {
                    const row = await update_scanned_item(
                        scanner,
                        selected_data
                    );

                    scanner.play_success_sound();

                    resolve(row);

                    schedule_batch_dialog(
                        scanner.frm,
                        row
                    );
                } catch (error) {
                    scanner.play_fail_sound();
                    reject(error);
                }
            }
        });

        dialog.fields_dict.variant_html.$wrapper.html(html);

        dialog.$wrapper.on(
            "click",
            ".style-tone-variant-row",
            function () {
                const index = $(this).attr("data-index");

                dialog.$wrapper
                    .find('input[name="style-tone-variant"]')
                    .prop("checked", false);

                dialog.$wrapper
                    .find(
                        'input[name="style-tone-variant"][value="' +
                        index +
                        '"]'
                    )
                    .prop("checked", true);

                dialog.$wrapper
                    .find(".style-tone-variant-row")
                    .css("background-color", "");

                $(this).css(
                    "background-color",
                    "var(--subtle-fg)"
                );
            }
        );

        dialog.show();
    }

    // ============================================================
    // BARCODE SCAN PATCH
    // ============================================================

    function install_barcode_process_scan(scanner) {
        if (
            !scanner ||
            scanner.__styleTone_variant_scan_patched
        ) {
            return;
        }

        const original_process_scan = scanner.process_scan;

        if (typeof original_process_scan !== "function") {
            return;
        }

        scanner.process_scan = function () {
            const me = this;

            return new Promise(function (resolve, reject) {
                const input = me.scan_barcode_field.value;

                me.scan_barcode_field.set_value("");

                if (!input) {
                    resolve();
                    return;
                }

                frappe.call({
                    method:
                        "my_custom_app.sales_invoice_batch.scan_barcode_with_variants",

                    args: {
                        search_value: input
                    },

                    callback: async function (r) {
                        const data = r.message || {};

                        // No custom barcode match:
                        // use ERPNext's native scanner.
                        if (!data.item_code) {
                            me.scan_barcode_field.set_value(input);

                            original_process_scan
                                .apply(me)
                                .then(resolve)
                                .catch(reject);

                            return;
                        }

                        const variants = data.variants || [];

                        // Template with multiple variants.
                        if (
                            data.has_variants &&
                            variants.length > 1
                        ) {
                            show_variant_dialog(
                                me,
                                input,
                                data,
                                variants,
                                resolve,
                                reject
                            );

                            return;
                        }

                        // Template with no enabled variants.
                        if (
                            data.has_variants &&
                            variants.length === 0
                        ) {
                            frappe.msgprint({
                                title: __("No Enabled Variants"),
                                message: __(
                                    "This template has no enabled variants available for selection."
                                ),
                                indicator: "orange"
                            });

                            reject(new Error("No enabled variants."));
                            return;
                        }

                        // Template with one variant:
                        // automatically use that variant's settings.
                        if (
                            data.has_variants &&
                            variants.length === 1
                        ) {
                            data.item_code = variants[0].item_code;
                            data.item_name =
                                variants[0].item_name || "";
                            data.has_batch_no =
                                variants[0].has_batch_no ? 1 : 0;
                            data.has_serial_no =
                                variants[0].has_serial_no ? 1 : 0;
                        }

                        delete data.variants;
                        delete data.has_variants;
                        delete data.is_variant;

                        try {
                            const row = await update_scanned_item(
                                me,
                                data
                            );

                            me.play_success_sound();

                            resolve(row);

                            schedule_batch_dialog(
                                me.frm,
                                row
                            );
                        } catch (error) {
                            me.play_fail_sound();
                            reject(error);
                        }
                    },

                    error: function (error) {
                        console.error(
                            "Custom barcode lookup failed:",
                            error
                        );

                        // Fall back to ERPNext's native scanner.
                        me.scan_barcode_field.set_value(input);

                        original_process_scan
                            .apply(me)
                            .then(resolve)
                            .catch(reject);
                    }
                });
            });
        };

        scanner.__styleTone_variant_scan_patched = true;
    }

    // ============================================================
    // INSTALL
    // ============================================================

    function install() {
        if (
            !window.erpnext ||
            !erpnext.TransactionController
        ) {
            return false;
        }

        const prototype =
            erpnext.TransactionController.prototype;

        if (!prototype) {
            return false;
        }

        // --------------------------------------------------------
        // Setup patch
        // --------------------------------------------------------

        if (!prototype.__styleTone_original_setup) {
            prototype.__styleTone_original_setup =
                prototype.setup;

            prototype.setup = function () {
                prototype.__styleTone_original_setup.apply(
                    this,
                    arguments
                );

                const frm = this.frm;

                if (
                    !frm ||
                    frm.doc.doctype !== "Sales Invoice" ||
                    frm.doc.is_pos
                ) {
                    return;
                }

                const controller = this;
                let attempts = 0;

                const timer = setInterval(function () {
                    attempts++;

                    if (
                        !controller.frm ||
                        controller.frm.doc.doctype !==
                            "Sales Invoice" ||
                        controller.frm.doc.is_pos
                    ) {
                        clearInterval(timer);
                        return;
                    }

                    if (controller.barcode_scanner) {
                        install_barcode_process_scan(
                            controller.barcode_scanner
                        );

                        if (
                            controller.barcode_scanner
                                .__styleTone_variant_scan_patched
                        ) {
                            clearInterval(timer);
                        }

                        return;
                    }

                    if (attempts >= 40) {
                        clearInterval(timer);

                        console.warn(
                            "Sales Invoice barcode scanner was not found."
                        );
                    }
                }, 250);
            };
        }

        // --------------------------------------------------------
        // Batch selector override
        // --------------------------------------------------------

        if (!prototype.__styleTone_original_batch_selector) {
            const original =
                prototype.show_batch_dialog_if_required;

            if (typeof original === "function") {
                prototype.__styleTone_original_batch_selector =
                    original;

                prototype.show_batch_dialog_if_required =
                    async function (item) {
                        const frm = this.frm;

                        if (
                            !frm ||
                            frm.doc.doctype !== "Sales Invoice" ||
                            frm.doc.is_pos
                        ) {
                            return original.apply(
                                this,
                                arguments
                            );
                        }

                        const required =
                            await check_batch_required(
                                frm,
                                item
                            );

                        if (required) {
                            show_batch_dialog(frm, item);
                            return;
                        }

                        return original.apply(
                            this,
                            arguments
                        );
                    };
            } else {
                console.warn(
                    "ERPNext batch-selector method was not found."
                );
            }
        }

        window.__styleToneSalesInvoiceBatchFinal = true;

        console.log(
            "Sales Invoice custom batch/variant selector installed."
        );

        return true;
    }

    // ============================================================
    // START
    // ============================================================

    if (install()) {
        return;
    }

    let attempts = 0;

    const timer = setInterval(function () {
        attempts++;

        if (install() || attempts >= 40) {
            clearInterval(timer);
        }
    }, 250);
})();
