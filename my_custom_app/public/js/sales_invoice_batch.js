
/*
 * StyleTone - Sales Invoice Barcode + Batch Selector
 * ERPNext v16 / Frappe v16
 *
 * Scope:
 *   Standard Desk Sales Invoice only.
 *   POS invoices are excluded.
 *
 * Features:
 *   1. Resolve scanned barcode using custom Python method.
 *   2. Show variant selection for item templates.
 *   3. Show batch selection for batch-tracked items.
 *   4. Display Batch No, Expiry Date and Available Qty.
 *   5. Select batch before updating the invoice.
 *   6. Verify that the item and batch are added to the invoice.
 *   7. Prevent overlapping scans.
 *
 * Python methods:
 *   my_custom_app.sales_invoice_batch.scan_barcode_with_variants
 *   my_custom_app.sales_invoice_batch.get_available_batches
 */

(function () {
    "use strict";

    const INSTALL_FLAG = "__styleToneSalesInvoiceBatchV2";

    if (window[INSTALL_FLAG]) {
        console.log("StyleTone: batch scanner already installed.");
        return;
    }

    function is_standard_sales_invoice(frm) {
        return !!(
            frm &&
            frm.doc &&
            frm.doc.doctype === "Sales Invoice" &&
            !Number(frm.doc.is_pos)
        );
    }

    function escape_html(value) {
        return frappe.utils.escape_html(String(value ?? ""));
    }

    function play_success(scanner) {
        if (scanner &&
            typeof scanner.play_success_sound === "function") {
            scanner.play_success_sound();
        }
    }

    function play_failure(scanner) {
        if (scanner &&
            typeof scanner.play_fail_sound === "function") {
            scanner.play_fail_sound();
        }
    }

    function show_message(title, message, indicator) {
        frappe.msgprint({
            title: __(title),
            message: message,
            indicator: indicator || "orange"
        });
    }

    async function get_item_tracking(item_code) {
        const response = await frappe.db.get_value(
            "Item",
            item_code,
            [
                "has_batch_no",
                "has_serial_no",
                "disabled"
            ]
        );

        const item = response && response.message;

        if (!item || item.disabled) {
            throw new Error(
                __("The item is missing or disabled.")
            );
        }

        return {
            has_batch_no: !!item.has_batch_no,
            has_serial_no: !!item.has_serial_no
        };
    }

    function get_scan_warehouse(frm) {
        return frm.doc.set_warehouse || null;
    }

    function format_expiry_date(expiry_date) {
        if (!expiry_date) {
            return escape_html(__("No Expiry Date"));
        }

        const value = String(expiry_date).trim();

        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            console.warn(
                "StyleTone: invalid batch expiry date:",
                expiry_date
            );

            return escape_html(__("No Expiry Date"));
        }

        try {
            return escape_html(
                frappe.datetime.str_to_user(value)
            );
        } catch (error) {
            console.warn(
                "StyleTone: expiry date formatting failed:",
                value,
                error
            );

            return escape_html(value);
        }
    }

    async function select_batch(frm, item_code, warehouse) {
        if (!warehouse) {
            show_message(
                "Warehouse Required",
                __("Select Set Warehouse before scanning items."),
                "orange"
            );

            return null;
        }

        const response = await frappe.call({
            method:
                "my_custom_app.sales_invoice_batch.get_available_batches",
            args: {
                item_code: item_code,
                warehouse: warehouse
            }
        });

        const batches = (response && response.message) || [];

        const available_batches = batches.filter(function (batch) {
            return (
                batch &&
                batch.batch_no &&
                Number(batch.qty) > 0
            );
        });

        if (!available_batches.length) {
            show_message(
                "No Available Batch",
                __(
                    "No positive-stock batch is available for {0} in warehouse {1}.",
                    [
                        escape_html(item_code),
                        escape_html(warehouse)
                    ]
                ),
                "orange"
            );

            return null;
        }

        return new Promise(function (resolve) {
            let settled = false;

            function finish(value) {
                if (settled) return;
                settled = true;
                resolve(value);
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

            available_batches.forEach(function (batch, index) {
                html += `
                    <tr
                        class="style-tone-batch-row"
                        data-index="${index}"
                        style="cursor:pointer;"
                    >
                        <td class="text-center">
                            <input
                                type="radio"
                                name="style-tone-batch-choice"
                                value="${index}"
                            >
                        </td>
                        <td>${escape_html(batch.batch_no)}</td>
                        <td>${format_expiry_date(batch.expiry_date)}</td>
                        <td class="text-right">
                            ${escape_html(batch.qty)}
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
                title: __("Select Batch"),
                fields: [
                    {
                        fieldtype: "HTML",
                        fieldname: "batch_html"
                    }
                ],
                primary_action_label: __("Select"),

                primary_action: function () {
                    const selected_index = dialog.$wrapper
                        .find(
                            'input[name="style-tone-batch-choice"]:checked'
                        )
                        .val();

                    if (
                        selected_index === undefined ||
                        selected_index === null
                    ) {
                        frappe.show_alert({
                            message: __("Please select a batch."),
                            indicator: "orange"
                        });
                        return;
                    }

                    const selected =
                        available_batches[Number(selected_index)];

                    if (!selected || !selected.batch_no) {
                        show_message(
                            "Invalid Batch",
                            __("The selected batch is invalid."),
                            "red"
                        );
                        return;
                    }

                    dialog.hide();
                    finish(selected);
                },

                onhide: function () {
                    finish(null);
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
                            'input[name="style-tone-batch-choice"]'
                        )
                        .prop("checked", false);

                    dialog.$wrapper
                        .find(
                            'input[name="style-tone-batch-choice"][value="' +
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
        });
    }

    async function select_variant(variants) {
        if (!variants || !variants.length) {
            show_message(
                "No Enabled Variants",
                __(
                    "This item template has no enabled variants available."
                ),
                "orange"
            );

            return null;
        }

        if (variants.length === 1) {
            return variants[0];
        }

        return new Promise(function (resolve) {
            let settled = false;

            function finish(value) {
                if (settled) return;
                settled = true;
                resolve(value);
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
                                name="style-tone-variant-choice"
                                value="${index}"
                            >
                        </td>
                        <td>${escape_html(variant.item_code)}</td>
                        <td>${escape_html(variant.item_name || "")}</td>
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

                primary_action: function () {
                    const selected_index = dialog.$wrapper
                        .find(
                            'input[name="style-tone-variant-choice"]:checked'
                        )
                        .val();

                    if (
                        selected_index === undefined ||
                        selected_index === null
                    ) {
                        frappe.show_alert({
                            message: __("Please select a variant."),
                            indicator: "orange"
                        });
                        return;
                    }

                    const selected =
                        variants[Number(selected_index)];

                    if (!selected || !selected.item_code) {
                        show_message(
                            "Invalid Variant",
                            __("The selected variant is invalid."),
                            "red"
                        );
                        return;
                    }

                    dialog.hide();
                    finish(selected);
                },

                onhide: function () {
                    finish(null);
                }
            });

            dialog.fields_dict.variant_html.$wrapper.html(html);

            dialog.$wrapper.on(
                "click",
                ".style-tone-variant-row",
                function () {
                    const index = $(this).attr("data-index");

                    dialog.$wrapper
                        .find(
                            'input[name="style-tone-variant-choice"]'
                        )
                        .prop("checked", false);

                    dialog.$wrapper
                        .find(
                            'input[name="style-tone-variant-choice"][value="' +
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
        });
    }

    function install_batch_row_matching(scanner) {
        if (scanner.__styleToneExactBatchMatching) {
            return;
        }

        const original_match =
            scanner.get_row_to_modify_on_scan;

        if (typeof original_match !== "function") {
            console.warn(
                "StyleTone: ERPNext row-matching method not found."
            );
            return;
        }

        scanner.get_row_to_modify_on_scan = function (
            item_code,
            batch_no,
            uom,
            barcode,
            default_warehouse
        ) {
            if (!batch_no) {
                return original_match.call(
                    this,
                    item_code,
                    batch_no,
                    uom,
                    barcode,
                    default_warehouse
                );
            }

            const frm = this.frm;
            const rows = frm.doc[this.items_table_name] || [];

            const target_warehouse =
                default_warehouse || get_scan_warehouse(frm);

            const exact_row = rows.find(function (row) {
                if (
                    row.item_code !== item_code ||
                    row.batch_no !== batch_no
                ) {
                    return false;
                }

                if (uom && row.uom !== uom) {
                    return false;
                }

                if (
                    target_warehouse &&
                    row.warehouse !== target_warehouse
                ) {
                    return false;
                }

                return true;
            });

            if (exact_row) {
                return exact_row;
            }

            return rows.find(function (row) {
                return !row.item_code;
            });
        };

        scanner.__styleToneExactBatchMatching = true;
    }

    /*
     * Confirm the scanned item and selected batch exist after
     * ERPNext processes the scan. Do not count an unrelated
     * existing batch row as a successful update.
     */
    function find_scanned_row(frm, data) {
        const rows = frm.doc.items || [];

        return rows.find(function (row) {
            if (row.item_code !== data.item_code) {
                return false;
            }

            if (
                data.batch_no &&
                row.batch_no !== data.batch_no
            ) {
                return false;
            }

            if (
                data.default_warehouse &&
                row.warehouse &&
                row.warehouse !== data.default_warehouse
            ) {
                return false;
            }

            if (data.uom && row.uom !== data.uom) {
                return false;
            }

            return true;
        });
    }

    async function update_invoice_item(scanner, data) {
        const frm = scanner.frm;

        if (!frm || !frm.doc) {
            throw new Error("Sales Invoice form is unavailable.");
        }

        const expected_row_before = find_scanned_row(frm, data);

        console.log(
            "StyleTone: before update_table:",
            data
        );

        /*
         * ERPNext may have an empty placeholder row.
         * Determine whether the invoice has a real item before
         * allowing the standard scanner to decide its update path.
         */
        const previous_has_items = frm.has_items;

        const has_populated_items = (frm.doc.items || []).some(
            function (row) {
                return !!row.item_code;
            }
        );

        try {
            if (!has_populated_items) {
                frm.has_items = false;
            }

            await scanner.update_table(data);
        } finally {
            frm.has_items = previous_has_items;
        }

        let row = find_scanned_row(frm, data);

        /*
         * Fallback only when the standard update did not create
         * or update the expected item/batch row.
         */
        if (!row && typeof scanner.add_item_to_table === "function") {
            console.warn(
                "StyleTone: update_table did not produce the expected row; trying add_item_to_table."
            );

            await scanner.add_item_to_table(data);
            row = find_scanned_row(frm, data);
        }

        /*
         * Allow any synchronous model updates to settle, then
         * verify once more before declaring success.
         */
        if (!row) {
            row = find_scanned_row(frm, data);
        }

        console.log(
            "StyleTone: after update; expected row:",
            row
        );

        console.log(
            "StyleTone: invoice items after update:",
            (frm.doc.items || []).map(function (item) {
                return {
                    item_code: item.item_code,
                    batch_no: item.batch_no,
                    qty: item.qty,
                    warehouse: item.warehouse
                };
            })
        );

        if (!row) {
            throw new Error(
                "ERPNext did not create the expected invoice row for item " +
                data.item_code +
                (data.batch_no ? ", batch " + data.batch_no : "") +
                ". Check the console for update_table/add_item_to_table errors."
            );
        }

        frm.refresh_field("items");

        return row || expected_row_before;
    }

    function install_custom_scan(scanner) {
        if (
            !scanner ||
            scanner.__styleToneCustomScanInstalled
        ) {
            return;
        }

        const original_process_scan = scanner.process_scan;

        if (typeof original_process_scan !== "function") {
            console.warn(
                "StyleTone: scanner process_scan method not found."
            );
            return;
        }

        install_batch_row_matching(scanner);

        scanner.process_scan = async function () {
            const me = this;
            const frm = me.frm;

            if (!is_standard_sales_invoice(frm)) {
                return original_process_scan.apply(
                    me,
                    arguments
                );
            }

            if (me.__styleToneScanBusy) {
                frappe.show_alert({
                    message: __("Please finish the current scan first."),
                    indicator: "orange"
                });
                return;
            }

            const scan_field = me.scan_barcode_field;

            if (!scan_field) {
                console.error(
                    "StyleTone: scanner barcode field was not found."
                );
                return;
            }

            const input =
                typeof scan_field.get_value === "function"
                    ? scan_field.get_value()
                    : scan_field.value;

            if (!input) {
                return;
            }

            if (typeof scan_field.set_value === "function") {
                scan_field.set_value("");
            }

            me.__styleToneScanBusy = true;

            try {
                console.log(
                    "StyleTone: scanning barcode:",
                    input
                );

                let response;

                try {
                    response = await frappe.call({
                        method:
                            "my_custom_app.sales_invoice_batch.scan_barcode_with_variants",
                        args: {
                            search_value: input,
                            ctx: {
                                set_warehouse: frm.doc.set_warehouse,
                                company: frm.doc.company
                            }
                        }
                    });
                } catch (lookup_error) {
                    console.error(
                        "StyleTone: barcode lookup failed:",
                        lookup_error
                    );

                    if (
                        typeof scan_field.set_value === "function"
                    ) {
                        scan_field.set_value(input);
                    }

                    return await original_process_scan.apply(me);
                }

                const data = (response && response.message) || {};

                console.log(
                    "StyleTone: barcode lookup result:",
                    data
                );

                if (!data.item_code && !data.has_variants) {
                    if (
                        typeof scan_field.set_value === "function"
                    ) {
                        scan_field.set_value(input);
                    }

                    return await original_process_scan.apply(me);
                }

                if (data.has_variants) {
                    const selected_variant = await select_variant(
                        data.variants || []
                    );

                    if (!selected_variant) {
                        return;
                    }

                    data.item_code = selected_variant.item_code;
                    data.item_name =
                        selected_variant.item_name || "";
                }

                if (!data.item_code) {
                    throw new Error(
                        "Barcode lookup did not return an item_code."
                    );
                }

                const tracking = await get_item_tracking(
                    data.item_code
                );

                data.has_batch_no =
                    tracking.has_batch_no ? 1 : 0;

                data.has_serial_no =
                    tracking.has_serial_no ? 1 : 0;

                delete data.variants;
                delete data.has_variants;
                delete data.is_variant;

                data.default_warehouse =
                    data.default_warehouse ||
                    get_scan_warehouse(frm);

                if (
                    tracking.has_batch_no &&
                    !tracking.has_serial_no
                ) {
                    const selected_batch = await select_batch(
                        frm,
                        data.item_code,
                        get_scan_warehouse(frm)
                    );

                    if (!selected_batch) {
                        console.log(
                            "StyleTone: batch selection cancelled."
                        );
                        return;
                    }

                    data.batch_no = selected_batch.batch_no;

                    console.log(
                        "StyleTone: selected batch:",
                        data.batch_no
                    );
                }

                const row = await update_invoice_item(me, data);

                console.log(
                    "StyleTone: item successfully processed:",
                    {
                        item_code: data.item_code,
                        batch_no: data.batch_no || null,
                        row_name: row && row.name
                    }
                );

                play_success(me);

                return row;
            } catch (error) {
                console.error(
                    "StyleTone Sales Invoice scan failed:",
                    error
                );

                play_failure(me);

                show_message(
                    "Barcode Scan Failed",
                    __(
                        "The item could not be added. Check the browser console for the exact error."
                    ),
                    "red"
                );

                throw error;
            } finally {
                me.__styleToneScanBusy = false;
            }
        };

        scanner.__styleToneCustomScanInstalled = true;

        console.log(
            "StyleTone: custom scanner installed on standard Sales Invoice."
        );
    }

    function try_install(frm) {
        if (!is_standard_sales_invoice(frm)) {
            return;
        }

        const controller = frm.cscript;

        const scanner =
            (controller && controller.barcode_scanner) ||
            frm.barcode_scanner;

        if (!scanner) {
            return;
        }

        install_custom_scan(scanner);
    }

    frappe.ui.form.on("Sales Invoice", {
        onload_post_render: function (frm) {
            let attempts = 0;
            const max_attempts = 20;

            const timer = setInterval(function () {
                attempts++;

                if (!is_standard_sales_invoice(frm)) {
                    clearInterval(timer);
                    return;
                }

                try_install(frm);

                const controller = frm.cscript;

                const scanner =
                    (controller && controller.barcode_scanner) ||
                    frm.barcode_scanner;

                if (
                    scanner &&
                    scanner.__styleToneCustomScanInstalled
                ) {
                    clearInterval(timer);
                    return;
                }

                if (attempts >= max_attempts) {
                    clearInterval(timer);

                    console.warn(
                        "StyleTone: could not find the Sales Invoice scanner."
                    );
                }
            }, 250);
        },

        refresh: function (frm) {
            try_install(frm);
        }
    });

    window[INSTALL_FLAG] = true;

    console.log(
        "StyleTone: Sales Invoice batch selector script loaded."
    );
})();
