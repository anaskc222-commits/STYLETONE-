// ================================================================
// SALES INVOICE - MANUAL BATCH + VARIANT SELECTOR
// ERPNext v16
//
// DESK SALES INVOICE ONLY
//
// POS / POS NEXT:
//     NOT MODIFIED
//
// USES ERPNext'S NORMAL ITEM PROCESSING
//
// FEATURES:
//     1. Barcode lookup
//     2. Template barcode -> Variant popup
//     3. Variant -> normal ERPNext item processing
//     4. Batch-controlled item -> Batch popup
//     5. Batch popup shows Batch No + Expiry Date
//     6. Positive-stock batches only
//     7. No quantity column
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
    // BATCH DIALOG
    // ============================================================

    function show_batch_dialog(frm, item) {

        if (!frm || !item || !item.item_code) {
            return;
        }

        // --------------------------------------------------------
        // Warehouse
        // --------------------------------------------------------

        const warehouse =
            item.warehouse ||
            frm.doc.set_warehouse;

        if (!warehouse) {
            frappe.msgprint({
                title: __("Warehouse Required"),
                message: __(
                    "Please select a source warehouse before selecting a batch."
                ),
                indicator: "orange"
            });

            return;
        }

        // --------------------------------------------------------
        // Prevent duplicate calls
        // --------------------------------------------------------

        if (item.__styleTone_batch_loading) {
            return;
        }

        item.__styleTone_batch_loading = true;

        // --------------------------------------------------------
        // Get available batches
        // --------------------------------------------------------

        frappe.call({
            method:
                "my_custom_app.sales_invoice_batch.get_available_batches",

            args: {
                item_code: item.item_code,
                warehouse: warehouse
            },

            freeze: false,

            callback: function (r) {

                item.__styleTone_batch_loading = false;

                const batches = r.message || [];

                // ------------------------------------------------
                // No stock
                // ------------------------------------------------

                if (!batches.length) {

                    frappe.msgprint({
                        title: __("No Available Batch"),
                        message: __(
                            "No positive-stock batch is available for {0} in warehouse {1}.",
                            [
                                item.item_code,
                                warehouse
                            ]
                        ),
                        indicator: "orange"
                    });

                    return;
                }

                // ------------------------------------------------
                // Find current row
                // ------------------------------------------------

                const row =
                    frm.doc.items.find(function (d) {
                        return d.name === item.name;
                    });

                if (!row) {
                    return;
                }

                // ------------------------------------------------
                // Build simple HTML table
                // ------------------------------------------------
                //
                // Using a simple table instead of ERPNext's Grid
                // prevents accidental quantity editing.
                // ------------------------------------------------

                let html = `
                    <div class="style-tone-batch-list">
                        <table class="table table-bordered">
                            <thead>
                                <tr>
                                    <th style="width:55px;"></th>
                                    <th>${__("Batch No")}</th>
                                    <th>${__("Expiry Date")}</th>
                                </tr>
                            </thead>
                            <tbody>
                `;

                batches.forEach(function (batch, index) {

                    html += `
                        <tr
                            class="style-tone-batch-row"
                            data-batch="${frappe.utils.escape_html(batch.batch_no)}"
                            style="cursor:pointer;"
                        >
                            <td class="text-center">
                                <input
                                    type="radio"
                                    name="style-tone-batch"
                                    value="${frappe.utils.escape_html(batch.batch_no)}"
                                    ${index === 0 ? "" : ""}
                                >
                            </td>

                            <td>
                                ${frappe.utils.escape_html(batch.batch_no)}
                            </td>

                            <td>
                                ${batch.expiry_date
                                    ? frappe.datetime.str_to_user(
                                        batch.expiry_date
                                    )
                                    : ""}
                            </td>
                        </tr>
                    `;
                });

                html += `
                            </tbody>
                        </table>
                    </div>
                `;

                // ------------------------------------------------
                // Dialog
                // ------------------------------------------------

                const dialog =
                    new frappe.ui.Dialog({
                        title: __("Select Batch"),

                        fields: [
                            {
                                fieldtype: "HTML",
                                fieldname: "batch_html"
                            }
                        ],

                        primary_action_label:
                            __("Select"),

                        primary_action: function () {

                            const selected =
                                dialog.$wrapper
                                    .find(
                                        'input[name="style-tone-batch"]:checked'
                                    )
                                    .val();

                            if (!selected) {

                                frappe.show_alert({
                                    message:
                                        __("Please select a batch"),
                                    indicator: "orange"
                                });

                                return;
                            }

                            // ------------------------------------
                            // Set batch using ERPNext model
                            // ------------------------------------

                            frappe.model.set_value(
                                row.doctype,
                                row.name,
                                "batch_no",
                                selected
                            );

                            dialog.hide();

                            frm.refresh_field("items");
                        }
                    });

                dialog.fields_dict.batch_html.$wrapper.html(
                    html
                );

                // ------------------------------------------------
                // Row click selects radio
                // ------------------------------------------------

                dialog.$wrapper.on(
                    "click",
                    ".style-tone-batch-row",
                    function () {

                        const batch =
                            $(this).attr("data-batch");

                        dialog.$wrapper
                            .find(
                                'input[name="style-tone-batch"]'
                            )
                            .prop("checked", false);

                        dialog.$wrapper
                            .find(
                                'input[name="style-tone-batch"][value="' +
                                batch.replace(/"/g, '\\"') +
                                '"]'
                            )
                            .prop("checked", true);

                        dialog.$wrapper
                            .find(".style-tone-batch-row")
                            .css(
                                "background-color",
                                ""
                            );

                        $(this).css(
                            "background-color",
                            "var(--subtle-fg)"
                        );
                    }
                );

                dialog.show();
            },

            error: function () {

                item.__styleTone_batch_loading = false;

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
    // CHECK WHETHER BATCH DIALOG IS REQUIRED
    // ============================================================

    function check_batch_required(frm, item) {

        if (!frm || !item) {
            return false;
        }

        // Only Sales Invoice
        if (frm.doc.doctype !== "Sales Invoice") {
            return false;
        }

        // Never modify POS
        if (frm.doc.is_pos) {
            return false;
        }

        // Only stock transactions
        if (!frm.doc.update_stock) {
            return false;
        }

        // Batch required
        if (!item.has_batch_no) {
            return false;
        }

        // Serial-only item
        if (
            item.has_serial_no &&
            !item.has_batch_no
        ) {
            return false;
        }

        // Already selected
        if (item.batch_no) {
            return false;
        }

        return true;
    }


    // ============================================================
    // VARIANT DIALOG
    // ============================================================

    function show_variant_dialog(
        scanner,
        barcode,
        data,
        variants,
        resolve,
        reject
    ) {

        const options =
            variants.map(function (variant) {
                return (
                    variant.item_code +
                    " - " +
                    (variant.item_name || "")
                );
            });

        const option_map = {};

        variants.forEach(function (variant) {

            option_map[
                variant.item_code +
                " - " +
                (variant.item_name || "")
            ] = variant.item_code;
        });

        const dialog =
            new frappe.ui.Dialog({

                title: __("Select Variant"),

                fields: [
                    {
                        fieldtype: "Select",

                        fieldname: "variant",

                        label: __("Variant"),

                        options: options.join("\n"),

                        reqd: 1
                    }
                ],

                primary_action_label:
                    __("Select"),

                primary_action: function (values) {

                    const item_code =
                        option_map[values.variant];

                    if (!item_code) {
                        return;
                    }

                    dialog.hide();

                    // ------------------------------------------------
                    // IMPORTANT:
                    //
                    // We now use the selected Variant with ERPNext's
                    // normal item processing.
                    // ------------------------------------------------

                    const selected_data =
                        Object.assign(
                            {},
                            data,
                            {
                                item_code: item_code,
                                barcode: barcode
                            }
                        );

                    // Remove custom-only properties
                    delete selected_data.variants;
                    delete selected_data.has_variants;
                    delete selected_data.is_variant;

                    // ------------------------------------------------
                    // ERPNext normal processing
                    // ------------------------------------------------

                    scanner.update_table(
                        selected_data
                    )
                        .then(function (row) {

                            scanner.play_success_sound();

                            resolve(row);

                            // ------------------------------------------------
                            // Batch popup after row creation
                            // ------------------------------------------------

                            setTimeout(function () {

                                if (
                                    row &&
                                    row.item_code
                                ) {

                                    const frm =
                                        scanner.frm;

                                    if (
                                        check_batch_required(
                                            frm,
                                            row
                                        )
                                    ) {

                                        show_batch_dialog(
                                            frm,
                                            row
                                        );
                                    }
                                }

                            }, 200);

                        })
                        .catch(function () {

                            scanner.play_fail_sound();

                            reject();
                        });
                }
            });

        dialog.show();
    }


    // ============================================================
    // BARCODE PROCESS
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

        if (
            typeof original_process_scan !== "function"
        ) {
            return;
        }

        scanner.process_scan =
            function () {

                const me = this;

                return new Promise(
                    function (resolve, reject) {

                        const input =
                            me.scan_barcode_field.value;

                        me.scan_barcode_field.set_value("");

                        if (!input) {
                            resolve();
                            return;
                        }

                        // ------------------------------------------------
                        // Our custom lookup
                        // ------------------------------------------------

                        frappe.call({

                            method:
                                "my_custom_app.sales_invoice_batch.scan_barcode_with_variants",

                            args: {
                                search_value: input
                            },

                            freeze: false,

                            callback: function (r) {

                                const data =
                                    r.message || {};

                                // ------------------------------------------------
                                // Barcode not found by our lookup
                                //
                                // Fall back to ERPNext's original processing.
                                // ------------------------------------------------

                                if (
                                    !data ||
                                    !data.item_code
                                ) {

                                    // Restore original ERPNext behavior
                                    me.scan_barcode_field.set_value(
                                        input
                                    );

                                    original_process_scan
                                        .apply(me)
                                        .then(resolve)
                                        .catch(reject);

                                    return;
                                }

                                // ------------------------------------------------
                                // Template barcode
                                // ------------------------------------------------

                                const variants =
                                    data.variants || [];

                                if (
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

                                // ------------------------------------------------
                                // Template with exactly one Variant
                                // ------------------------------------------------

                                if (
                                    variants.length === 1
                                ) {

                                    data.item_code =
                                        variants[0].item_code;
                                }

                                // ------------------------------------------------
                                // Normal / Variant barcode
                                //
                                // Remove custom fields.
                                // ------------------------------------------------

                                delete data.variants;
                                delete data.has_variants;
                                delete data.is_variant;

                                // ------------------------------------------------
                                // ERPNext item creation
                                // ------------------------------------------------

                                me.update_table(data)
                                    .then(function (row) {

                                        me.play_success_sound();

                                        resolve(row);

                                        // ------------------------------------------------
                                        // Batch popup
                                        // ------------------------------------------------

                                        setTimeout(function () {

                                            if (
                                                row &&
                                                check_batch_required(
                                                    me.frm,
                                                    row
                                                )
                                            ) {

                                                show_batch_dialog(
                                                    me.frm,
                                                    row
                                                );
                                            }

                                        }, 200);

                                    })
                                    .catch(function () {

                                        me.play_fail_sound();

                                        reject();
                                    });
                            },

                            error: function () {

                                // ------------------------------------------------
                                // If custom method fails,
                                // use ERPNext native scanner.
                                // ------------------------------------------------

                                me.scan_barcode_field.set_value(
                                    input
                                );

                                original_process_scan
                                    .apply(me)
                                    .then(resolve)
                                    .catch(reject);
                            }
                        });
                    }
                );
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

        const Controller =
            erpnext.TransactionController;

        const prototype =
            Controller.prototype;

        if (!prototype) {
            return false;
        }


        // ========================================================
        // SETUP PATCH
        // ========================================================

        if (
            !prototype.__styleTone_original_setup
        ) {

            prototype.__styleTone_original_setup =
                prototype.setup;

            prototype.setup =
                function () {

                    this.__styleTone_original_setup.apply(
                        this,
                        arguments
                    );

                    const frm = this.frm;

                    if (
                        !frm ||
                        frm.doc.doctype !==
                            "Sales Invoice"
                    ) {
                        return;
                    }

                    // Never modify POS
                    if (frm.doc.is_pos) {
                        return;
                    }

                    // ------------------------------------------------
                    // Barcode scanner
                    // ------------------------------------------------

                    if (this.barcode_scanner) {

                        install_barcode_process_scan(
                            this.barcode_scanner
                        );
                    }
                };
        }


        // ========================================================
        // BATCH SELECTION PATCH
        // ========================================================

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

                    const frm = this.frm;

                    // ------------------------------------------------
                    // Only Sales Invoice
                    // ------------------------------------------------

                    if (
                        !frm ||
                        frm.doc.doctype !==
                            "Sales Invoice"
                    ) {

                        return original.apply(
                            this,
                            arguments
                        );
                    }

                    // ------------------------------------------------
                    // Never POS
                    // ------------------------------------------------

                    if (frm.doc.is_pos) {

                        return original.apply(
                            this,
                            arguments
                        );
                    }

                    // ------------------------------------------------
                    // Our batch popup
                    // ------------------------------------------------

                    if (
                        check_batch_required(
                            frm,
                            item
                        )
                    ) {

                        show_batch_dialog(
                            frm,
                            item
                        );

                        return;
                    }

                    // ------------------------------------------------
                    // Everything else = ERPNext
                    // ------------------------------------------------

                    return original.apply(
                        this,
                        arguments
                    );
                };
        }


        // ========================================================
        // INSTALLED
        // ========================================================

        window.__styleToneSalesInvoiceBatchFinal =
            true;

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

    const timer =
        setInterval(function () {

            attempts++;

            if (
                install() ||
                attempts >= 20
            ) {
                clearInterval(timer);
            }

        }, 250);

})();
