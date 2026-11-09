frappe.provide("my_custom_app.store_day_book");

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
        { key: "this_month", label: __("This Month") },
        { key: "last_month", label: __("Last Month") },
];

my_custom_app.store_day_book.StoreDayBook = class StoreDayBook {
        constructor(page) {
                this.page = page;
                this.controls = {};
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
        }

        make_actions() {
                this.page.set_primary_action(__("Refresh"), () => this.refresh(), "refresh");
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
                                                this.sync_active_preset();
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
                const from_date = this.controls.from_date.get_value();
                const to_date = this.controls.to_date.get_value();

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

        get_filters() {
                const filters = {};
                Object.keys(this.controls).forEach((fieldname) => {
                        const value = this.controls[fieldname].get_value();
                        if (value) filters[fieldname] = value;
                });
                return filters;
        }

        refresh() {
                if (!this.controls.from_date) return;
                const request_id = ++this.request_id;

                frappe.call({
                        method: "my_custom_app.dashboard.get_store_day_book",
                        args: { filters: this.get_filters() },
                        freeze: true,
                        freeze_message: __("Loading metrics..."),
                }).then((r) => {
                        if (request_id !== this.request_id || !r.message) return;
                        this.render(r.message);
                });
        }

        render(data) {
                this.$kpis.empty();
                console.log("STYLETONE Day Book Data Loaded:", data);
        }
};
