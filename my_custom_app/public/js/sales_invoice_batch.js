
/*
 * STYLETONE - Sales Invoice Barcode + Batch Selector
 * ERPNext / Frappe v16
 *
 * RULES
 * 1. Ignore is_pos.
 * 2. Disable custom scanner when pos_profile is populated.
 * 3. Resolve template items to actual variants before adding rows.
 * 4. Show batch selection for batch-tracked items.
 * 5. Add/increment the matching invoice row exactly once.
 *
 * Required Python methods:
 *   my_custom_app.sales_invoice_batch.scan_barcode_with_variants
 *   my_custom_app.sales_invoice_batch.get_available_batches
 */

(function () {
    "use strict";

    const INSTALL_FLAG = "__styleToneSalesInvoiceBatchV6";

    if (window[INSTALL_FLAG]) {
        return;
    }

    window[INSTALL_FLAG] = true;

    // ------------------------------------------------------------
    // ELIGIBILITY: POS PROFILE ONLY
    // ------------------------------------------------------------

    function is_supported_sales_invoice(frm) {
        return !!(
            frm &&
            frm.doc &&
            frm.doc.doctype === "Sales Invoice" &&
            !frm.doc.pos_profile
        );
    }

    function escape_html(value) {
        return frappe.utils.escape_html(String(value ?? ""));
    }

    function show_message(title, message, indicator) {
        frappe.msgprint({
            title: __(title),
            message: message,
            indicator: indicator || "orange"
        });
    }

    function show_alert(message, indicator) {
        frappe.show_alert({
            message: __(message),
            indicator: indicator || "orange"
        });
    }

    function get_scan_warehouse(frm) {
        return frm.doc.set_warehouse || null;
    }

    function format_expiry_date(value) {
        if (!value) {
            return __("No Expiry Date");
        }

        const date = String(value);

        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return escape_html(date);
        }

        try {
            return escape_html(
                frappe.datetime.str_to_user(date)
            );
        } catch (error) {
            return escape_html(date);
        }
    }

    // ------------------------------------------------------------
    // FETCH AND VALIDATE ITEM
    // ------------------------------------------------------------

    async function get_item_record(item_code) {
        const response = await frappe.db.get_value(
            "Item",
            item_code,
            [
                "item_name",
                "has_variants",
                "variant_of",
                "has_batch_no",
                "has_serial_no",
                "disabled"
            ]
        );

        const item = response && response.message;

        if (!item || item.disabled) {
            throw new Error(
                __("Item is missing or disabled: {0}", [item_code])
            );
        }

        return item;
    }

    async function get_item_tracking(item_code) {
        const item = await get_item_record(item_code);

        if (item.has_variants) {
            throw new Error(
                __(
                    "Item {0} is a template. Select an actual item variant.",
                    [item_code]
                )
            );
        }

        return {
            item_name: item.item_name || "",
            has_batch_no: !!item.has_batch_no,
            has_serial_no: !!item.has_serial_no
        };
    }

    // ------------------------------------------------------------
    // GENERIC SELECTION DIALOG
    // ------------------------------------------------------------

    function select_from_table(options) {
        return new Promise(function (resolve) {
            let settled = false;

            function finish(value) {
                if (settled) {
                    return;
                }

                settled = true;
                resolve(value);
            }

            const dialog = new frappe.ui.Dialog({
                title: __(options.title),

                fields: [
                    {
                        fieldtype: "HTML",
                        fieldname: "selection_html"
                    }
                ],

                primary_action_label: __("Select"),

                primary_action: function () {
                    const selected_index = dialog.$wrapper
                        .find(
                            'input[name="' +
                            options.radio_name +
                            '"]:checked'
                        )
                        .val();

                    if (
                        selected_index === undefined ||
                        selected_index === null
                    ) {
                        show_alert(
                            options.select_prompt,
                            "orange"
                        );
                        return;
                    }

                    const selected =
                        options.records[Number(selected_index)];

                    if (!selected) {
                        show_message(
                            "Selection Error",
                            __("The selected record is invalid."),
                            "red"
                        );
                        return;
                    }

                    finish(selected);
                    dialog.hide();
                },

                onhide: function () {
                    finish(null);
                }
            });

            let html = `
                <div class="style-tone-selection">
                    <table class="table table-bordered">
                        <thead>
                            <tr>
                                <th style="width:45px"></th>
                                ${options.headers.map(function (header) {
                                    return `<th>${__(header)}</th>`;
                                }).join("")}
                            </tr>
                        </thead>
                        <tbody>
            `;

            options.records.forEach(function (record, index) {
                html += `
                    <tr
                        class="style-tone-selection-row"
                        data-index="${index}"
                        style="cursor:pointer"
                    >
                        <td class="text-center">
                            <input
                                type="radio"
                                name="${options.radio_name}"
                                value="${index}"
                            >
                        </td>
                        ${options.cells(record).map(function (cell) {
                            return `<td>${cell}</td>`;
                        }).join("")}
                    </tr>
                `;
            });

            html += `
                        </tbody>
                    </table>
                </div>
            `;

            dialog.fields_dict.selection_html.$wrapper.html(html);

            dialog.$wrapper.on(
                "click",
                ".style-tone-selection-row",
                function () {
                    const index = $(this).attr("data-index");

                    dialog.$wrapper
                        .find(
                            'input[name="' +
                            options.radio_name +
                            '"]'
                        )
                        .prop("checked", false);

                    dialog.$wrapper
                        .find(
                            'input[name="' +
                            options.radio_name +
                            '"][value="' +
                            index +
                            '"]'
                        )
                        .prop("checked", true);

                    dialog.$wrapper
                        .find(".style-tone-selection-row")
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
    // VARIANT SELECTION
    // ------------------------------------------------------------

    async function select_variant(variants) {
        if (!Array.isArray(variants) || !variants.length) {
            show_message(
                "No Variants",
                __(
                    "The barcode lookup found a template item but returned no variants. Check scan_barcode_with_variants in sales_invoice_batch.py."
                ),
                "orange"
            );

            return null;
        }

        // Do not silently select a variant when multiple choices exist.
        if (variants.length === 1) {
            return variants[0];
        }

        return select_from_table({
            title: "Select Variant",
            radio_name: "style-tone-variant-choice",
            select_prompt: "Please select a variant.",
            records: variants,

            headers: [
                "Item Code",
                "Item Name",
                "Batch Tracked"
            ],

            cells: function (variant) {
                return [
                    escape_html(variant.item_code),
                    escape_html(variant.item_name || ""),
                    variant.has_batch_no
                        ? __("Yes")
                        : __("No")
                ];
            }
        });
    }

    // ------------------------------------------------------------
    // BATCH SELECTION
    // ------------------------------------------------------------

    async function select_batch(frm, item_code) {
        const warehouse = get_scan_warehouse(frm);

        if (!warehouse) {
            show_message(
                "Warehouse Required",
                __(
                    "Select Set Warehouse before scanning batch-tracked items."
                ),
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

        return select_from_table({
            title: "Select Batch",
            radio_name: "style-tone-batch-choice",
            select_prompt: "Please select a batch.",
            records: available_batches,

            headers: [
                "Batch No",
                "Expiry Date",
                "Available Qty"
            ],

            cells: function (batch) {
                return [
                    escape_html(batch.batch_no),
                    format_expiry_date(batch.expiry_date),
                    escape_html(batch.qty)
                ];
            }
        });
    }

    // ------------------------------------------------------------
    // FIND MATCHING INVOICE ROW
    // ------------------------------------------------------------

    function find_matching_row(frm, data) {
        const rows = frm.doc.items || [];

        const warehouse =
            data.default_warehouse ||
            get_scan_warehouse(frm);

        return rows.find(function (row) {
            if (row.item_code !== data.item_code) {
                return false;
            }

            if ((row.batch_no || "") !== (data.batch_no || "")) {
                return false;
            }

            if (
                data.uom &&
                row.uom &&
                row.uom !== data.uom
            ) {
                return false;
            }

            if (
                warehouse &&
                row.warehouse &&
                row.warehouse !== warehouse
            ) {
                return false;
            }

            return true;
        }) || null;
    }

    // ------------------------------------------------------------
    // ADD OR INCREMENT INVOICE ROW
    // ------------------------------------------------------------

    async function add_or_increment_invoice_item(frm, data) {
        if (!frm || !frm.doc) {
            throw new Error("Sales Invoice form is unavailable.");
        }

        if (!data || !data.item_code) {
            throw new Error(
                "Barcode lookup returned no item code."
            );
        }

        // Validate before creating a child row.
        const tracking = await get_item_tracking(data.item_code);

        if (tracking.has_serial_no) {
            throw new Error(
                __(
                    "Item {0} requires serial-number selection. Use ERPNext's standard serial-number workflow.",
                    [data.item_code]
                )
            );
        }

        const warehouse =
            data.default_warehouse ||
            get_scan_warehouse(frm);

        if (!warehouse) {
            throw new Error(
                __("Set Warehouse is required before adding scanned items.")
            );
        }

        const batch_no = data.batch_no || "";

        let row = find_matching_row(frm, {
            ...data,
            default_warehouse: warehouse,
            batch_no: batch_no
        });

        if (row) {
            await frappe.model.set_value(
                row.doctype,
                row.name,
                "qty",
                Number(row.qty || 0) + 1
            );

            frm.refresh_field("items");

            console.log("StyleTone: invoice row quantity incremented:", {
                item_code: row.item_code,
                batch_no: row.batch_no || null,
                qty: row.qty
            });

            return row;
        }

        const grid =
            frm.fields_dict.items &&
            frm.fields_dict.items.grid;

        if (!grid) {
            throw new Error(
                "Sales Invoice Items table was not found."
            );
        }

        row = frappe.model.add_child(
            frm.doc,
            grid.doctype,
            "items"
        );

        /*
         * Setting item_code invokes ERPNext's standard item details
         * logic. Only validated, non-template item codes reach here.
         */
        await frappe.model.set_value(
            row.doctype,
            row.name,
            "item_code",
            data.item_code
        );

        row = frappe.get_doc(row.doctype, row.name);

        if (!row || row.item_code !== data.item_code) {
            throw new Error(
                "ERPNext did not populate the new invoice item row."
            );
        }

        if (frappe.meta.has_field(row.doctype, "warehouse")) {
            await frappe.model.set_value(
                row.doctype,
                row.name,
                "warehouse",
                warehouse
            );
        }

        if (
            data.uom &&
            frappe.meta.has_field(row.doctype, "uom")
        ) {
            await frappe.model.set_value(
                row.doctype,
                row.name,
                "uom",
                data.uom
            );
        }

        if (
            data.barcode &&
            frappe.meta.has_field(row.doctype, "barcode")
        ) {
            await frappe.model.set_value(
                row.doctype,
                row.name,
                "barcode",
                data.barcode
            );
        }

        if (
            batch_no &&
            frappe.meta.has_field(row.doctype, "batch_no")
        ) {
            await frappe.model.set_value(
                row.doctype,
                row.name,
                "batch_no",
                batch_no
            );
        }

        row = frappe.get_doc(row.doctype, row.name);

        if (!Number(row.qty)) {
            await frappe.model.set_value(
                row.doctype,
                row.name,
                "qty",
                1
            );
        }

        frm.refresh_field("items");

        console.log("StyleTone: invoice row added:", {
            item_code: row.item_code,
            batch_no: row.batch_no || null,
            qty: row.qty,
            warehouse: row.warehouse
        });

        return row;
    }

    // ------------------------------------------------------------
    // SCANNER OVERRIDE
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
            console.warn(
                "StyleTone: ERPNext process_scan method was not found."
            );

            return;
        }

        scanner.process_scan = async function () {
            const me = this;
            const frm = me.frm;

            // Do not override invoices with a POS Profile.
            if (!is_supported_sales_invoice(frm)) {
                return original_process_scan.apply(me, arguments);
            }

            if (me.__styleToneScanBusy) {
                show_alert(
                    "Please finish the current scan first.",
                    "orange"
                );

                return;
            }

            const scan_field = me.scan_barcode_field;

            if (!scan_field) {
                console.error(
                    "StyleTone: barcode input field was not found."
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
                const response = await frappe.call({
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

                const data = (response && response.message) || {};

                console.log(
                    "StyleTone: barcode lookup:",
                    input,
                    data
                );

                if (!data.item_code) {
                    // Unknown barcode: preserve standard ERPNext handling.
                    if (typeof scan_field.set_value === "function") {
                        scan_field.set_value(input);
                    }

                    return await original_process_scan.apply(me);
                }

                let item_code = data.item_code;
                let item = await get_item_record(item_code);

                // Template item: require an actual variant selection.
                if (item.has_variants) {
                    const variants = data.variants || [];

                    if (!variants.length) {
                        throw new Error(
                            __(
                                "Item {0} is a template, but the Python barcode method returned no variants. Update scan_barcode_with_variants in sales_invoice_batch.py.",
                                [item_code]
                            )
                        );
                    }

                    const variant = await select_variant(variants);

                    if (!variant) {
                        return;
                    }

                    if (!variant.item_code) {
                        throw new Error(
                            "The selected variant has no item code."
                        );
                    }

                    item_code = variant.item_code;
                    item = await get_item_record(item_code);

                    if (item.has_variants || item.variant_of == null) {
                        throw new Error(
                            __(
                                "Selected item {0} is not a valid item variant.",
                                [item_code]
                            )
                        );
                    }
                }

                if (item.disabled) {
                    throw new Error(
                        __("Item is disabled: {0}", [item_code])
                    );
                }

                data.item_code = item_code;

                const tracking = await get_item_tracking(item_code);

                data.has_batch_no = tracking.has_batch_no ? 1 : 0;
                data.has_serial_no = tracking.has_serial_no ? 1 : 0;

                data.default_warehouse =
                    data.default_warehouse ||
                    get_scan_warehouse(frm);

                if (tracking.has_serial_no) {
                    throw new Error(
                        __(
                            "Item {0} requires serial-number selection. Use ERPNext's standard serial-number workflow.",
                            [item_code]
                        )
                    );
                }

                if (tracking.has_batch_no) {
                    const selected_batch = await select_batch(
                        frm,
                        item_code
                    );

                    if (!selected_batch) {
                        return;
                    }

                    data.batch_no = selected_batch.batch_no;
                } else {
                    data.batch_no = "";
                }

                const row = await add_or_increment_invoice_item(
                    frm,
                    data
                );

                if (typeof me.play_success_sound === "function") {
                    me.play_success_sound();
                }

                show_alert(
                    __("Item {0} added successfully.", [item_code]),
                    "green"
                );

                return row;

            } catch (error) {
                console.error(
                    "StyleTone Sales Invoice barcode error:",
                    error
                );

                if (typeof me.play_fail_sound === "function") {
                    me.play_fail_sound();
                }

                show_message(
                    "Barcode Scan Failed",
                    escape_html(
                        error && error.message
                            ? error.message
                            : String(error)
                    ),
                    "red"
                );

                // Do not rethrow: avoid a duplicate unhandled rejection.
                return null;

            } finally {
                me.__styleToneScanBusy = false;
            }
        };

        scanner.__styleToneCustomScanInstalled = true;

        console.log(
            "StyleTone: custom scanner installed."
        );
    }

    // ------------------------------------------------------------
    // FIND SCANNER
    // ------------------------------------------------------------

    function try_install(frm) {
        if (!is_supported_sales_invoice(frm)) {
            return;
        }

        const controller = frm.cscript;

        const scanner =
            (controller && controller.barcode_scanner) ||
            frm.barcode_scanner;

        if (scanner) {
            install_custom_scan(scanner);
        }
    }

    // ------------------------------------------------------------
    // FORM EVENTS
    // ------------------------------------------------------------

    frappe.ui.form.on("Sales Invoice", {
        onload_post_render: function (frm) {
            let attempts = 0;
            const max_attempts = 20;

            const timer = setInterval(function () {
                attempts++;

                if (!is_supported_sales_invoice(frm)) {
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
                        "StyleTone: could not find the Sales Invoice barcode scanner."
                    );
                }
            }, 250);
        },

        refresh: function (frm) {
            try_install(frm);
        }
    });

    console.log(
        "StyleTone: Sales Invoice batch selector script loaded."
    );

})();
