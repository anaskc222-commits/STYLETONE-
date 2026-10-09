
/*
 * StyleTone - Sales Invoice Barcode + Batch Selector
 * ERPNext v16
 *
 * Scope:
 *   Standard Desk Sales Invoice only.
 *   Does not patch TransactionController.prototype.
 *
 * Behavior:
 *   1. Resolve scanned barcode using custom Python method.
 *   2. Show variant table for templates with multiple variants.
 *   3. Select batch BEFORE adding/updating the invoice row.
 *   4. Same item + same batch can reuse the matching row.
 *   5. Same item + different batch uses a different row.
 *   6. Non-batch items use ERPNext's normal row matching.
 *   7. Keep ERPNext scanner item processing for pricing, UOM,
 *      taxes and other standard item details.
 */

(function () {
    "use strict";

    const INSTALL_FLAG = "__styleToneSalesInvoiceBatchV2";

    if (window[INSTALL_FLAG]) {
        return;
    }

    // ------------------------------------------------------------
    // BASIC HELPERS
    // ------------------------------------------------------------

    function is_standard_sales_invoice(frm) {
        return !!(
            frm &&
            frm.doc &&
            frm.doc.doctype === "Sales Invoice" &&
            !frm.doc.is_pos
        );
    }

    function escape_html(value) {
        return frappe.utils.escape_html(String(value ?? ""));
    }

    function play_success(scanner) {
        if (scanner && scanner.play_success_sound) {
            scanner.play_success_sound();
        }
    }

    function play_failure(scanner) {
        if (scanner && scanner.play_fail_sound) {
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
            ["has_batch_no", "has_serial_no", "disabled"]
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
        // The invoice header warehouse is selected before scanning.
        return frm.doc.set_warehouse || null;
    }

    // ------------------------------------------------------------
    // BATCH DIALOG
    // Returns the selected batch, or null if cancelled.
    // Does not create or modify an invoice row.
    // ------------------------------------------------------------

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

        if (!batches.length) {
            show_message(
                "No Available Batch",
                __(
                    "No positive-stock batch is available for {0} in warehouse {1}.",
                    [escape_html(item_code), escape_html(warehouse)]
                ),
                "orange"
            );
            return null;
        }

        return new Promise(function (resolve) {
            let settled = false;

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
                const batch_no = escape_html(batch.batch_no);
                const expiry = batch.expiry_date
                    ? escape_html(
                        frappe.datetime.str_to_user(batch.expiry_date)
                    )
                    : escape_html(__("No Expiry Date"));

                const qty = escape_html(batch.qty ?? 0);

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
                        <td>${batch_no}</td>
                        <td>${expiry}</td>
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

                    const selected = batches[Number(selected_index)];

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
                    // Closing the dialog without selecting a batch
                    // cancels this scan. No row is added.
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
                        .find('input[name="style-tone-batch-choice"]')
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

    // ------------------------------------------------------------
    // VARIANT DIALOG
    // Returns the selected variant, or null if cancelled.
    // ------------------------------------------------------------

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

                    const selected = variants[Number(selected_index)];

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
                        .find('input[name="style-tone-variant-choice"]')
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

    // ------------------------------------------------------------
    // BATCH-AWARE ROW MATCHING
    //
    // Installed on this scanner instance only.
    // For batch scans, only an exact item + batch + UOM + warehouse
    // row can be reused. A blank row can be used for a new item.
    //
    // Non-batch scans continue through ERPNext's original matcher.
    // ------------------------------------------------------------

    function install_batch_row_matching(scanner) {
        if (scanner.__styleToneExactBatchMatching) {
            return;
        }

        const original_match = scanner.get_row_to_modify_on_scan;

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
            const rows = (frm.doc[this.items_table_name] || []);
            const target_warehouse =
                default_warehouse || get_scan_warehouse(frm);

            // Find an exact batch match first. Do not reuse a row
            // that has no batch number or a different batch number.
            const exact_row = rows.find(function (row) {
                if (
                    row.item_code !== item_code ||
                    row.batch_no !== batch_no ||
                    row.has_item_scanned
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

            // No exact batch row exists. Return a blank row if one
            // is available; otherwise undefined tells ERPNext to
            // create a new row.
            return rows.find(function (row) {
                return !row.item_code;
            });
        };

        scanner.__styleToneExactBatchMatching = true;
    }

    // ------------------------------------------------------------
    // CUSTOM BARCODE PROCESSING
    // ------------------------------------------------------------

    function install_custom_scan(scanner) {
        if (
            !scanner ||
            scanner.__styleToneCustomScanInstalled
        ) {
            return;
        }

        const original_process_scan = scanner.process_scan;

        if (typeof original_process_scan !== "function") {
            return;
        }

        install_batch_row_matching(scanner);

        scanner.process_scan = async function () {
            const me = this;
            const frm = me.frm;

            if (!is_standard_sales_invoice(frm)) {
                return original_process_scan.apply(me, arguments);
            }

            // Prevent overlapping scans while a variant or batch
            // dialog is open.
            if (me.__styleToneScanBusy) {
                frappe.show_alert({
                    message: __("Please finish the current scan first."),
                    indicator: "orange"
                });
                return;
            }

            const input = me.scan_barcode_field.value;

            me.scan_barcode_field.set_value("");

            if (!input) {
                return;
            }

            me.__styleToneScanBusy = true;

            try {
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
                    // If custom lookup fails, restore the barcode
                    // and let ERPNext attempt its standard scan.
                    console.error(
                        "StyleTone barcode lookup failed:",
                        lookup_error
                    );

                    me.scan_barcode_field.set_value(input);

                    return await original_process_scan.apply(me);
                }

                const data = (response && response.message) || {};

                // No custom match: use ERPNext's standard scanner.
                if (!data.item_code) {
                    me.scan_barcode_field.set_value(input);
                    return await original_process_scan.apply(me);
                }

                // Resolve a template barcode to an enabled variant.
                let selected_variant = null;

                if (data.has_variants) {
                    selected_variant = await select_variant(
                        data.variants || []
                    );

                    if (!selected_variant) {
                        return;
                    }

                    data.item_code = selected_variant.item_code;
                    data.item_name = selected_variant.item_name || "";
                }

                // Always read tracking settings for the resolved
                // item/variant rather than trusting template flags.
                const tracking = await get_item_tracking(data.item_code);

                data.has_batch_no = tracking.has_batch_no ? 1 : 0;
                data.has_serial_no = tracking.has_serial_no ? 1 : 0;

                delete data.variants;
                delete data.has_variants;
                delete data.is_variant;

                // Use the header warehouse as the default context.
                data.default_warehouse =
                    data.default_warehouse || get_scan_warehouse(frm);

                // Select batch BEFORE update_table. If cancelled,
                // no invoice row is added and no quantity changes.
                if (
                    tracking.has_batch_no &&
                    !tracking.has_serial_no
                ) {
                    const warehouse = get_scan_warehouse(frm);

                    const selected_batch = await select_batch(
                        frm,
                        data.item_code,
                        warehouse
                    );

                    if (!selected_batch) {
                        return;
                    }

                    data.batch_no = selected_batch.batch_no;
                }

                // Preserve ERPNext's own item processing, including
                // quantity, UOM, item details and normal calculations.
                const row = await me.update_table(data);

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
                        "The item could not be added. Check the item, warehouse and batch, then try again."
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
            "StyleTone custom scanner installed on standard Sales Invoice."
        );
    }

    // ------------------------------------------------------------
    // INSTALLATION
    //
    // Attach through Sales Invoice form events and modify only the
    // scanner instance. Do not patch TransactionController.prototype.
    // ------------------------------------------------------------

    function try_install(frm) {
        if (!is_standard_sales_invoice(frm)) {
            return;
        }

        const controller = frm.cscript;
        const scanner =
            controller && controller.barcode_scanner;

        if (!scanner) {
            return;
        }

        install_custom_scan(scanner);
    }

    frappe.ui.form.on("Sales Invoice", {
        onload_post_render: function (frm) {
            // Controller setup creates the scanner. Retry briefly
            // in case this event fires before it is available.
            let attempts = 0;

            const timer = setInterval(function () {
                attempts++;

                if (!is_standard_sales_invoice(frm)) {
                    clearInterval(timer);
                    return;
                }

                try_install(frm);

                const controller = frm.cscript;
                const scanner =
                    controller && controller.barcode_scanner;

                if (
                    scanner &&
                    scanner.__styleToneCustomScanInstalled
                ) {
                    clearInterval(timer);
                    return;
                }

                if (attempts >= 20) {
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
})();
