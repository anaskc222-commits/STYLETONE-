
/*
 * StyleTone - Sales Invoice Barcode + Batch Selector
 * ERPNext v16 / Frappe v16
 *
 * Standard Desk Sales Invoice only.
 *
 * Required Python methods:
 *   my_custom_app.sales_invoice_batch.scan_barcode_with_variants
 *   my_custom_app.sales_invoice_batch.get_available_batches
 */

(function () {
    "use strict";

    const INSTALL_FLAG = "__styleToneSalesInvoiceBatchV3";

    if (window[INSTALL_FLAG]) {
        console.log("StyleTone: scanner already installed.");
        return;
    }

    function is_standard_sales_invoice(frm) {
        return Boolean(
            frm &&
            frm.doc &&
            frm.doc.doctype === "Sales Invoice" &&
            !Number(frm.doc.is_pos)
        );
    }

    function escape_html(value) {
        return frappe.utils.escape_html(String(value ?? ""));
    }

    function show_error(title, message) {
        frappe.msgprint({
            title: __(title),
            message: message,
            indicator: "red"
        });
    }

    function get_scan_warehouse(frm) {
        return frm.doc.set_warehouse || null;
    }

    function play_success(scanner) {
        if (typeof scanner.play_success_sound === "function") {
            scanner.play_success_sound();
        }
    }

    function play_failure(scanner) {
        if (typeof scanner.play_fail_sound === "function") {
            scanner.play_fail_sound();
        }
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
            has_batch_no: Boolean(item.has_batch_no),
            has_serial_no: Boolean(item.has_serial_no)
        };
    }

    function format_expiry_date(value) {
        if (!value) {
            return __("No Expiry Date");
        }

        try {
            return frappe.datetime.str_to_user(value);
        } catch (error) {
            return String(value);
        }
    }

    async function select_batch(frm, item_code, warehouse) {
        if (!warehouse) {
            frappe.msgprint({
                title: __("Warehouse Required"),
                message: __(
                    "Select Set Warehouse before scanning items."
                ),
                indicator: "orange"
            });

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

        // Accept qty or available_qty, depending on the Python response.
        const available_batches = batches.filter(function (batch) {
            const qty = Number(
                batch.qty ?? batch.available_qty ?? 0
            );

            return Boolean(batch.batch_no) && qty > 0;
        }).map(function (batch) {
            return {
                ...batch,
                qty: Number(
                    batch.qty ?? batch.available_qty ?? 0
                )
            };
        });

        if (!available_batches.length) {
            frappe.msgprint({
                title: __("No Available Batch"),
                message: __(
                    "No batch with positive available stock was returned for item {0} in warehouse {1}. Check the Python method get_available_batches and ensure it returns batch_no and qty.",
                    [
                        escape_html(item_code),
                        escape_html(warehouse)
                    ]
                ),
                indicator: "orange"
            });

            return null;
        }

        return new Promise(function (resolve) {
            let settled = false;
            let dialog;

            function finish(value) {
                if (settled) {
                    return;
                }

                settled = true;
                resolve(value);
            }

            let html = `
                <div class="style-tone-batch-list">
                    <table class="table table-bordered">
                        <thead>
                            <tr>
                                <th style="width:40px"></th>
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
                    <tr class="style-tone-batch-row"
                        data-index="${index}"
                        style="cursor:pointer">
                        <td class="text-center">
                            <input type="radio"
                                name="style-tone-batch-choice"
                                value="${index}">
                        </td>
                        <td>${escape_html(batch.batch_no)}</td>
                        <td>${escape_html(
                            format_expiry_date(batch.expiry_date)
                        )}</td>
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

            dialog = new frappe.ui.Dialog({
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
                        frappe.msgprint(
                            __("The selected batch is invalid.")
                        );
                        return;
                    }

                    console.log(
                        "StyleTone: selected batch:",
                        selected.batch_no,
                        selected
                    );

                    // IMPORTANT: resolve selection BEFORE hiding the dialog.
                    finish(selected);
                    dialog.hide();
                },

                onhide: function () {
                    // If Select already resolved the promise, this does nothing.
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
            frappe.msgprint(
                __("No enabled variants are available.")
            );
            return null;
        }

        if (variants.length === 1) {
            return variants[0];
        }

        return new Promise(function (resolve) {
            let settled = false;
            let dialog;

            function finish(value) {
                if (settled) {
                    return;
                }

                settled = true;
                resolve(value);
            }

            let html = `
                <div class="style-tone-variant-list">
                    <table class="table table-bordered">
                        <thead>
                            <tr>
                                <th style="width:40px"></th>
                                <th>${__("Item Code")}</th>
                                <th>${__("Item Name")}</th>
                            </tr>
                        </thead>
                        <tbody>
            `;

            variants.forEach(function (variant, index) {
                html += `
                    <tr class="style-tone-variant-row"
                        data-index="${index}"
                        style="cursor:pointer">
                        <td class="text-center">
                            <input type="radio"
                                name="style-tone-variant-choice"
                                value="${index}">
                        </td>
                        <td>${escape_html(variant.item_code)}</td>
                        <td>${escape_html(variant.item_name || "")}</td>
                    </tr>
                `;
            });

            html += `
                        </tbody>
                    </table>
                </div>
            `;

            dialog = new frappe.ui.Dialog({
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

                    const selected = variants[Number(selected_index)];

                    if (!selected || !selected.item_code) {
                        frappe.msgprint(
                            __("The selected variant is invalid.")
                        );
                        return;
                    }

                    // Resolve before hiding to avoid the onhide race.
                    finish(selected);
                    dialog.hide();
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

    function find_invoice_row(frm, data) {
        return (frm.doc.items || []).find(function (row) {
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

            return true;
        });
    }

    async function add_scanned_item(scanner, data) {
        const frm = scanner.frm;

        if (!frm || !frm.doc) {
            throw new Error("Sales Invoice form is unavailable.");
        }

        if (!data.item_code) {
            throw new Error("The scan result has no item_code.");
        }

        // Make sure the scanner receives a usable quantity.
        if (!data.qty || Number(data.qty) <= 0) {
            data.qty = 1;
        }

        data.default_warehouse =
            data.default_warehouse ||
            get_scan_warehouse(frm);

        console.log(
            "StyleTone: adding item to invoice:",
            {
                item_code: data.item_code,
                batch_no: data.batch_no || null,
                qty: data.qty,
                warehouse: data.default_warehouse
            }
        );

        /*
         * Use ERPNext's own scanner methods to add/update rows.
         * Do not manually insert a child row: ERPNext must fetch
         * item details, price, taxes, UOM, and stock information.
         */
        if (typeof scanner.update_table === "function") {
            await scanner.update_table(data);
        } else if (
            typeof scanner.add_item_to_table === "function"
        ) {
            await scanner.add_item_to_table(data);
        } else {
            throw new Error(
                "ERPNext scanner has neither update_table nor add_item_to_table."
            );
        }

        let row = find_invoice_row(frm, data);

        // If update_table did not add a row, try ERPNext's add method.
        if (
            !row &&
            typeof scanner.add_item_to_table === "function" &&
            typeof scanner.update_table === "function"
        ) {
            console.warn(
                "StyleTone: update_table did not add the expected row; trying add_item_to_table."
            );

            await scanner.add_item_to_table(data);
            row = find_invoice_row(frm, data);
        }

        frm.refresh_field("items");

        console.log(
            "StyleTone: invoice rows after scan:",
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
                "The scanner returned without creating the expected invoice row for item " +
                data.item_code +
                (data.batch_no ? " and batch " + data.batch_no : "") +
                ". Check the console for the scanner error."
            );
        }

        /*
         * Ensure the selected batch is retained on the actual row.
         * The selected batch is still validated by ERPNext when saving.
         */
        if (data.batch_no && row.batch_no !== data.batch_no) {
            await frappe.model.set_value(
                row.doctype,
                row.name,
                "batch_no",
                data.batch_no
            );
        }

        frm.refresh_field("items");

        return row;
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

        scanner.process_scan = async function () {
            const me = this;
            const frm = me.frm;

            if (!is_standard_sales_invoice(frm)) {
                return original_process_scan.apply(me, arguments);
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
                    "StyleTone: barcode scan field not found."
                );
                return;
            }

            const barcode =
                typeof scan_field.get_value === "function"
                    ? scan_field.get_value()
                    : scan_field.value;

            if (!barcode) {
                return;
            }

            if (typeof scan_field.set_value === "function") {
                scan_field.set_value("");
            }

            me.__styleToneScanBusy = true;

            try {
                console.log(
                    "StyleTone: scanning barcode:",
                    barcode
                );

                const response = await frappe.call({
                    method:
                        "my_custom_app.sales_invoice_batch.scan_barcode_with_variants",
                    args: {
                        search_value: barcode,
                        ctx: {
                            set_warehouse: frm.doc.set_warehouse,
                            company: frm.doc.company
                        }
                    }
                });

                const data = (response && response.message) || {};

                console.log(
                    "StyleTone: barcode lookup result:",
                    data
                );

                if (!data.item_code && !data.has_variants) {
                    // Preserve normal ERPNext behavior for unrecognized barcodes.
                    if (typeof scan_field.set_value === "function") {
                        scan_field.set_value(barcode);
                    }

                    return await original_process_scan.apply(me);
                }

                if (data.has_variants) {
                    const variant = await select_variant(
                        data.variants || []
                    );

                    if (!variant) {
                        return;
                    }

                    data.item_code = variant.item_code;
                    data.item_name = variant.item_name || "";
                }

                if (!data.item_code) {
                    throw new Error(
                        "Barcode lookup did not return an item_code."
                    );
                }

                const tracking = await get_item_tracking(data.item_code);

                data.has_batch_no = tracking.has_batch_no ? 1 : 0;
                data.has_serial_no = tracking.has_serial_no ? 1 : 0;
                data.default_warehouse =
                    data.default_warehouse ||
                    get_scan_warehouse(frm);

                delete data.variants;
                delete data.has_variants;
                delete data.is_variant;

                if (
                    tracking.has_batch_no &&
                    !tracking.has_serial_no
                ) {
                    const batch = await select_batch(
                        frm,
                        data.item_code,
                        get_scan_warehouse(frm)
                    );

                    if (!batch) {
                        console.log(
                            "StyleTone: batch selection cancelled."
                        );
                        return;
                    }

                    data.batch_no = batch.batch_no;
                    console.log(
                        "StyleTone: selected batch confirmed:",
                        data.batch_no
                    );
                }

                data.qty = Number(data.qty) > 0
                    ? Number(data.qty)
                    : 1;

                const row = await add_scanned_item(me, data);

                console.log(
                    "StyleTone: item successfully processed:",
                    {
                        item_code: data.item_code,
                        batch_no: data.batch_no || null,
                        row_name: row.name
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

                show_error(
                    "Barcode Scan Failed",
                    escape_html(error.message || String(error))
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

        const scanner =
            (frm.cscript && frm.cscript.barcode_scanner) ||
            frm.barcode_scanner;

        if (scanner) {
            install_custom_scan(scanner);
        }
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

                const scanner =
                    (frm.cscript && frm.cscript.barcode_scanner) ||
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
