/* STYLETONE - ERPNext v16 Quotation Barcode / Batch / Price
*

* Barcode -> variant selection -> batch selection
* -> ERPNext item details -> batch-specific price lookup
* -> add/update Quotation Item
* 
* Quotation Item batch field: custom_batch_no
* Item Price batch field:     batch_no
* 
* Exact batch price -> blank-batch price -> zero
* Non-batch item -> blank-batch price -> zero
* 
* Quotation only. No ERPNext core changes.
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
    return Boolean(frm?.doc?.doctype === "Quotation");
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

    frappe.msgprint({
        title: __("Quotation Barcode / Batch Error"),
        indicator: "red",
        message: esc(
            error?.message ||
            (typeof error === "string" ? error : null) ||
            __("Barcode processing failed.")
        )
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
// SELECTION TABLE
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

        dialog.fields_dict.selection_table.$wrapper.html(`
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
        `);

        dialog.fields_dict.selection_table.$wrapper.on(
            "click.styleToneQuotationV15",
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
            "hidden.bs.modal.styleToneQuotationV15",
            () => {
                finish(null);
                dialog.$wrapper.off(".styleToneQuotationV15");
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
            `No variants with positive available stock were found for ${
                response?.item_name || response?.item_code || ""
            }.`,
            "orange"
        );

        return null;
    }

    return selectFromTable(
        __("Select Item Variant"),
        variants,
        [
            { field: "item_code", label: __("Item Code") },
            { field: "item_name", label: __("Item Name") },
            { field: "has_batch_no", label: __("Batch Tracked") },
            { field: "available_qty", label: __("Available Qty") }
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
            { field: "batch_no", label: __("Batch No") },
            { field: "expiry_date", label: __("Expiry Date") },
            { field: "available_qty", label: __("Available Qty") }
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
        warehouse,
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

    if (details.item_code && details.item_code !== itemCode) {
        throw new Error(
            __("ERPNext returned details for a different item.")
        );
    }

    return details;
}

// ---------------------------------------------------------
// PRICE LOOKUP
//
// Python must perform:
// 1. Exact batch Item Price.
// 2. Blank-batch Item Price fallback.
// 3. found=false if neither exists.
//
// For non-batch items, batch_no is empty.
// ---------------------------------------------------------

async function getBatchPrice(frm, itemCode, batchNo, uom) {
    const priceList = getSellingPriceList(frm);

    if (!priceList) {
        return {
            found: false,
            price_list_rate: 0
        };
    }

    const result = await serverCall(PRICE_METHOD, {
        item_code: itemCode,
        batch_no: batchNo || "",
        price_list: priceList,
        transaction_date: frm.doc.transaction_date,
        customer: getCustomer(frm),
        uom: uom || ""
    });

    if (!result || result.found !== true) {
        return {
            found: false,
            price_list_rate: 0
        };
    }

    return {
        ...result,
        found: true,
        price_list_rate: Number(result.price_list_rate || 0)
    };
}

// ---------------------------------------------------------
// APPLY STANDARD ITEM DETAILS
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
            (definition) => definition.fieldname === field
        );

        if (df) {
            row[field] = value;
        }
    }
}

// ---------------------------------------------------------
// ENFORCE FINAL PRICE
//
// Called AFTER quantity changes and after standard details.
// Direct assignment after set_value avoids a subsequent
// asynchronous field update leaving a stale batch price.
// ---------------------------------------------------------

async function enforcePrice(row, priceResult) {
    const finalRate = getPriceListRate(priceResult);

    // First update through the model so ERPNext field handlers
    // and dependent values can run.
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

    // Then enforce the selected Item Price result.
    // This prevents a previous standard rate from remaining.
    row.price_list_rate = finalRate;
    row.rate = finalRate;

    return finalRate;
}

// ---------------------------------------------------------
// ADD ITEM OR REUSE SAME ITEM + BATCH + WAREHOUSE ROW
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

    // Match using the concrete item, exact custom batch and warehouse.
    const existing = (frm.doc.items || []).find((row) =>
        row.item_code === itemCode &&
        String(row[BATCH_FIELD] || "") === String(batchNo) &&
        String(row.warehouse || "") === String(warehouse)
    );

    if (existing) {
        // Increase quantity first.
        await frappe.model.set_value(
            existing.doctype,
            existing.name,
            "qty",
            Number(existing.qty || 0) + 1
        );

        // Restore batch value after quantity-triggered updates.
        if (hasBatchField) {
            await frappe.model.set_value(
                existing.doctype,
                existing.name,
                BATCH_FIELD,
                batchNo
            );

            existing[BATCH_FIELD] = batchNo;
        }

        // CRITICAL FIX:
        // Reapply the price fetched for THIS batch on every scan.
        await enforcePrice(existing, priceResult);

        frm.refresh_field("items");
        frm.dirty();

        return existing;
    }

    // Find an empty child row or create a new one.
    let row = (frm.doc.items || []).find((child) =>
        !child.item_code &&
        !child[BATCH_FIELD]
    );

    if (!row) {
        row = frm.add_child("items");
    }

    row.item_code = itemCode;

    applyDetailsToRow(row, details);

    // Restore concrete item and selected warehouse.
    row.item_code = itemCode;
    row.qty = 1;
    row.warehouse = warehouse || row.warehouse || "";

    if (hasBatchField) {
        row[BATCH_FIELD] = batchNo;
    }

    // Always enforce the fetched result. If not found, rate = 0.
    await enforcePrice(row, priceResult);

    // Restore custom batch after all model field updates.
    if (hasBatchField) {
        row[BATCH_FIELD] = batchNo;
    }

    frm.refresh_field("items");

    if (frm.cscript?.calculate_taxes_and_totals) {
        frm.cscript.calculate_taxes_and_totals();
    } else {
        frm.trigger("calculate_taxes_and_totals");
    }

    // Re-enforce after totals calculation as well.
    // This protects the selected price from immediate recalculation.
    await enforcePrice(row, priceResult);

    if (hasBatchField) {
        row[BATCH_FIELD] = batchNo;
    }

    frm.refresh_field("items");
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

    if (!getWarehouse(frm)) {
        frappe.msgprint(
            __("Select a Warehouse before scanning.")
        );
        return;
    }

    processing = true;

    try {
        const response = await serverCall(SCAN_METHOD, {
            barcode,
            warehouse: getWarehouse(frm)
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

        // Validate the concrete selected item.
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

        // Batch popup only for batch-tracked items.
        let selectedBatch = null;

        if (Number(item.has_batch_no) === 1) {
            selectedBatch = await chooseBatch(frm, itemCode);

            if (!selectedBatch) return;
        }

        const batchNo = selectedBatch?.batch_no || "";

        // Fetch standard details for the selected concrete variant.
        const details = await getStandardItemDetails(
            frm,
            itemCode,
            batchNo
        );

        const priceUom =
            details.uom ||
            details.stock_uom ||
            "";

        // Fetch price for the exact selected batch, then fallback.
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
                `. Applied price ${getPriceListRate(priceResult)}.`
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

        // Clear scan input without invoking a second scan.
        if (frm.doc.scan_barcode) {
            frm.doc.scan_barcode = "";

            const field = frm.fields_dict?.scan_barcode;

            if (field?.$input) {
                field.$input.val("");
            }
        }

        processBarcode(frm, barcode).catch(showError);

        // Prevent core scanner from processing this Quotation scan.
        return Promise.resolve();
    };

    Object.defineProperty(proto, PATCH_FLAG, {
        value: true,
        configurable: false
    });

    console.info(`${PREFIX} Quotation scanner connected (V15).`);

    return true;
}

// ---------------------------------------------------------
// QUOTATION FORM EVENTS
// ---------------------------------------------------------

frappe.ui.form.on("Quotation", {
    refresh() {
        installScannerPatch();
    }
});

// Browser-console test:
// StyleToneQuotationBatch.processBarcode(cur_frm, "BARCODE")
window.StyleToneQuotationBatch = {
    processBarcode,
    installScannerPatch
};

installScannerPatch();

})();