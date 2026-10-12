/**
 * output-overview — browser client bundle.
 *
 * Served at /plugins/output-overview/client.js by the web host and loaded
 * through window.__ModuleLoader__ with the host's frozen module table
 * (react resolves through require). Registers one settings.section slot
 * that renders the output statistics panel. Data comes from the host route
 * /output-overview/api/summary via a plain relative fetch (same-origin).
 */
window.__ModuleLoader__.load({ id: "output-overview", factory: (require) => {
	const module = { exports: {} };
	const exports = module.exports;
	const React = require("react");
	const createElement = React.createElement;

	const name = "output-overview";

	/** Resolve the host API base against the document base, mirroring dshmarket. */
	function apiBase() {
		try {
			return new URL("output-overview/api/", document.baseURI).href;
		} catch {
			return "/output-overview/api/";
		}
	}

	async function fetchSummary(params) {
		const url = new URL("summary", apiBase());
		if (params) {
			for (const [k, v] of Object.entries(params)) {
				if (v === undefined || v === null) continue;
				if (Array.isArray(v)) {
					// repeated query params: ?workspace=a&workspace=b
					for (const item of v) {
						if (item !== "" && item !== undefined && item !== null) url.searchParams.append(k, String(item));
					}
					continue;
				}
				if (v !== "") url.searchParams.set(k, String(v));
			}
		}
		const response = await fetch(url, { headers: { accept: "application/json" } });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return response.json();
	}

	const RANGES = [
		{ id: "all", label: "全部时间" },
		{ id: "today", label: "今天" },
		{ id: "7d", label: "最近 7 天" },
		{ id: "30d", label: "最近 30 天" },
		{ id: "custom", label: "自定义范围" },
	];

	const isoDay = (d) => {
		const p = (n) => String(n).padStart(2, "0");
		return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
	};

	/**
	 * Map a range id to the inclusive { from, to } epoch-ms window sent to the
	 * API. "custom" takes YYYY-MM-DD strings (inclusive on both ends: the end
	 * day is extended to 23:59:59.999 local); empty bounds mean open-ended.
	 */
	function rangeWindow(id, customFrom, customTo) {
		const DAY = 86_400_000;
		if (id === "today") {
			const d = new Date();
			d.setHours(0, 0, 0, 0);
			return { from: d.getTime() };
		}
		if (id === "7d") return { from: Date.now() - 7 * DAY };
		if (id === "30d") return { from: Date.now() - 30 * DAY };
		if (id === "custom") {
			const parse = (s, endOfDay) => {
				if (!s) return null;
				const t = Date.parse(endOfDay ? `${s}T23:59:59.999` : `${s}T00:00:00`);
				return Number.isFinite(t) ? t : null;
			};
			let from = parse(customFrom, false);
			let to = parse(customTo, true);
			if (from !== null && to !== null && from > to) [from, to] = [to, from]; // tolerate swapped input
			return { from, to };
		}
		return {};
	}

	const fmt = (n) => (typeof n === "number" ? n.toLocaleString() : "—");
	const pct = (r) => (r === null || r === undefined ? "—" : `${(r * 100).toFixed(1)}%`);
	const money = (n) => {
		if (typeof n !== "number") return "—";
		const abs = Math.abs(n);
		const s = abs >= 1 ? n.toFixed(2) : abs >= 0.01 ? n.toFixed(3) : n.toFixed(4);
		return `$${s}`;
	};

	/**
	 * Native <select> controls do not inherit the app theme (transparent
	 * background + inherited text can render same-on-same). Read the body's
	 * computed colors instead and set an explicit color-scheme so both the
	 * closed control and its popup list match light/dark themes.
	 */
	function themeInfo() {
		try {
			const cs = getComputedStyle(document.body);
			const bg = cs.backgroundColor || "#ffffff";
			const text = cs.color || "#111111";
			const rgb = (bg.match(/\d+(\.\d+)?/g) ?? []).map(Number);
			const [r = 255, g = 255, b = 0] = rgb;
			const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
			return { bg, text, dark: lum < 128 };
		} catch {
			return { bg: "#ffffff", text: "#111111", dark: false };
		}
	}

	const styles = {
		root: { fontFamily: "inherit", fontSize: 13, color: "inherit", padding: "4px 0" },
		headerRow: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12 },
		button: {
			border: "1px solid var(--color-border, #8884)", borderRadius: 6,
			padding: "4px 10px", cursor: "pointer", background: "transparent", color: "inherit", fontSize: 12,
		},
		select: {
			border: "1px solid var(--color-border, #8884)", borderRadius: 6,
			padding: "4px 6px", background: "transparent", color: "inherit", fontSize: 12, maxWidth: 280,
		},
		cards: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 14 },
		card: { border: "1px solid var(--color-border, #8884)", borderRadius: 8, padding: "10px 12px" },
		cardLabel: { fontSize: 11, opacity: 0.65, marginBottom: 4 },
		cardValue: { fontSize: 22, fontWeight: 600, lineHeight: 1.2 },
		cardSub: { fontSize: 11, opacity: 0.7, marginTop: 4 },
		table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
		th: { textAlign: "left", padding: "4px 8px", borderBottom: "1px solid var(--color-border, #8884)", fontWeight: 600, whiteSpace: "nowrap" },
		td: { padding: "4px 8px", borderBottom: "1px solid var(--color-border, #5552)", whiteSpace: "nowrap" },
		tdWrap: { padding: "4px 8px", borderBottom: "1px solid var(--color-border, #5552)" },
		sectionTitle: { fontSize: 13, fontWeight: 600, margin: "14px 0 6px" },
		note: { fontSize: 11, opacity: 0.6, marginTop: 10 },
		error: { color: "#e5484d", padding: "8px 0" },
		cut: { maxWidth: 340, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-block", verticalAlign: "bottom" },
	};

	function StatCard({ label, value, sub }) {
		return createElement("div", { style: styles.card },
			createElement("div", { style: styles.cardLabel }, label),
			createElement("div", { style: styles.cardValue }, value),
			sub ? createElement("div", { style: styles.cardSub }, sub) : null,
		);
	}

	function SummaryPanel() {
		const [data, setData] = React.useState(null);
		const [error, setError] = React.useState(null);
		const [loading, setLoading] = React.useState(true);
		const [workspace, setWorkspace] = React.useState([]); // array: multi-select
		const [subagents, setSubagents] = React.useState("true");
		const [range, setRange] = React.useState("all");
		const [customFrom, setCustomFrom] = React.useState(() => isoDay(new Date(Date.now() - 30 * 86_400_000)));
		const [customTo, setCustomTo] = React.useState(() => isoDay(new Date()));
		const theme = themeInfo();
		const selectStyle = {
			...styles.select,
			color: theme.text,
			background: theme.bg,
			borderColor: theme.dark ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.25)",
			colorScheme: theme.dark ? "dark" : "light",
		};

		const load = React.useCallback(async (opts = {}) => {
			// Keep the previous data on screen while refreshing; only a real
			// failure replaces it with the error view.
			setLoading(true);
			setError(null);
			try {
				const nextRange = opts.range ?? range;
				const win = rangeWindow(
					nextRange,
					opts.customFrom ?? customFrom,
					opts.customTo ?? customTo);
				const payload = await fetchSummary({
					workspace: opts.workspace ?? workspace, // array -> repeated params
					subagents: opts.subagents ?? subagents,
					from: win.from,
					to: win.to,
					refresh: opts.refresh ? "1" : undefined,
				});
				setData(payload);
			} catch (err) {
				setError(String(err?.message ?? err));
			} finally {
				setLoading(false);
			}
		}, [workspace, subagents, range, customFrom, customTo]);

		React.useEffect(() => { load(); }, [load]);

		if (error && !data) {
			return createElement("div", { style: styles.root },
				createElement("div", { style: styles.error }, `加载失败：${error}`),
				createElement("button", { style: styles.button, onClick: () => load() }, "重试"));
		}
		if (!data) {
			return createElement("div", { style: styles.root },
				createElement("div", { style: styles.note }, loading ? "统计计算中…（首次打开需要重放全部会话日志，之后走缓存）" : "暂无数据"));
		}

		const recentDays = [...data.days].slice(-14).reverse();

		return createElement("div", { style: styles.root },
			createElement("div", { style: styles.headerRow },
				// Workspace multi-select: ctrl/cmd-click (or the All toggle) picks
				// several; an empty selection means all workspaces.
				createElement("select", {
					style: { ...selectStyle, height: 64 },
					multiple: true, size: Math.min(6, Math.max(2, data.workspaces?.length ?? 2)),
					value: workspace,
					onChange: (e) => {
						const picked = [...e.target.selectedOptions].map((o) => o.value);
						setWorkspace(picked);
						load({ workspace: picked });
					},
				},
					(data.workspaces ?? []).map((w) => createElement("option", { key: w, value: w }, w))),
				createElement("button", {
					style: styles.button,
					onClick: () => { setWorkspace([]); load({ workspace: [] }); },
				}, workspace.length === 0 ? "全部工作区" : `全部工作区 (已选 ${workspace.length})`),
				createElement("select", {
					style: selectStyle, value: range,
					onChange: (e) => { const v = e.target.value; setRange(v); load({ range: v }); },
				},
					RANGES.map((r) => createElement("option", { key: r.id, value: r.id }, r.label))),
				range === "custom" && createElement("label", { style: { fontSize: 12, display: "flex", alignItems: "center", gap: 4 } },
					"从",
					createElement("input", {
						type: "date", style: selectStyle, value: customFrom,
						onChange: (e) => { const v = e.target.value; setCustomFrom(v); load({ customFrom: v }); },
					})),
				range === "custom" && createElement("label", { style: { fontSize: 12, display: "flex", alignItems: "center", gap: 4 } },
					"到",
					createElement("input", {
						type: "date", style: selectStyle, value: customTo,
						onChange: (e) => { const v = e.target.value; setCustomTo(v); load({ customTo: v }); },
					})),
				createElement("label", { style: { fontSize: 12, display: "flex", alignItems: "center", gap: 4 } },
					createElement("input", {
						type: "checkbox", checked: subagents === "true",
						onChange: (e) => { const v = String(e.target.checked); setSubagents(v); load({ subagents: v }); },
					}), "含子代理"),
				createElement("button", { style: styles.button, onClick: () => load({ refresh: true }) }, loading ? "计算中…" : "刷新"),
				createElement("span", { style: styles.note }, `${data.sessionCount ?? 0} 个会话 · ${data.computeMs ?? 0}ms`)),

			createElement("div", { style: styles.cards },
				createElement(StatCard, {
					label: "生成代码行数",
					value: fmt(data.code?.generatedLines),
					sub: `覆盖 ${fmt(data.code?.fileCount)} 个代码文件`,
				}),
				createElement(StatCard, {
					label: "采纳率（代码存活）",
					value: pct(data.code?.survivalRate),
					sub: `生成 ${fmt(data.code?.generatedLines)} 行中 ${fmt(data.code?.survivingLines)} 行仍留存`,
				}),
				createElement(StatCard, {
					label: "采纳率（工具执行）",
					value: pct(data.adoption?.rate),
					sub: `写入调用成功 ${fmt(data.adoption?.ok)} / 全部 ${fmt(data.adoption?.total)} 次${data.adoption?.failed ? ` · 失败 ${fmt(data.adoption.failed)}` : ""}`,
				}),
				createElement(StatCard, {
					label: "总成本",
					value: money(data.costs?.total),
					sub: data.costs
						? `代码 ${money(data.costs.code)} · 文档 ${money(data.costs.doc)} · 对话开销 ${money(data.costs.overhead)}`
						: "未配置定价",
				}),
				createElement(StatCard, {
					label: "文档",
					value: fmt(data.doc?.docFileCount),
					sub: `共生成 ${fmt(data.doc?.generatedLines)} 行 · 存活 ${pct(data.doc?.survivalRate)}`,
				}),
				createElement(StatCard, {
					label: "总生成行数",
					value: fmt(data.totals?.generatedLines),
					sub: `总存活 ${pct(data.totals?.generatedLines > 0 ? data.totals.survivingLines / data.totals.generatedLines : null)}`,
				})),

			createElement("div", { style: styles.sectionTitle }, "最近 14 天"),
			createElement("table", { style: styles.table },
				createElement("thead", null, createElement("tr", null,
					createElement("th", { style: styles.th }, "日期"),
					createElement("th", { style: styles.th }, "代码行"),
					createElement("th", { style: styles.th }, "文档行"))),
				createElement("tbody", null,
					recentDays.length === 0
						? createElement("tr", null, createElement("td", { style: styles.td, colSpan: 3 }, "暂无记录"))
						: recentDays.map((d) => createElement("tr", { key: d.date },
							createElement("td", { style: styles.td }, d.date),
							createElement("td", { style: styles.td }, fmt(d.codeLines)),
							createElement("td", { style: styles.td }, fmt(d.docLines)))))),

			createElement("div", { style: styles.sectionTitle }, "文件 Top 10（按生成行数）"),
			createElement("table", { style: styles.table },
				createElement("thead", null, createElement("tr", null,
					createElement("th", { style: styles.th }, "文件"),
					createElement("th", { style: styles.th }, "类型"),
					createElement("th", { style: styles.th }, "生成"),
					createElement("th", { style: styles.th }, "存活"),
					createElement("th", { style: styles.th }, "编辑次数"))),
				createElement("tbody", null,
					(data.files ?? []).slice(0, 10).map((f) => createElement("tr", { key: f.path },
						createElement("td", { style: styles.tdWrap, title: f.path },
							createElement("span", { style: styles.cut }, f.path)),
						createElement("td", { style: styles.td }, f.doc ? "文档" : "代码"),
						createElement("td", { style: styles.td }, fmt(f.generated)),
						createElement("td", { style: styles.td }, fmt(f.surviving)),
						createElement("td", { style: styles.td }, fmt(f.ops)))))),

			createElement("div", { style: styles.note },
				`统计范围：${range === "custom"
					? `${customFrom || "最早"} ~ ${customTo || "现在"}`
					: (RANGES.find((r) => r.id === range) ?? RANGES[0]).label} · ${data.includeSubagents ? "含" : "不含"}子代理会话 · ${data.unreadableSessions ? `${data.unreadableSessions} 个会话读取失败 · ` : ""}生成时间 ${new Date(data.generatedAt).toLocaleString()}`),
			data.costs?.pricing && createElement("div", { style: styles.note },
				`成本按轮次归集（${data.costs.pricing.label || "当前模型"}，USD / 1M tokens：输入 ${data.costs.pricing.miss} · 缓存读 ${data.costs.pricing.hit} · 缓存写 ${data.costs.pricing.write} · 输出 ${data.costs.pricing.out}）· 有用量的轮次 ${data.costs.turnsWithUsage} · 无用量 ${data.costs.turnsWithoutUsage}`),
			createElement("div", { style: styles.note },
				`工作区筛选：${data.workspaceFilter?.length ? data.workspaceFilter.join("、") : "全部"} · Ctrl/⌘ 点击可多选`),
			);
	}

	function apply(ctx) {
		ctx.slots.inject("settings.section", () => ctx.slots.register({
			name: "settings.section",
			id: "output-overview",
			order: 42,
			label: () => "产出总览",
		}, () => createElement(SummaryPanel)));
	}

	exports.name = name;
	exports.inject = ["slots"];
	exports.apply = apply;
	return module.exports;
}});
