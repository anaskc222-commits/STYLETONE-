// Copyright (c) 2026, Style Tone and contributors
// For license information, please see license.txt

Frappe.provide("my_custom_app.store_day_book");

frappe.pages["store-day-book"].on_page_load = function (wrapper) {
        const page = frappe.ui.make_app_page({
                parent: wrapper,
                title: __("Store Day Book"),
                single_column: true,
        });

        wrapper.store_day_book = new my_custom_app.store_day_book.StoreDayBook(page);
};

frappe.pages["store-day-book"].on_page_show = function (wrapper) {
        const day_book = wrapper.store_day_book;
        if (!day_book) return;

        if (day_book.first_show) {
                day_book.first_show = false;
                return;
        }
        day_book.refresh();
};

my_custom_app.store_day_book.PRESETS = [
        { key: "today", label: __("Today") },
        { key: "yesterday", label: __("Yesterday") },
        { key: "this_week", label: __("This Week") },
        { key: "this_month", label: __("This Month") },
        { key: "last_month", label: __("Last Month") },
        { key: "this_year", label: __("This Year") },
];

my_custom_app.store_day_book.StoreDayBook = class StoreDayBook {
        constructor(page) {
                this.page = page;
                this.controls = {};
                this.charts = {};
                this.request_id = 0;
                this.first_show = true;

                this.make();
                this.refresh();
        }

        make() {
                this.$container = $('<div class="store-day-book"></div>').appendTo(this.page.main);
                
                this.make_actions();
                this.make_filters();

                this.$body = $('<div class="sdb-body"></div>').appendTo(this.$container);
                this.$kpis = $('<div class="sdb-kpi-grid"></div>').appendTo(this.$body);
                this.$charts = $('<div class="sdb-chart-grid"></div>').appendTo(this.$body);
                this.$analysis = $('<div class="sdb-chart-grid sdb-analysis"></div>').appendTo(this.$body);
                this.$expenses = $('<div class="sdb-card sdb-expenses"></div>').appendTo(this.$body);
                this.$ledger = $('<div class="sdb-card sdb-ledger"></div>').appendTo(this.$body);
                this.$shifts = $('<div class="sdb-card sdb-shifts"></div>').appendTo(this.$body);
        }

        make_actions() {
                this.page.set_primary_action(__("Refresh"), () => this.refresh(), "refresh");
                this.page.add_menu_item(__("Export Day Book (CSV)"), () => this.export_ledger());
                this.page.add_menu_item(__("Export POS Expenses (CSV)"), () => this.export_expenses());
                this.page.add_menu_item(__("Print Report"), () => window.print());
        }

        make_filters() {
                const $card = $(`
                        <div class="sdb-card sdb-filters">
                                <div class="sdb-filter-grid"></div>
                                <div class="sdb-preset-row"></div>
                        </div>
                `).appendTo(this.$container);

                const $grid = $card.find(".sdb-filter-grid");
                const refresh = frappe.utils.debounce(() => this.refresh(), 250);

                const is_unrestricted = frappe.user.has_role(["System Manager", "Accounts Manager"]);
                let min_allowed_date = null;
                let max_allowed_date = null;

                if (!is_unrestricted) {
                        min_allowed_date = moment().subtract(1, "months").startOf("month").format("YYYY-MM-DD");
                        max_allowed_date = moment().endOf("month").format("YYYY-MM-DD");
                }

                const fields = [
                        {
                                fieldtype: "Date",
                                fieldname: "from_date",
                                label: __("From Date"),
                                default: frappe.datetime.get_today(),
                                min_date: min_allowed_date,
                                max_date: max_allowed_date,
                        },
                        {
                                fieldtype: "Date",
                                fieldname: "to_date",
                                label: __("To Date"),
                                default: frappe.datetime.get_today(),
                                min_date: min_allowed_date,
                                max_date: max_allowed_date,
                        },
                        {
                                fieldtype: "Link",
                                fieldname: "company",
                                label: __("Company"),
                                options: "Company",
                                default: frappe.defaults.get_user_default("company"),
                        },
                        {
                                fieldtype: "Link",
                                fieldname: "cost_center",
                                label: __("Cost Center"),
                                options: "Cost Center",
                                get_query: () => {
                                        const company = this.get_value("company");
                                        return { filters: company ? { company: company } : {} };
                                },
                        },
                        {
                                fieldtype: "Link",
                                fieldname: "pos_profile",
                                label: __("POS Profile"),
                                options: "POS Profile",
                        },
                        {
                                fieldtype: "Link",
                                fieldname: "cashier",
                                label: __("Cashier"),
                                options: "User",
                        },
                        {
                                fieldtype: "Link",
                                fieldname: "shift",
                                label: __("Shift"),
                                options: "POS Closing Shift",
                        },
                        {
                                fieldtype: "Link",
                                fieldname: "mode_of_payment",
                                label: __("Mode of Payment"),
                                options: "Mode of Payment",
                        },
                        {
                                fieldtype: "Check",
                                fieldname: "pos_only",
                                label: __("POS Transactions Only"),
                                default: 1,
                        },
                ];

                fields.forEach((df) => {
                        const $slot = $('<div class="sdb-filter"></div>').appendTo($grid);
                        this.controls[df.fieldname] = frappe.ui.form.make_control({
                                df: Object.assign({}, df, {
                                        onchange: () => {
                                                if (!is_unrestricted && (df.fieldname === "from_date" || df.fieldname === "to_date")) {
                                                        this.enforce_two_month_limit(df.fieldname);
                                                }
                                                if (df.fieldname === "from_date" || df.fieldname === "to_date") {
                                                        this.sync_active_preset();
                                                }
                                                refresh();
                                        },
                                }),
                                parent: $slot,
                                render_input: true,
                        });
                        if (df.default !== undefined) {
                                this.controls[df.fieldname].set_value(df.default);
                        }
                });

                this.make_presets($card.find(".sdb-preset-row"));
        }

        make_presets($row) {
                my_custom_app.store_day_book.PRESETS.forEach((preset) => {
                        $(`<button class="btn btn-xs sdb-preset" data-preset="${preset.key}">${preset.label}</button>`)
                                .appendTo($row)
                                .on("click", () => this.apply_preset(preset.key));
                });
                this.apply_preset("today", true);
        }

        preset_range(key) {
                const day = (m) => m.format("YYYY-MM-DD");
                switch (key) {
                        case "yesterday": {
                                const d = day(moment().subtract(1, "days"));
                                return { from_date: d, to_date: d };
                        }
                        case "this_week":
                                return {
                                        from_date: day(moment().startOf("week")),
                                        to_date: day(moment().endOf("week")),
                                };
                        case "this_month":
                                return {
                                        from_date: day(moment().startOf("month")),
                                        to_date: day(moment().endOf("month")),
                                };
                        case "last_month": {
                                const m = moment().subtract(1, "months");
                                return {
                                        from_date: day(m.clone().startOf("month")),
                                        to_date: day(m.clone().endOf("month")),
                                };
                        }
                        case "this_year":
                                return {
                                        from_date: day(moment().startOf("year")),
                                        to_date: day(moment().endOf("year")),
                                };
                        default: {
                                const d = day(moment());
                                return { from_date: d, to_date: d };
                        }
                }
        }

        apply_preset(key, silent) {
                const range = this.preset_range(key);
                this.controls.from_date.set_value(range.from_date);
                this.controls.to_date.set_value(range.to_date);
                this.sync_active_preset();

                if (!silent) {
                        this.refresh();
                }
        }

        sync_active_preset() {
                const from_date = this.get_value("from_date");
                const to_date = this.get_value("to_date");

                const match = my_custom_app.store_day_book.PRESETS.find((preset) => {
                        const range = this.preset_range(preset.key);
                        return range.from_date === from_date && range.to_date === to_date;
                });

                this.$container.find(".sdb-preset").removeClass("active");
                if (match) {
                        this.$container.find(`.sdb-preset[data-preset="${match.key}"]`).addClass("active");
                }
        }

        enforce_two_month_limit(changed_field) {
                const min_allowed = moment().subtract(1, "months").startOf("month");
                const max_allowed = moment().endOf("month");

                const current_val = this.controls[changed_field].get_value();
                if (!current_val) return;

                const selected_moment = moment(current_val);

                if (selected_moment.isBefore(min_allowed)) {
                        frappe.msgprint(__("Selection is restricted to This Month and Last Month only."));
                        this.controls[changed_field].set_value(min_allowed.format("YYYY-MM-DD"));
                } else if (selected_moment.isAfter(max_allowed)) {
                        frappe.msgprint(__("Selection is restricted to This Month and Last Month only."));
                        this.controls[changed_field].set_value(max_allowed.format("YYYY-MM-DD"));
                }
        }

        get_value(fieldname) {
                const control = this.controls[fieldname];
                return control ? control.get_value() : null;
        }

        get_filters() {
                const filters = {};
                Object.keys(this.controls).forEach((fieldname) => {
                        const value = this.get_value(fieldname);
                        if (value !== null && value !== undefined && value !== "") {
                                filters[fieldname] = value;
                        }
                });
                filters.pos_only = cint(this.get_value("pos_only"));
                return filters;
        }

        refresh() {
                if (!this.controls.from_date) return;
                const request_id = ++this.request_id;

                frappe.call({
                        method: "my_custom_app.dashboard.get_store_day_book",
                        args: { filters: this.get_filters() },
                        freeze: true,
                        freeze_message: __("Crunching store metrics..."),
                }).then((r) => {
                        if (request_id !== this.request_id || !r.message) return;
                        this.render(r.message);
                });
        }

        render(data) {
                this.data = data;
                this.currency = data.meta.currency;

                this.render_kpis(data.kpis);
                this.render_charts(data);
                this.render_analysis(data);
                this.render_expenses(data.expenses);
                this.render_ledger(data.ledger);
                this.render_shifts(data.shifts);
        }

        render_kpis(kpis) {
                this.$kpis.empty();

                kpis.forEach((kpi) => {
                        const $tile = $(`
                                <div class="sdb-kpi sdb-tone-${kpi.tone}" data-key="${kpi.key}">
                                        <div class="sdb-kpi-label">${frappe.utils.escape_html(kpi.label)}</div>
                                        <div class="sdb-kpi-value">${this.format_value(kpi.value, kpi.fieldtype)}</div>
                                        <div class="sdb-kpi-delta">${this.delta_html(kpi)}</div>
                                </div>
                        `).appendTo(this.$kpis);

                        $tile.on("click", () => this.drill_down(kpi.key));
                });
        }

        delta_html(kpi) {
                if (kpi.delta_pct === null || kpi.delta_pct === undefined) {
                        return `<span class="sdb-delta-flat">${__("No prior period")}</span>`;
                }

                const up = kpi.delta_pct >= 0;
                const cls = up ? "sdb-delta-up" : "sdb-delta-down";
                const arrow = up ? "&#9650;" : "&#9660;";

                return `<span class="${cls}">${arrow} ${Math.abs(kpi.delta_pct).toFixed(1)}%</span>
                        <span class="sdb-delta-prev">${__("vs")} ${this.format_value(kpi.prev_value, kpi.fieldtype)}</span>`;
        }

        format_value(value, fieldtype) {
                if (fieldtype === "Currency") {
                        return format_currency(value, this.currency);
                }
                if (fieldtype === "Int") {
                        return format_number(value, null, 0);
                }
                return format_number(value, null, 2);
        }

        drill_down(key) {
                const filters = this.get_filters();
                const route_filters = {
                        docstatus: 1,
                        posting_date: ["between", [filters.from_date, filters.to_date]],
                };

                if (filters.pos_only) route_filters.is_pos = 1;
                if (filters.company) route_filters.company = filters.company;
                if (filters.cost_center) route_filters.cost_center = filters.cost_center;
                if (filters.pos_profile) route_filters.pos_profile = filters.pos_profile;
                if (filters.cashier) route_filters.owner = filters.cashier;

                if (key === "returns_amount" || key === "return_count") {
                        route_filters.is_return = 1;
                } else if (key === "gross_sales" || key === "invoice_count") {
                        route_filters.is_return = 0;
                } else if (key === "outstanding") {
                        route_filters.status = ["in", ["Unpaid", "Overdue", "Partly Paid"]];
                } else if (key === "purchase") {
                        frappe.set_route("List", "Purchase Invoice", {
                                docstatus: 1,
                                posting_date: ["between", [filters.from_date, filters.to_date]],
                        });
                        return;
                } else if (key === "pos_expense") {
                        frappe.set_route("List", "Journal Entry", {
                                docstatus: 1,
                                custom_created_from_pos: 1,
                                posting_date: ["between", [filters.from_date, filters.to_date]],
                        });
                        return;
                }

                frappe.set_route("List", "Sales Invoice", route_filters);
        }

        render_charts(data) {
                this.$charts.empty();
                this.charts = {};

                const has_sales = data.kpis.some((k) => k.key === "net_sales" && k.value) || data.ledger.rows.length;

                if (!has_sales) {
                        this.$charts.append(`
                                <div class="sdb-card sdb-empty sdb-span-2">
                                        <div class="sdb-empty-title">${__("No transactions for the selected filters")}</div>
                                        <div class="sdb-empty-hint">${__("Try widening the date range or clearing a filter.")}</div>
                                </div>
                        `);
                        return;
                }

                this.make_chart("trend", __("Sales, Returns & Net"), "sdb-span-2", {
                        data: {
                                labels: data.trend.labels,
                                datasets: data.trend.datasets,
                        },
                        type: "axis-mixed",
                        height: 280,
                        colors: ["#28a745", "#dc3545", "#2490ef"],
                        axisOptions: { xIsSeries: true, shortenYAxisNumbers: 1 },
                        lineOptions: { hideDots: data.trend.labels.length > 40 ? 1 : 0, regionFill: 0 },
                        tooltipOptions: {
                                formatTooltipY: (value) => format_currency(value, this.currency),
                        },
                });

                this.make_chart("payments", __("Payment Split"), "", {
                        data: {
                                labels: data.payments.map((p) => p.label),
                                datasets: [{ values: data.payments.map((p) => p.value) }],
                        },
                        type: "donut",
                        height: 260,
                        maxSlices: 8,
                        tooltipOptions: {
                                formatTooltipY: (value) => format_currency(value, this.currency),
                        },
                });

                this.make_chart("cashiers", __("Sales by Cashier"), "", {
                        data: {
                  