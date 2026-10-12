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
	/**
	 * Money formatter bound to the payload's display currency. The host
	 * converts cost VALUES (costs.* are already in `displayCurrency.code` at
	 * `displayCurrency.fx` per USD); unit prices in costs.pricing remain USD.
	 */
	const moneyIn = (symbol) => {
		const s = symbol || "$";
		return (n) => {
			if (typeof n !== "number") return "—";
			const abs = Math.abs(n);
			const v = abs >= 1 ? n.toFixed(2) : abs >= 0.01 ? n.toFixed(3) : n.toFixed(4);
			return `${s}${v}`;
		};
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

		// Refs mirror the latest filter state so the change handlers can build
		// the request WITHOUT depending on them — this breaks the
		// setState -> useCallback-identity -> useEffect-refire loop that made
		// every filter change fire two fetches (the second, effect-driven one
		// racing the first; with the corpus single-flight and 30s summary cache
		// it usually resolved, but a raced 500 left the panel blank).
		const stateRef = React.useRef({ workspace, subagents, range, customFrom, customTo });
		stateRef.current = { workspace, subagents, range, customFrom, customTo };

		// Cumulative workspace option list: a stale host's filtered payload
		// shrinks `workspaces`, which must never collapse the picker. The ref
		// lives ABOVE every early return (rules of hooks: hook count and
		// order must be identical on every render — violating that throws
		// React error #310 and the panel dies).
		const knownWsRef = React.useRef([]);

		const load = React.useCallback(async (opts = {}) => {
			// Keep the previous data on screen while refreshing; only a real
			// failure replaces it with the error view.
			const s = stateRef.current;
			setLoading(true);
			setError(null);
			try {
				const nextRange = opts.range ?? s.range;
				const win = rangeWindow(
					nextRange,
					opts.customFrom ?? s.customFrom,
					opts.customTo ?? s.customTo);
				const payload = await fetchSummary({
					workspace: opts.workspace ?? s.workspace, // array -> repeated params
					subagents: opts.subagents ?? s.subagents,
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
		}, []);

		// Initial load only. Filter changes fetch through their own handlers;
		// no effect re-fire, no duplicate requests.
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

		// Defensive normalization: a stale host (lib predating the multi-select
	// fix) reports `workspaceFilter` as a plain string and shrinks
	// `workspaces` — rendering must never crash on such payloads (a string
	// has no .join, and a TypeError inside React unmounts the whole panel).
	const rawFilter = data.workspaceFilter;
	const filterList = Array.isArray(rawFilter) ? rawFilter : rawFilter ? [rawFilter] : [];
	const workspaceList = Array.isArray(data.workspaces) ? data.workspaces : [];
	// Merge this payload's workspaces into the cumulative option list.
	{
		const known = new Set(knownWsRef.current);
		for (const w of workspaceList) if (!known.has(w)) { known.add(w); knownWsRef.current.push(w); }
	}
	const fullWorkspaceList = knownWsRef.current;
	// Pre-multiselect host lib reports the filter as a plain string; warn so a
	// half-updated deployment (client hot-reloaded, host not restarted) is
	// diagnosable instead of silently wrong.
	const staleHost = typeof data.workspaceFilter === "string";
	const recentDays = [...data.days].slice(-14).reverse();
	// Display currency from the payload (host converts the values; we only
	// relabel). Fall back to USD for stale payloads without displayCurrency.
	const cur = data.displayCurrency && data.displayCurrency.code
		? data.displayCurrency
		: { code: "USD", symbol: "$" };
	const money = moneyIn(cur.symbol);

		return createElement("div", { style: styles.root },
			createElement("div", { style: styles.headerRow },
				// Workspace multi-select: ctrl/cmd-click (or the All toggle) picks
				// several; an empty selection means all workspaces.
				createElement("select", {
					style: { ...selectStyle, height: 64 },
					multiple: true, size: Math.min(6, Math.max(2, fullWorkspaceList.length || 2)),
					value: workspace,
					onChange: (e) => {
						const picked = [...e.target.selectedOptions].map((o) => o.value);
						setWorkspace(picked);
						load({ workspace: picked });
					},
					onMouseDown: (e) => {
						// Plain click on a list-box option replaces the selection; with
						// ctrl/cmd it toggles. Catch the plain click and make it TOGGLE
						// too, so picking a second workspace never needs the modifier.
						// The picked array is captured through a ref-free closure over
						// the CURRENT state value, so a stale `workspace` state cannot
						// shrink the selection.
						const opt = e.target.closest("option");
						if (!opt || e.ctrlKey || e.metaKey) return;
						e.preventDefault();
						e.stopPropagation();
						const current = stateRef.current.workspace;
						const picked = current.includes(opt.value)
							? current.filter((w) => w !== opt.value)
							: [...current, opt.value];
						setWorkspace(picked);
						load({ workspace: picked });
					},
				},
					fullWorkspaceList.map((w) => createElement("option", { key: w, value: w }, w))),
				createElement("button", {
					style: styles.button,
					onClick: () => { setWorkspace([]); load({ workspace: [] }); },
				}, stateRef.current.workspace.length === 0 ? "全部工作区" : `全部工作区 (已选 ${stateRef.current.workspace.length})`),
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
					label: `总成本（${cur.code}）`,
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
				`成本按轮次归集并以 ${cur.code}（${cur.symbol}）显示（汇率 1 USD = ${data.costs.fx?.rate ?? 1} ${cur.code}；模型定价 ${data.costs.pricing.label || "当前模型"}：USD / 1M tokens，输入 ${data.costs.pricing.miss} · 缓存读 ${data.costs.pricing.hit} · 缓存写 ${data.costs.pricing.write} · 输出 ${data.costs.pricing.out}）· 有用量的轮次 ${data.costs.turnsWithUsage} · 无用量 ${data.costs.turnsWithoutUsage}`),
			staleHost && createElement("div", { style: { ...styles.note, color: "#d29922" } },
				"检测到主机端插件仍是旧版本（workspaceFilter 为字符串）：请重启 DSH 让 lib/ 生效后强刷本页。"),
			createElement("div", { style: styles.note },
				`工作区筛选：${filterList.length ? filterList.join("、") : "全部"} · 点击列表项可多选`),
			);
	}

	/**
	 * Render guard: any unexpected render error previously unmounted the whole
	 * settings section (observed as "panel goes permanently blank"), because
	 * the host renders the slot without its own boundary. Show the message and
	 * a reset button instead.
	 */
	class PanelBoundary extends React.Component {
		constructor(props) { super(props); this.state = { error: null }; }
		static getDerivedStateFromError(error) { return { error }; }
		render() {
			if (this.state.error) {
				return createElement("div", { style: styles.root },
					createElement("div", { style: styles.error }, `渲染出错：${String(this.state.error?.message ?? this.state.error)}`),
					createElement("button", { style: styles.button, onClick: () => this.setState({ error: null }) }, "重试"));
			}
			return this.props.children;
		}
	}

	function apply(ctx) {
		ctx.slots.inject("settings.section", () => ctx.slots.register({
			name: "settings.section",
			id: "output-overview",
			order: 42,
			label: () => "产出总览",
		}, () => createElement(PanelBoundary, null, createElement(SummaryPanel))));
	}

	exports.name = name;
	exports.inject = ["slots"];
	exports.apply = apply;
	return module.exports;
}});
