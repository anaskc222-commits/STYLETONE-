/* STYLETONE - ERPNext v16 Quotation Barcode / Batch / Price
*

* Barcode -> variant selection (if template)
*      -> batch selection (if batch-tracked)
*      -> ERPNext standard item details
*      -> exact batch Item Price
*      -> blank-batch Item Price fallback
*      -> zero if no matching Item Price exists
*      -> add/update Quotation Item
* 
* Quotation Item batch field: custom_batch_no
* Item Price batch field:     batch_no
* 
* No ERPNext core changes.
* Quotation only; does not handle Sales Invoice or POS Next.
  */

(() => {
"use strict";

const PREFIX = "[STYLETONE Quotation Batch]";
const PATCH_FLAG = "__styleToneQuotationBatchV15";

const SCAN_METHOD =
    "my_custom_app.quotation_batch.scan_barcode_with_variants";

const BATCH_METHOD =
    "my_custom_app.quotation_batch.get_available_batches";

const PRICE_METHOD =
    "my_custom_app.quotation_batch.get_batch_item_price";

const DETAILS_METHOD =
    "erpnext.stock.get_item_details.get_item_details";

const BATCH_FIELD = "custom_batch_no";

let processing = false;

// ---------------------------------------------------------
// HELPERS
// ---------------------------------------------------------

function supported(frm) {
    return Boolean(
        frm &&
        frm.doc &&
        frm.doc.doctype === "Quotation"
    );
}

function getWarehouse(frm) {
    return (
        frm.doc.custom_warehouse ||
        frm.doc.set_warehouse ||
        frappe.defaults.get_user_default("Warehouse") ||
        ""
    );
}

function getBarcodeValue(value) {
    if (typeof value === "string") {
        return value.trim();
    }

    if (value && typeof value === "object") {
        return String(
            value.barcode ||
            value.value ||
            value.text ||
            value.decodedText ||
            ""
        ).trim();
    }

    return "";
}

function esc(value) {
    return frappe.utils.escape_html(String(value ?? ""));
}

function showError(error) {
    console.error(PREFIX, error);

    let message =
        error?.message ||
        (typeof error === "string" ? error : null) ||
        __("Barcode processing failed.");

    try {
        const serverMessages = error?._server_messages;

        if (serverMessages) {
            const parsed = JSON.parse(serverMessages);
            if (Array.isArray(parsed) && parsed.length) {
                message = parsed
                    .map((entry) => {
                        try {
                            return JSON.parse(entry).message || entry;
                        } catch {
                            return entry;
                        }
                    })
                    .join("<br>");
            }
        }
    } catch {
        // Keep the original error message.
    }

    frappe.msgprint({
        title: __("Quotation Barcode / Batch Error"),
        indicator: "red",
        message: esc(message)
    });
}

function notify(message, indicator = "green") {
    frappe.show_alert({
        message: __(message),
        indicator
    });
}

function serverCall(method, args) {
    return frappe.call({
        method,
        args,
        freeze: false
    }).then((response) => {
        if (response?.exc) {
            throw new Error(
                response._server_messages ||
                __("The server request failed.")
            );
        }

        return response?.message;
    });
}

function getCustomer(frm) {
    return frm.doc.quotation_to === "Customer"
        ? frm.doc.party_name || ""
        : "";
}

function getSellingPriceList(frm) {
    return frm.doc.selling_price_list || "";
}

function getPriceListRate(priceResult) {
    if (!priceResult || priceResult.found !== true) {
        return 0;
    }

    const rate = Number(priceResult.price_list_rate);

    return Number.isFinite(rate) && rate >= 0 ? rate : 0;
}

// ---------------------------------------------------------
// TABLE SELECTION DIALOG
// ---------------------------------------------------------

function selectFromTable(title, rows, columns) {
    return new Promise((resolve) => {
        if (!Array.isArray(rows) || !rows.length) {
            resolve(null);
            return;
        }

        let finished = false;

        function finish(value) {
            if (finished) return;
            finished = true;
            resolve(value);
        }

        const dialog = new frappe.ui.Dialog({
            title: __(title),
            size: "large",
            fields: [
                {
                    fieldname: "selection_table",
                    fieldtype: "HTML"
                }
            ]
        });

        const headers = columns.map((column) =>
            `<th>${esc(column.label)}</th>`
        ).join("");

        const body = rows.map((row, index) => {
            const cells = columns.map((column) => {
                let value = row[column.field];

                if (column.field === "has_batch_no") {
                    value = Number(value) === 1
                        ? __("Yes")
                        : __("No");
                }

                return `<td>${esc(
                    value === null ||
                    value === undefined ||
                    value === ""
                        ? "-"
                        : value
                )}</td>`;
            }).join("");

            return `
                <tr>
                    <td>
                        <button
                            type="button"
                            class="btn btn-primary btn-xs st-select"
                            data-index="${index}">
                            ${__("Select")}
                        </button>
                    </td>
                    ${cells}
                </tr>
            `;
        }).join("");

        const html = `
            <div class="table-responsive"
                 style="max-height:55vh;overflow:auto;">
                <table class="table table-bordered table-hover">
                    <thead>
                        <tr>
                            <th>${__("Action")}</th>
                            ${headers}
                        </tr>
                    </thead>
                    <tbody>${body}</tbody>
                </table>
            </div>
        `;

        dialog.fields_dict.selection_table.$wrapper.html(html);

        dialog.fields_dict.selection_table.$wrapper.on(
            "click.styleToneQuotation",
            ".st-select",
            function () {
                const index = Number(
                    this.getAttribute("data-index")
                );

                finish(rows[index] || null);
                dialog.hide();
            }
        );

        dialog.$wrapper.on(
            "hidden.bs.modal.styleToneQuotation",
            () => {
                finish(null);
                dialog.$wrapper.off(".styleToneQuotation");
            }
        );

        dialog.show();
    });
}

// ---------------------------------------------------------
// VARIANT PICKER
// ---------------------------------------------------------

async function chooseVariant(response) {
    const variants = response?.variants || [];

    if (!variants.length) {
        notify(
            `No variants with positive available stock were found ` +
            `for ${response?.item_name || response?.item_code}.`,
            "orange"
        );

        return null;
    }

    return selectFromTable(
        __("Select Item Variant"),
        variants,
        [
            {
                field: "item_code",
                label: __("Item Code")
            },
            {
                field: "item_name",
                label: __("Item Name")
            },
            {
                field: "has_batch_no",
                label: __("Batch Tracked")
            },
            {
                field: "available_qty",
                label: __("Available Qty")
            }
        ]
    );
}

// ---------------------------------------------------------
// BATCH PICKER
// ---------------------------------------------------------

async function chooseBatch(frm, itemCode) {
    const warehouse = getWarehouse(frm);

    if (!warehouse) {
        frappe.msgprint(
            __("Select a Warehouse before scanning.")
        );

        return null;
    }

    const batches = await serverCall(BATCH_METHOD, {
        item_code: itemCode,
        warehouse
    });

    if (!Array.isArray(batches) || !batches.length) {
        notify(
            `No positive-quantity batches are available for ${itemCode}.`,
            "orange"
        );

        return null;
    }

    return selectFromTable(
        __("Select Batch"),
        batches,
        [
            {
                field: "batch_no",
                label: __("Batch No")
            },
            {
                field: "expiry_date",
                label: __("Expiry Date")
            },
            {
                field: "available_qty",
                label: __("Available Qty")
            }
        ]
    );
}

// ---------------------------------------------------------
// ERPNext STANDARD ITEM DETAILS
// ---------------------------------------------------------

async function getStandardItemDetails(frm, itemCode, batchNo) {
    const warehouse = getWarehouse(frm);

    const ctx = {
        item_code: itemCode,
        company: frm.doc.company,
        doctype: "Quotation",
        parenttype: "Quotation",
        quotation_to: frm.doc.quotation_to,
        customer: getCustomer(frm),
        transaction_date: frm.doc.transaction_date,
        selling_price_list: getSellingPriceList(frm),
        price_list: getSellingPriceList(frm),
        price_list_currency: frm.doc.price_list_currency,
        currency: frm.doc.currency,
        plc_conversion_rate: frm.doc.plc_conversion_rate || 1,
        conversion_rate: frm.doc.conversion_rate || 1,
        warehouse: warehouse,
        set_warehouse: frm.doc.set_warehouse || warehouse,
        qty: 1,
        batch_no: batchNo || "",
        ignore_pricing_rule: frm.doc.ignore_pricing_rule || 0
    };

    const details = await serverCall(DETAILS_METHOD, {
        ctx: JSON.stringify(ctx),
        doc: JSON.stringify(frm.doc)
    });

    if (!details) {
        throw new Error(
            __("ERPNext returned no item details.")
        );
    }

    if (
        details.item_code &&
        details.item_code !== itemCode
    ) {
        throw new Error(
            __("ERPNext returned details for a different item.")
        );
    }

    return details;
}

// ---------------------------------------------------------
// ITEM PRICE LOOKUP
//
// Python method should search:
// 1. Exact batch Item Price, when a batch is selected.
// 2. Blank-batch Item Price as fallback.
// 3. Return found=false when neither exists.
//
// For non-batch items, batchNo is empty, so only the
// blank-batch Item Price is applicable.
// ---------------------------------------------------------

async function getBatchPrice(frm, itemCode, batchNo, uom) {
    if (!getSellingPriceList(frm)) {
        return {
            found: false,
            price_list_rate: 0,
            reason: "missing_price_list"
        };
    }

    const result = await serverCall(PRICE_METHOD, {
        item_code: itemCode,
        batch_no: batchNo || "",
        price_list: getSellingPriceList(frm),
        transaction_date: frm.doc.transaction_date,
        customer: getCustomer(frm),
        uom: uom || ""
    });

    return result?.found
        ? result
        : {
            found: false,
            price_list_rate: 0,
            reason: "price_not_found"
        };
}

// ---------------------------------------------------------
// APPLY ERPNext DETAILS TO CHILD ROW
// ---------------------------------------------------------

function applyDetailsToRow(row, details) {
    const meta = frappe.get_meta("Quotation Item");

    const excluded = new Set([
        "doctype",
        "name",
        "parent",
        "parentfield",
        "parenttype",
        "idx",
        "item_code",
        "batch_no",
        BATCH_FIELD
    ]);

    for (const [field, value] of Object.entries(details)) {
        if (excluded.has(field) || value === undefined) {
            continue;
        }

        const df = meta.fields.find(
            (fieldDefinition) =>
                fieldDefinition.fieldname === field
        );

        if (!df) continue;

        row[field] = value;
    }
}

// ---------------------------------------------------------
// SET PRICE AFTER STANDARD DETAILS
// ---------------------------------------------------------

async function applyFinalPrice(row, priceResult) {
    const finalRate = getPriceListRate(priceResult);

    await frappe.model.set_value(
        row.doctype,
        row.name,
        "price_list_rate",
        finalRate
    );

    await frappe.model.set_value(
        row.doctype,
        row.name,
        "rate",
        finalRate
    );

    return finalRate;
}

// ---------------------------------------------------------
// ADD ITEM OR INCREASE MATCHING ROW
// ---------------------------------------------------------

async function addQuotationItem(
    frm,
    itemCode,
    batch,
    details,
    priceResult
) {
    const batchNo = batch?.batch_no || "";
    const warehouse = getWarehouse(frm);
    const meta = frappe.get_meta("Quotation Item");

    const hasBatchField = meta.fields.some(
        (field) => field.fieldname === BATCH_FIELD
    );

    if (batchNo && !hasBatchField) {
        throw new Error(
            `Quotation Item does not have the ${BATCH_FIELD} field.`
        );
    }

    // Same item + same batch + same warehouse reuses the row.
    const existing = (frm.doc.items || []).find((row) =>
        row.item_code === itemCode &&
        String(row[BATCH_FIELD] || "") === String(batchNo) &&
        String(row.warehouse || "") === String(warehouse)
    );

    if (existing) {
        await frappe.model.set_value(
            existing.doctype,
            existing.name,
            "qty",
            Number(existing.qty || 0) + 1
        );

        if (hasBatchField) {
            await frappe.model.set_value(
                existing.doctype,
                existing.name,
                BATCH_FIELD,
                batchNo
            );
        }

        // Always apply the custom price result.
        // If no Item Price was found, final rate is zero.
        await applyFinalPrice(existing, priceResult);

        frm.refresh_field("items");
        frm.dirty();

        return existing;
    }

    // Reuse a genuinely empty row, otherwise create one.
    let row = (frm.doc.items || []).find((child) =>
        !child.item_code &&
        !child[BATCH_FIELD]
    );

    if (!row) {
        row = frm.add_child("items");
    }

    row.item_code = itemCode;

    applyDetailsToRow(row, details);

    // Restore concrete item code and custom values after details.
    row.item_code = itemCode;
    row.qty = 1;
    row.warehouse = warehouse || row.warehouse || "";

    if (hasBatchField) {
        row[BATCH_FIELD] = batchNo;
    }

    // Do not retain the standard rate when custom Item Price
    // lookup found no applicable record.
    const finalRate = getPriceListRate(priceResult);

    row.price_list_rate = finalRate;
    row.rate = finalRate;

    // Keep the custom batch value after applying details.
    if (hasBatchField) {
        row[BATCH_FIELD] = batchNo;
    }

    frm.refresh_field("items");

    if (frm.cscript?.calculate_taxes_and_totals) {
        frm.cscript.calculate_taxes_and_totals();
    } else {
        frm.trigger("calculate_taxes_and_totals");
    }

    frm.dirty();

    return row;
}

// ---------------------------------------------------------
// MAIN BARCODE FLOW
// ---------------------------------------------------------

async function processBarcode(frm, rawBarcode) {
    if (!supported(frm)) return;

    const barcode = getBarcodeValue(rawBarcode);

    if (!barcode || processing) return;

    const warehouse = getWarehouse(frm);

    if (!warehouse) {
        frappe.msgprint(
            __("Select a Warehouse before scanning.")
        );

        return;
    }

    processing = true;

    try {
        const response = await serverCall(SCAN_METHOD, {
            barcode,
            warehouse
        });

        if (!response || response.found !== true) {
            notify(
                response?.message ||
                `No item was found for barcode ${barcode}.`,
                "orange"
            );

            return;
        }

        let chosen;

        if (response.is_template === true) {
            chosen = await chooseVariant(response);

            if (!chosen) return;
        } else {
            chosen = response.item;

            if (!chosen?.item_code) {
                throw new Error(
                    __("Barcode lookup did not return a concrete item.")
                );
            }
        }

        const itemCode = chosen.item_code;

        // Confirm the selected item is a concrete stock item.
        const itemResult = await frappe.db.get_value(
            "Item",
            itemCode,
            [
                "name",
                "disabled",
                "has_variants",
                "variant_of",
                "has_batch_no",
                "is_stock_item"
            ]
        );

        const item = itemResult?.message;

        if (!item || item.disabled) {
            throw new Error(
                `Item ${itemCode} is missing or disabled.`
            );
        }

        if (item.has_variants && !item.variant_of) {
            throw new Error(
                `${itemCode} is a template. Select a concrete variant.`
            );
        }

        if (!item.is_stock_item) {
            throw new Error(
                `${itemCode} is not a stock item.`
            );
        }

        // Only batch-tracked items open the batch picker.
        let selectedBatch = null;

        if (Number(item.has_batch_no) === 1) {
            selectedBatch = await chooseBatch(frm, itemCode);

            if (!selectedBatch) return;
        }

        const batchNo = selectedBatch?.batch_no || "";

        // Fetch standard ERPNext item details for the concrete item.
        const details = await getStandardItemDetails(
            frm,
            itemCode,
            batchNo
        );

        const priceUom =
            details.uom ||
            details.stock_uom ||
            "";

        // Exact batch price -> blank-batch fallback in Python.
        // Non-batch items query blank-batch pricing.
        const priceResult = await getBatchPrice(
            frm,
            itemCode,
            batchNo,
            priceUom
        );

        await addQuotationItem(
            frm,
            itemCode,
            selectedBatch,
            details,
            priceResult
        );

        if (priceResult.found) {
            notify(
                `Added ${itemCode}` +
                (batchNo ? `, batch ${batchNo}` : "") +
                `. Item Price: ${getPriceListRate(priceResult)}.`
            );
        } else {
            notify(
                `Added ${itemCode}` +
                (batchNo ? `, batch ${batchNo}` : "") +
                `. No matching Item Price found; rate set to 0.`,
                "orange"
            );
        }
    } catch (error) {
        showError(error);
    } finally {
        processing = false;
    }
}

// ---------------------------------------------------------
// SCANNER PATCH
//
// Intercepts only Quotation scans. Other doctypes continue
// through ERPNext's original scanner.
//
// Do not also register a custom Quotation scan_barcode
// handler here: that can process the same barcode twice.
// ---------------------------------------------------------

function installScannerPatch() {
    const Scanner = window.erpnext?.utils?.BarcodeScanner;

    if (!Scanner?.prototype) {
        return false;
    }

    const proto = Scanner.prototype;

    if (proto[PATCH_FLAG]) {
        return true;
    }

    const original = proto.process_scan;

    if (typeof original !== "function") {
        return false;
    }

    proto.process_scan = function (...args) {
        const frm = this.frm || window.cur_frm;

        if (!supported(frm)) {
            return original.apply(this, args);
        }

        const barcode =
            getBarcodeValue(args[0]) ||
            getBarcodeValue(frm.doc.scan_barcode);

        if (!barcode) {
            return original.apply(this, args);
        }

        // Clear the field without firing another scan event.
        if (frm.doc.scan_barcode) {
            frm.doc.scan_barcode = "";

            const field = frm.fields_dict?.scan_barcode;

            if (field?.$input) {
                field.$input.val("");
            }
        }

        processBarcode(frm, barcode).catch(showError);

        // Do not pass this Quotation scan to the core handler.
        return Promise.resolve();
    };

    Object.defineProperty(proto, PATCH_FLAG, {
        value: true,
        configurable: false
    });

    console.info(
        `${PREFIX} Quotation scanner connected (V15).`
    );

    return true;
}

// ---------------------------------------------------------
// QUOTATION FORM EVENTS
// ---------------------------------------------------------

frappe.ui.form.on("Quotation", {
    refresh(frm) {
        installScannerPatch();
    }
});

// Manual browser-console test:
// StyleToneQuotationBatch.processBarcode(cur_frm, "BARCODE")
window.StyleToneQuotationBatch = {
    processBarcode,
    installScannerPatch
};

installScannerPatch();

})();