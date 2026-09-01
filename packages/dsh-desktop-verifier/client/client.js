window.__ModuleLoader__.load({ id: "dsh-desktop-verifier", factory: (require) => {


		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/locales.ts
		const zh = {
			toggle: "验证",
			toggleOn: "验证模式已开启，点击关闭",
			toggleOff: "验证模式已关闭，点击开启",
			toggleFailed: "切换验证模式失败",
			generating: "正在生成 3 个候选回答",
			scoringRing: "正在进行环形比较",
			scoringPivots: "正在进行枢轴比较",
			replaying: "正在输出已选答案",
			complete: "验证完成",
			cancelled: "验证已取消",
			failed: "验证失败",
			candidateProgress: "候选",
			comparisonProgress: "比较",
			totalDuration: "总耗时",
			generationDuration: "候选耗时",
			scoringDuration: "评估耗时",
			replayDuration: "回放耗时",
			candidateTtft: "候选首 token 平均",
			candidateThroughput: "候选平均速率",
			extraUsage: "验证调用用量",
			tokens: "tokens",
			usageIncomplete: "用量不完整",
			progressUnavailable: "无法读取验证进度",
			sessionStatsReplayNote: "会话统计中的首 token 与速率是胜出答案的回放值，请以这里的候选指标为准。"
		};
		const en = {
			toggle: "Verify",
			toggleOn: "Verifier is on; click to turn it off",
			toggleOff: "Verifier is off; click to turn it on",
			toggleFailed: "Failed to switch Verifier mode",
			generating: "Generating 3 candidate responses",
			scoringRing: "Scoring ring comparisons",
			scoringPivots: "Scoring pivot comparisons",
			replaying: "Replaying the selected response",
			complete: "Verification complete",
			cancelled: "Verification cancelled",
			failed: "Verification failed",
			candidateProgress: "Candidates",
			comparisonProgress: "Comparisons",
			totalDuration: "Total",
			generationDuration: "Candidates",
			scoringDuration: "Scoring",
			replayDuration: "Replay",
			candidateTtft: "Candidate TTFT avg",
			candidateThroughput: "Candidate throughput avg",
			extraUsage: "Verifier call usage",
			tokens: "tokens",
			usageIncomplete: "usage incomplete",
			progressUnavailable: "Verifier progress is unavailable",
			sessionStatsReplayNote: "Session TTFT and throughput measure winner replay; use the candidate metrics shown here."
		};
		//#endregion
		//#region \0dsh-css:src/client/VerifierControl.module.css.mjs
		const css = ".IK8V6a_toggleWrap{align-items:center;min-width:0;display:inline-flex}.IK8V6a_toggle{height:28px;color:var(--dsw-alias-label-secondary,#6b7280);font:inherit;cursor:pointer;background:0 0;border:1px solid #0000;border-radius:8px;align-items:center;gap:5px;padding:0 8px;font-size:12px;line-height:18px;transition:background .15s,color .15s,border-color .15s;display:inline-flex}.IK8V6a_toggle:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#1f232814);color:var(--dsw-alias-label-primary,#1f2328)}.IK8V6a_toggle[data-active=true]{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f6ef7) 24%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f6ef7) 10%,transparent);color:var(--dsw-alias-brand-primary,#4f6ef7)}.IK8V6a_toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:1px}.IK8V6a_toggle:disabled{opacity:.55;cursor:default}.IK8V6a_toggleError{color:var(--dsw-alias-state-error-primary,#dc2626)}.IK8V6a_spin{animation:.8s linear infinite IK8V6a_verifier-spin;display:inline-flex}.IK8V6a_dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-side-clearance,16px));max-width:var(--dsh-composer-card-max-width,780px);border:1px solid var(--dsw-alias-border-l1,#eceef1);background:var(--dsw-specific-tip,var(--dsw-alias-bg-layer-2,#f6f7f8));min-width:0;color:var(--dsw-alias-label-secondary,#6b7280);border-radius:10px;align-items:center;gap:10px;margin:0 auto;padding:8px 10px;font-size:12px;line-height:18px;display:flex}.IK8V6a_dock[data-tone=error]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 28%,transparent);color:var(--dsw-alias-state-error-primary,#dc2626)}.IK8V6a_dock[data-tone=success]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16794b) 24%,transparent);color:var(--dsw-alias-state-success-primary,#16794b)}.IK8V6a_dockIcon{flex:none;display:inline-flex}.IK8V6a_dockCopy{flex-wrap:wrap;flex:1;align-items:center;gap:10px;min-width:0;display:flex}.IK8V6a_stage{color:var(--dsw-alias-label-primary,#1f2328);font-weight:600}.IK8V6a_dock[data-tone=error] .IK8V6a_stage,.IK8V6a_dock[data-tone=success] .IK8V6a_stage{color:inherit}.IK8V6a_metric{white-space:nowrap;font-variant-numeric:tabular-nums}.IK8V6a_detail{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-tertiary,#8b93a1);overflow:hidden}.IK8V6a_note{min-width:0;color:var(--dsw-alias-label-tertiary,#8b93a1);flex-basis:100%}@keyframes IK8V6a_verifier-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.IK8V6a_spin{animation:none}}";
		const tagId = "dsh-desktop-verifier/VerifierControl.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-desktop-verifier";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var VerifierControl_module_css_default = {
			"dockCopy": "IK8V6a_dockCopy",
			"verifier-spin": "IK8V6a_verifier-spin",
			"detail": "IK8V6a_detail",
			"dock": "IK8V6a_dock",
			"dockIcon": "IK8V6a_dockIcon",
			"metric": "IK8V6a_metric",
			"note": "IK8V6a_note",
			"spin": "IK8V6a_spin",
			"stage": "IK8V6a_stage",
			"toggle": "IK8V6a_toggle",
			"toggleError": "IK8V6a_toggleError",
			"toggleWrap": "IK8V6a_toggleWrap"
		};
		//#endregion
		//#region src/client/VerifierControl.tsx
		function effectiveMode(projection) {
			return projection === void 0 ? false : projection.pending ? !projection.active : projection.active;
		}
		function VerifierToggle({ useProjection, setEnabled, t }) {
			const projection = useProjection("verifier");
			const active = effectiveMode(projection);
			const [requesting, setRequesting] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			const alive = (0, react.useRef)(true);
			(0, react.useEffect)(() => {
				alive.current = true;
				return () => {
					alive.current = false;
				};
			}, []);
			if (projection === void 0) return null;
			const toggle = () => {
				setRequesting(true);
				setError(null);
				setEnabled(!active).then((failure) => {
					if (!alive.current) return;
					setRequesting(false);
					setError(failure);
				}, (reason) => {
					if (!alive.current) return;
					setRequesting(false);
					setError(reason instanceof Error ? reason.message : String(reason));
				});
			};
			const title = error ?? (active ? t("toggleOn") : t("toggleOff"));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: VerifierControl_module_css_default.toggleWrap,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: `${VerifierControl_module_css_default.toggle} ${error === null ? "" : VerifierControl_module_css_default.toggleError}`,
					"data-active": active,
					"aria-pressed": active,
					"aria-label": title,
					title,
					disabled: projection.pending || requesting,
					onClick: toggle,
					children: [projection.pending || requesting ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: VerifierControl_module_css_default.spin,
						"aria-hidden": "true",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconLoadingOutline16, { size: 14 })
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSparkle16, { size: 14 }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("toggle") })]
				})
			});
		}
		function totalTokens(usage) {
			return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
		}
		function progressLabel(status, t) {
			if (status === "generating") return t("generating");
			if (status === "scoring-ring") return t("scoringRing");
			if (status === "scoring-pivots") return t("scoringPivots");
			if (status === "replaying") return t("replaying");
			if (status === "complete") return t("complete");
			if (status === "cancelled") return t("cancelled");
			return t("failed");
		}
		function elapsed(startedAt, endedAt) {
			if (startedAt === null || startedAt === void 0 || endedAt === void 0) return null;
			return Math.max(0, endedAt - startedAt);
		}
		function formatDuration(durationMs) {
			if (durationMs < 1e3) return `${Math.round(durationMs)}ms`;
			const seconds = durationMs / 1e3;
			if (seconds < 10) return `${seconds.toFixed(1)}s`;
			if (seconds < 60) return `${Math.round(seconds)}s`;
			const wholeSeconds = Math.round(seconds);
			return `${Math.floor(wholeSeconds / 60)}m${(wholeSeconds % 60).toString().padStart(2, "0")}s`;
		}
		function averageCandidateTtft(candidates) {
			const durations = candidates.map((candidate) => elapsed(candidate.startedAt, candidate.firstTokenAt)).filter((duration) => duration !== null);
			if (durations.length === 0) return null;
			return durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
		}
		function candidateThroughput(candidates) {
			let outputTokens = 0;
			let decodeMs = 0;
			for (const candidate of candidates) {
				const duration = elapsed(candidate.firstTokenAt, candidate.endedAt);
				if (duration === null || duration === 0 || candidate.usage === void 0) continue;
				outputTokens += candidate.usage.outputTokens;
				decodeMs += duration;
			}
			return decodeMs > 0 ? outputTokens / (decodeMs / 1e3) : null;
		}
		function formatThroughput(value) {
			return value >= 100 ? value.toFixed(0) : value.toFixed(1);
		}
		function VerifierProgress({ sessionId, useProjection, t }) {
			const active = effectiveMode(useProjection("verifier"));
			const [progress, setProgress] = (0, react.useState)(null);
			const [transportError, setTransportError] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				if (!active) {
					setProgress(null);
					setTransportError(false);
					return;
				}
				let stopped = false;
				let timer;
				const controller = new AbortController();
				const poll = async () => {
					try {
						const response = await fetch(`/dsh-desktop-verifier/state?sessionId=${encodeURIComponent(sessionId)}`, {
							method: "GET",
							cache: "no-store",
							signal: controller.signal
						});
						if (!response.ok) throw new Error(`HTTP ${response.status}`);
						const next = await response.json();
						if (!stopped) {
							setProgress(next);
							setTransportError(false);
						}
					} catch (error) {
						if (!stopped && !(error instanceof DOMException && error.name === "AbortError")) setTransportError(true);
					} finally {
						if (!stopped) timer = setTimeout(poll, 750);
					}
				};
				poll();
				return () => {
					stopped = true;
					controller.abort();
					if (timer !== void 0) clearTimeout(timer);
				};
			}, [active, sessionId]);
			if (!active) return null;
			if (transportError && (progress === null || progress.status === "idle")) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: VerifierControl_module_css_default.dock,
				"data-tone": "error",
				role: "status",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: VerifierControl_module_css_default.dockIcon,
					"aria-hidden": "true",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconWarningOutline16, { size: 15 })
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: VerifierControl_module_css_default.stage,
					children: t("progressUnavailable")
				})]
			});
			if (progress === null || progress.status === "idle") return null;
			const running = progress.status === "generating" || progress.status === "scoring-ring" || progress.status === "scoring-pivots" || progress.status === "replaying";
			const failed = progress.status === "error" || progress.status === "cancelled";
			const candidateTokens = totalTokens(progress.usage.candidates);
			const verifierTokens = totalTokens(progress.usage.verifier);
			const usageComplete = progress.usage.candidates.complete && progress.usage.verifier.complete;
			const now = progress.timing.endedAt ?? Date.now();
			const totalMs = elapsed(progress.timing.startedAt, now);
			const generationEnd = progress.timing.generationEndedAt ?? (progress.status === "generating" ? now : void 0);
			const generationMs = elapsed(progress.timing.startedAt, generationEnd);
			const scoringEnd = progress.timing.scoringEndedAt ?? (progress.timing.scoringStartedAt !== void 0 && (progress.status === "scoring-ring" || progress.status === "scoring-pivots") ? now : void 0);
			const scoringMs = elapsed(progress.timing.scoringStartedAt, scoringEnd);
			const replayEnd = progress.timing.replayEndedAt ?? (progress.status === "replaying" ? now : void 0);
			const replayMs = elapsed(progress.timing.replayStartedAt, replayEnd);
			const candidateTtftMs = averageCandidateTtft(progress.timing.candidates);
			const candidateTokensPerSecond = candidateThroughput(progress.timing.candidates);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: VerifierControl_module_css_default.dock,
				"data-tone": failed ? "error" : progress.status === "complete" ? "success" : "neutral",
				role: "status",
				"aria-live": "polite",
				title: progress.error === void 0 ? void 0 : `${progress.error.code}: ${progress.error.message}`,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: `${VerifierControl_module_css_default.dockIcon} ${running ? VerifierControl_module_css_default.spin : ""}`,
					"aria-hidden": "true",
					children: failed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconWarningOutline16, { size: 15 }) : running ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconLoadingOutline16, { size: 15 }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSparkle16, { size: 15 })
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: VerifierControl_module_css_default.dockCopy,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: VerifierControl_module_css_default.stage,
							children: progressLabel(progress.status, t)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: VerifierControl_module_css_default.metric,
							children: [
								t("candidateProgress"),
								" ",
								progress.candidatesCompleted,
								"/",
								progress.candidateCount
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: VerifierControl_module_css_default.metric,
							children: [
								t("comparisonProgress"),
								" ",
								progress.comparisonsCompleted,
								"/",
								progress.comparisonsTotal
							]
						}),
						totalMs !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: VerifierControl_module_css_default.metric,
							children: [
								t("totalDuration"),
								" ",
								formatDuration(totalMs)
							]
						}),
						generationMs !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: VerifierControl_module_css_default.metric,
							children: [
								t("generationDuration"),
								" ",
								formatDuration(generationMs)
							]
						}),
						scoringMs !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: VerifierControl_module_css_default.metric,
							children: [
								t("scoringDuration"),
								" ",
								formatDuration(scoringMs)
							]
						}),
						replayMs !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: VerifierControl_module_css_default.metric,
							children: [
								t("replayDuration"),
								" ",
								formatDuration(replayMs)
							]
						}),
						candidateTtftMs !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: VerifierControl_module_css_default.metric,
							children: [
								t("candidateTtft"),
								" ",
								formatDuration(candidateTtftMs)
							]
						}),
						candidateTokensPerSecond !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: VerifierControl_module_css_default.metric,
							children: [
								t("candidateThroughput"),
								" ",
								formatThroughput(candidateTokensPerSecond),
								" tok/s"
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: VerifierControl_module_css_default.metric,
							children: [
								t("extraUsage"),
								" ",
								candidateTokens + verifierTokens,
								" ",
								t("tokens")
							]
						}),
						!usageComplete && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: VerifierControl_module_css_default.detail,
							children: t("usageIncomplete")
						}),
						progress.error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: VerifierControl_module_css_default.detail,
							children: progress.error.message
						}),
						(progress.status === "replaying" || progress.status === "complete") && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: VerifierControl_module_css_default.note,
							children: t("sessionStatsReplayNote")
						})
					]
				})]
			});
		}
		//#endregion
		//#region src/client/index.ts
		const NS = "dsh-desktop-verifier";
		const name = "dsh-desktop-verifier";
		const inject = [
			"slots",
			"remote",
			"remote.commands",
			"locale"
		];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-desktop-verifier: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "dsh-desktop-verifier-toggle",
				order: 40,
				locale: NS,
				inject: (sessionId) => ({
					t,
					setEnabled: async (enabled) => {
						const result = await ctx.remote.commands.execute(sessionId, `/verify ${enabled ? "on" : "off"}`, []);
						if (!result.ok) {
							const error = result.error;
							return error === void 0 ? t("toggleFailed") : `${error.message} (${error.code})`;
						}
						if (result.value === void 0) return t("toggleFailed");
						return null;
					}
				})
			}, VerifierToggle));
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "dsh-desktop-verifier-progress",
				order: 40,
				locale: NS,
				inject: () => ({ t })
			}, VerifierProgress));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
