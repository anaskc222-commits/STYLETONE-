// ================================================================
// SALES INVOICE - MANUAL BATCH + VARIANT SELECTOR
// ERPNext v16.37.0
//
// NORMAL DESK SALES INVOICE ONLY
//
// POS / POS NEXT:
//     NOT MODIFIED
//
// FEATURES:
//     1. Manual Item -> Batch popup
//     2. Barcode -> normal ERPNext barcode resolution
//     3. Template barcode -> Variant popup
//     4. Variant -> Batch popup
//     5. Batch popup shows Batch No + Expiry Date
//     6. Quantity is NOT displayed
//     7. Only positive-stock batches
//     8. No FEFO
// ================================================================

(function () {
    "use strict";

    // ------------------------------------------------------------
    // Prevent duplicate installation
    // ------------------------------------------------------------

    if (window.__styleToneSalesInvoiceBatchFinal) {
        return;
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

        const Controller =
            erpnext.TransactionController;

        const prototype =
            Controller.prototype;

        if (!prototype) {
            return false;
        }

        // --------------------------------------------------------
        // PATCH TransactionController.setup
        // --------------------------------------------------------

        if (
            !prototype.__styleTone_original_setup
        ) {
            prototype.__styleTone_original_setup =
                prototype.setup;

            prototype.setup = function () {
                this.__styleTone_original_setup.apply(
                    this,
                    arguments
                );

                const frm = this.frm;

                // Only Sales Invoice
                if (
                    !frm ||
                    frm.doc.doctype !== "Sales Invoice"
                ) {
                    return;
                }

                // Never modify POS
                if (frm.doc.is_pos) {
                    return;
                }

                // ------------------------------------------------
                // Use our barcode resolver.
                //
                // It internally calls ERPNext's normal
                // scan_barcode() and adds variant information
                // only when required.
                // ------------------------------------------------

                if (this.barcode_scanner) {
                    this.barcode_scanner.scan_api =
                        "my_custom_app.sales_invoice_batch.scan_barcode_with_variants";

                    install_barcode_process_scan(
                        this.barcode_scanner
                    );
                }
            };
        }

        // --------------------------------------------------------
        // PATCH batch-selection point
        // --------------------------------------------------------

        if (
            !prototype.__styleTone_original_batch_selector
        ) {
            const original =
                prototype.show_batch_dialog_if_required;

            if (
                typeof original !== "function"
            ) {
                return false;
            }

            prototype.__styleTone_original_batch_selector =
                original;

            prototype.show_batch_dialog_if_required =
                function (item) {
                    const me = this;
                    const frm = me.frm;

                    // ------------------------------------------------
                    // Only Sales Invoice
                    // ------------------------------------------------

                    if (
                        !frm ||
                        frm.doc.doctype !== "Sales Invoice"
                    ) {
                        return original.apply(
                            this,
                            arguments
                        );
                    }

                    // ------------------------------------------------
                    // Never touch POS
                    // ------------------------------------------------

                    if (frm.doc.is_pos) {
                        return original.apply(
                            this,
                            arguments
                        );
                    }

                    // ------------------------------------------------
                    // Basic checks
                    // ------------------------------------------------

                    if (
                        !item ||
                        !item.item_code
                    ) {
                        return original.apply(
                            this,
                            arguments
                        );
                    }

                    // ------------------------------------------------
                    // Only when stock is updated
                    // ------------------------------------------------

                    if (!frm.doc.update_stock) {
                        return original.apply(
                            this,
                            arguments
                        );
                    }

                    // ------------------------------------------------
                    // Serial-only item
                    // Leave ERPNext standard behavior
                    // ------------------------------------------------

                    if (
                        item.has_serial_no &&
                        !item.has_batch_no
                    ) {
                        return original.apply(
                            this,
                            arguments
                        );
                    }

                    // ------------------------------------------------
                    // Not batch controlled
                    // ------------------------------------------------

                    if (!item.has_batch_no) {
                        return original.apply(
                            this,
                            arguments
                        );
                    }

                    // ------------------------------------------------
                    // Already selected
                    // ------------------------------------------------

                    if (item.batch_no) {
                        return original.apply(
                            this,
                            arguments
                        );
                    }

                    // ------------------------------------------------
                    // Warehouse
                    // ------------------------------------------------

                    const warehouse =
                        item.warehouse ||
                        frm.doc.set_warehouse;

                    if (!warehouse) {
                        return original.apply(
                            this,
                            arguments
                        );
                    }

                    // ------------------------------------------------
                    // Prevent duplicate popup request
                    // ------------------------------------------------

                    if (
                        item.__styleTone_batch_loading
                    ) {
                        return;
                    }

                    item.__styleTone_batch_loading =
                        true;

                    // ------------------------------------------------
                    // Get available batches
                    // ------------------------------------------------

                    frappe.call({
                        method:
                            "my_custom_app.sales_invoice_batch.get_available_batches",

                        args: {
                            item_code:
                                item.item_code,

                            warehouse:
                                warehouse
                        },

                        freeze: false,

                        callback: function (r) {
                            item.__styleTone_batch_loading =
                                false;

                            const batches =
                                r.message || [];

                            // ------------------------------------------------
                            // No available batches
                            // ------------------------------------------------

                            if (!batches.length) {
                                frappe.flags.dialog_set =
                                    false;

                                return;
                            }

                            // ------------------------------------------------
                            // Current row
                            // ------------------------------------------------

                            const row =
                                frm.doc.items.find(
                                    function (d) {
                                        return (
                                            d.name ===
                                            item.name
                                        );
                                    }
                                );

                            if (!row) {
                                return;
                            }

                            // ------------------------------------------------
                            // Batch table
                            // ------------------------------------------------

                            const dialog =
                                new frappe.ui.Dialog({
                                    title:
                                        __("Select Batch"),

                                    fields: [
                                        {
                                            fieldtype:
                                                "Table",

                                            fieldname:
                                                "batches",

                                            label:
                                                __("Available Batches"),

                                            cannot_add_rows:
                                                true,

                                            cannot_delete_rows:
                                                true,

                                            in_place_edit:
                                                false,

                                            data:
                                                batches.map(
                                                    function (
                                                        batch
                                                    ) {
                                                        return {
                                                            batch_no:
                                                                batch.batch_no,

                                                            expiry_date:
                                                                batch.expiry_date ||
                                                                ""
                                                        };
                                                    }
                                                ),

                                            fields: [
                                                {
                                                    fieldtype:
                                                        "Data",

                                                    fieldname:
                                                        "batch_no",

                                                    label:
                                                        __("Batch No"),

                                                    in_list_view:
                                                        1,

                                                    read_only:
                                                        1,

                                                    columns:
                                                        2
                                                },

                                                {
                                                    fieldtype:
                                                        "Date",

                                                    fieldname:
                                                        "expiry_date",

                                                    label:
                                                        __("Expiry Date"),

                                                    in_list_view:
                                                        1,

                                                    read_only:
                                                        1,

                                                    columns:
                                                        2
                                                }
                                            ]
                                        }
                                    ],

                                    primary_action_label:
                                        __("Select"),

                                    primary_action:
                                        function () {
                                            const values =
                                                dialog.get_values();

                                            if (
                                                !values ||
                                                !values.batches ||
                                                !values.batches.length
                                            ) {
                                                return;
                                            }

                                            // ------------------------------------------------
                                            // First row is selected because the table
                                            // is read-only and only displays choices.
                                            //
                                            // We replace this below with the selected
                                            // row through the checkbox/selection logic.
                                            // ------------------------------------------------
                                        }
                                });

                            // ------------------------------------------------
                            // Add row-selection behavior
                            // ------------------------------------------------

                            dialog.show();

                            const grid =
                                dialog.fields_dict
                                    .batches
                                    .grid;

                            // Select one batch row
                            grid.wrapper.on(
                                "click",
                                ".grid-row",
                                function () {
                                    grid.grid_rows.forEach(
                                        function (
                                            grid_row
                                        ) {
                                            grid_row
                                                .row
                                                .removeClass(
                                                    "row-selected"
                                                );
                                        }
                                    );

                                    const row_name =
                                        $(this)
                                            .attr(
                                                "data-name"
                                            );

                                    if (row_name) {
                                        $(this)
                                            .addClass(
                                                "row-selected"
                                            );

                                        dialog.__selected_batch =
                                            row_name;
                                    }
                                }
                            );

                            // ------------------------------------------------
                            // Replace primary action
                            // ------------------------------------------------

                            dialog.set_primary_action(
                                __("Select"),
                                function () {
                                    let selected =
                                        null;

                                    if (
                                        dialog.__selected_batch
                                    ) {
                                        selected =
                                            batches.find(
                                                function (
                                                    b
                                                ) {
                                                    return (
                                                        b.batch_no ===
                                                        dialog.__selected_batch
                                                    );
                                                }
                                            );
                                    }

                                    // If only one batch,
                                    // allow direct selection.
                                    if (
                                        !selected &&
                                        batches.length ===
                                            1
                                    ) {
                                        selected =
                                            batches[0];
                                    }

                                    if (!selected) {
                                        frappe.show_alert({
                                            message:
                                                __("Please select a batch"),

                                            indicator:
                                                "orange"
                                        });

                                        return;
                                    }

                                    // ------------------------------------------------
                                    // Set selected batch
                                    // ------------------------------------------------

                                    frappe.model.set_value(
                                        row.doctype,
                                        row.name,
                                        "batch_no",
                                        selected.batch_no
                                    );

                                    dialog.hide();

                                    frm.refresh_field(
                                        "items"
                                    );

                                    frappe.flags.dialog_set =
                                        false;
                                }
                            );
                        },

                        error: function () {
                            item.__styleTone_batch_loading =
                                false;

                            frappe.flags.dialog_set =
                                false;
                        }
                    });

                    // ------------------------------------------------
                    // We handle the batch popup ourselves.
                    // ------------------------------------------------

                    return;
                };
        }

        window.__styleToneSalesInvoiceBatchFinal =
            true;

        console.log(
            "STYLETONE: Sales Invoice batch/variant selector installed."
        );

        return true;
    }

    // ============================================================
    // BARCODE PROCESS PATCH
    // ============================================================

    function install_barcode_process_scan(scanner) {
        if (
            !scanner ||
            scanner.__styleTone_variant_scan_patched
        ) {
            return;
        }

        const original_process_scan =
            scanner.process_scan;

        scanner.process_scan =
            function () {
                const me = this;

                return new Promise(
                    function (
                        resolve,
                        reject
                    ) {
                        const input =
                            me.scan_barcode_field.value;

                        me.scan_barcode_field.set_value(
                            ""
                        );

                        if (!input) {
                            resolve();
                            return;
                        }

                        me.scan_api_call(
                            input,
                            function (r) {
                                const data =
                                    r &&
                                    r.message;

                                // ------------------------------------------------
                                // Normal ERPNext behavior
                                // ------------------------------------------------

                                if (
                                    !data ||
                                    Object.keys(data).length ===
                                        0
                                ) {
                                    me.show_alert(
                                        me.has_last_scanned_warehouse
                                            ? __(
                                                  "Cannot find Item or Warehouse with this Barcode"
                                              )
                                            : __(
                                                  "Cannot find Item with this Barcode"
                                              ),
                                        "red"
                                    );

                                    me.clean_up();

                                    me.play_fail_sound();

                                    reject();

                                    return;
                                }

                                // ------------------------------------------------
                                // Warehouse scan
                                // ------------------------------------------------

                                if (data.warehouse) {
                                    me.handle_warehouse_scan(
                                        data
                                    );

                                    me.play_success_sound();

                                    resolve();

                                    return;
                                }

                                // =================================================
                                // VARIANT SELECTION
                                // =================================================

                                const variants =
                                    data.variant_selection ||
                                    [];

                                if (
                                    variants.length >
                                    1
                                ) {
                                    show_variant_dialog(
                                        me,
                                        data,
                                        variants,
                                        input,
                                        resolve,
                                        reject
                                    );

                                    return;
                                }

                                // ------------------------------------------------
                                // One variant:
                                // automatically use it.
                                // No variant popup necessary.
                                // ------------------------------------------------

                                if (
                                    variants.length ===
                                    1
                                ) {
                                    data.item_code =
                                        variants[0]
                                            .item_code;

                                    delete data.variant_selection;
                                }

                                // ------------------------------------------------
                                // Normal ERPNext update
                                // ------------------------------------------------

                                delete data.variant_selection;

                                me.update_table(
                                    data
                                )
                                    .then(
                                        function (
                                            row
                                        ) {
                                            me.play_success_sound();

                                            resolve(
                                                row
                                            );
                                        }
                                    )
                                    .catch(
                                        function () {
                                            me.play_fail_sound();

                                            reject();
                                        }
                                    );
                            }
                        );
                    }
                );
            };

        scanner.__styleTone_variant_scan_patched =
            true;
    }

    // ============================================================
    // VARIANT POPUP
    // ============================================================

    function show_variant_dialog(
        scanner,
        data,
        variants,
        barcode,
        resolve,
        reject
    ) {
        const options =
            variants.map(
                function (variant) {
                    return (
                        variant.item_code +
                        " - " +
                        (variant.item_name || "")
                    );
                }
            );

        const option_map = {};

        variants.forEach(
            function (variant) {
                option_map[
                    variant.item_code +
                        " - " +
                        (variant.item_name || "")
                ] =
                    variant.item_code;
            }
        );

        const dialog =
            new frappe.ui.Dialog({
                title:
                    __("Select Variant"),

                fields: [
                    {
                        fieldtype:
                            "Select",

                        fieldname:
                            "variant",

                        label:
                            __("Variant"),

                        options:
                            options.join("\n"),

                        reqd: 1
                    }
                ],

                primary_action_label:
                    __("Select"),

                primary_action:
                    function (
                        values
                    ) {
                        const item_code =
                            option_map[
                                values.variant
                            ];

                        if (!item_code) {
                            return;
                        }

                        dialog.hide();

                        const new_data =
                            Object.assign(
                                {},
                                data,
                                {
                                    item_code:
                                        item_code,

                                    barcode:
                                        barcode
                                }
                            );

                        delete new_data.variant_selection;

                        scanner
                            .update_table(
                                new_data
                            )
                            .then(
                                function (
                                    row
                                ) {
                                    scanner.play_success_sound();

                                    resolve(
                                        row
                                    );
                                }
                            )
                            .catch(
                                function () {
                                    scanner.play_fail_sound();

                                    reject();
                                }
                            );
                    }
            });

        dialog.show();
    }

    // ============================================================
    // START INSTALL
    // ============================================================

    if (install()) {
        return;
    }

    // Short startup retry only.
    // This is NOT item polling.
    let attempts = 0;

    const timer =
        setInterval(
            function () {
                attempts++;

                if (
                    install() ||
                    attempts >= 20
                ) {
                    clearInterval(timer);
                }
            },
            250
        );
})();