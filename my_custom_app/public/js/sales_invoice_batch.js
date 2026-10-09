
/*
 * ================================================================
 * SALES INVOICE - MANUAL BATCH + VARIANT SELECTOR
 * ERPNext v16
 *
 * Standard Desk Sales Invoice only.
 * POS / POS Next is not modified.
 *
 * Features:
 * 1. Barcode lookup
 * 2. Template barcode -> Variant popup
 * 3. Variant -> normal ERPNext item processing
 * 4. Batch-tracked item -> Batch popup
 * 5. Popup displays Batch No and Expiry Date
 * 6. Only batches with positive available stock
 * 7. No quantity column
 * 8. Selected batch fills the correct invoice row
 * ================================================================
 */

(function () {
    "use strict";

    // ------------------------------------------------------------
    // Prevent duplicate installation
    // ------------------------------------------------------------

    if (window.__styleToneSalesInvoiceBatchFinal) {
        return;
    }

    // Prevent opening more than one popup for the same row.
    const pending_batch_rows = new Set();

    // ============================================================
    // CHECK WHETHER BATCH DIALOG IS REQUIRED
    // ============================================================

    async function check_batch_required(frm, item) {
        if (
            !frm ||
            !item ||
            !item.item_code ||
            frm.doc.doctype !== "Sales Invoice" ||
            frm.doc.is_pos ||
            item.batch_no
        ) {
            return false;
        }

        try {
            // Check the Item master. The Sales Invoice row may not
            // contain has_batch_no after barcode processing.
            const r = await frappe.db.get_value(
                "Item",
                item.item_code,
                "has_batch_no"
            );

            return !!(
                r &&
                r.message &&
                r.message.has_batch_no
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
    // BATCH DIALOG
    // ============================================================

    function show_batch_dialog(frm, item) {
        if (!frm || !item || !item.item_code) {
            return;
        }

        // --------------------------------------------------------
        // Prevent duplicate dialogs for the same row
        // --------------------------------------------------------

        const row_key = item.name || item.item_code;

        if (pending_batch_rows.has(row_key)) {
            return;
        }

        pending_batch_rows.add(row_key);

        // --------------------------------------------------------
        // Warehouse
        // --------------------------------------------------------

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

        // --------------------------------------------------------
        // Retrieve available batches
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
                const batches = r.message || [];

                // ------------------------------------------------
                // Find the actual row again
                // ------------------------------------------------

                const row = frm.doc.items.find(function (d) {
                    return d.name === item.name;
                });

                if (!row) {
                    pending_batch_rows.delete(row_key);
                    return;
                }

                // Another action may have selected a batch already.
                if (row.batch_no) {
                    pending_batch_rows.delete(row_key);
                    return;
                }

                // ------------------------------------------------
                // No available batches
                // ------------------------------------------------

                if (!batches.length) {
                    pending_batch_rows.delete(row_key);

                    frappe.msgprint({
                        title: __("No Available Batch"),
                        message: __(
                            "No positive-stock batch is available for {0} in warehouse {1}.",
                            [row.item_code, warehouse]
                        ),
                        indicator: "orange"
                    });

                    return;
                }

                // ------------------------------------------------
                // Build popup table
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
                    const batch_no =
                        frappe.utils.escape_html(
                            String(batch.batch_no || "")
                        );

                    const expiry_date = batch.expiry_date
                        ? frappe.datetime.str_to_user(
                            batch.expiry_date
                        )
                        : "";

                    html += `
                        <tr
                            class="style-tone-batch-row"
                            data-index="${index}"
                            style="cursor:pointer;"
                        >
                            <td class="text-center">
                                <input
                                    type="radio"
                                    name="style-tone-batch"
                                    value="${index}"
                                >
                            </td>
                            <td>${batch_no}</td>
                            <td>${frappe.utils.escape_html(
                                String(expiry_date)
                            )}</td>
                        </tr>
                    `;
                });

                html += `
                            </tbody>
                        </table>
                    </div>
                `;

                // ------------------------------------------------
                // Create dialog
                // ------------------------------------------------

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
                                'input[name="style-tone-batch"]:checked'
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

                        // ----------------------------------------
                        // Verify that the row still exists
                        // ----------------------------------------

                        const current_row = frm.doc.items.find(
                            function (d) {
                                return d.name === item.name;
                            }
                        );

                        if (!current_row) {
                            dialog.hide();
                            pending_batch_rows.delete(row_key);
                            return;
                        }

                        try {
                            // ------------------------------------
                            // Set batch in the actual child row
                            // ------------------------------------

                            await frappe.model.set_value(
                                current_row.doctype,
                                current_row.name,
                                "batch_no",
                                selected_batch.batch_no
                            );

                            frm.refresh_field("items");

                            dialog.hide();
                            pending_batch_rows.delete(row_key);
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

                // ------------------------------------------------
                // Row click selects radio
                // ------------------------------------------------

                dialog.$wrapper.on(
                    "click",
                    ".style-tone-batch-row",
                    function () {
                        const index = $(this).attr("data-index");

                        dialog.$wrapper
                            .find(
                                'input[name="style-tone-batch"]'
                            )
                            .prop("checked", false);

                        dialog.$wrapper
                            .find(
                                'input[name="style-tone-batch"][value="' +
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

                console.error(
                    "Batch lookup failed:",
                    error
                );

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
    // OPEN BATCH DIALOG AFTER ROW CREATION
    // ============================================================

    function schedule_batch_dialog(frm, row) {
        if (!frm || !row || !row.item_code) {
            return;
        }

        setTimeout(async function () {
            try {
                // Find the current row in case the table changed.
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
        const options = variants.map(function (variant) {
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

        const dialog = new frappe.ui.Dialog({
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

            primary_action_label: __("Select"),

            primary_action: function (values) {
                const item_code = option_map[values.variant];

                if (!item_code) {
                    return;
                }

                dialog.hide();

                const selected_data = Object.assign(
                    {},
                    data,
                    {
                        item_code: item_code,
                        barcode: barcode
                    }
                );

                delete selected_data.variants;
                delete selected_data.has_variants;
                delete selected_data.is_variant;

                scanner.update_table(selected_data)
                    .then(function (row) {
                        scanner.play_success_sound();

                        // Resolve ERPNext's scan operation.
                        resolve(row);

                        // Open batch popup after row creation.
                        schedule_batch_dialog(
                            scanner.frm,
                            row
                        );
                    })
                    .catch(function (error) {
                        scanner.play_fail_sound();
                        reject(error);
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

                    freeze: false,

                    callback: function (r) {
                        const data = r.message || {};

                        // No custom barcode match:
                        // use ERPNext's original scanner.
                        if (!data.item_code) {
                            me.scan_barcode_field.set_value(input);

                            original_process_scan
                                .apply(me)
                                .then(resolve)
                                .catch(reject);

                            return;
                        }

                        const variants = data.variants || [];

                        // Multiple variants: ask the user.
                        if (variants.length > 1) {
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

                        // Exactly one variant.
                        if (variants.length === 1) {
                            data.item_code =
                                variants[0].item_code;
                        }

                        delete data.variants;
                        delete data.has_variants;
                        delete data.is_variant;

                        // Use normal ERPNext item processing.
                        me.update_table(data)
                            .then(function (row) {
                                me.play_success_sound();

                                resolve(row);

                                schedule_batch_dialog(
                                    me.frm,
                                    row
                                );
                            })
                            .catch(function (error) {
                                me.play_fail_sound();
                                reject(error);
                            });
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

                // The scanner may be created after setup.
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
                    "ERPNext batch-selector method was not found; barcode popup handling remains installed."
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
