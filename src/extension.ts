import * as vscode from 'vscode';
import { execFile } from 'node:child_process';

type PklJson = {
	data: unknown;
	raw: string;
};

type PklResult =
	| { ok: true; value: PklJson }
	| { ok: false; error: string };

export function activate(context: vscode.ExtensionContext) {
	const provider = new PklViewerProvider();
	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider(PklViewerProvider.viewType, provider)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pklviewer.openPkl', async (uri?: vscode.Uri | vscode.Uri[]) => {
			const candidate = Array.isArray(uri) ? uri[0] : uri;
			let target = candidate instanceof vscode.Uri ? candidate : undefined;

			if (!target) {
				const selected = await vscode.window.showOpenDialog({
					canSelectMany: false,
					openLabel: 'Open with PyData Viewer',
				});

				if (!selected || selected.length === 0) {
					return;
				}

				target = selected[0];
			}

			await vscode.commands.executeCommand(
				'vscode.openWith',
				target,
				PklViewerProvider.viewType
			);
		})
	);
}

export function deactivate() {}

class PklViewerProvider implements vscode.CustomReadonlyEditorProvider {
	static readonly viewType = 'pklviewer.viewer';

	async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
		return { uri, dispose: () => undefined };
	}

	async resolveCustomEditor(
		document: vscode.CustomDocument,
		webviewPanel: vscode.WebviewPanel
	): Promise<void> {
		webviewPanel.webview.options = {
			enableScripts: true,
		};
		webviewPanel.webview.html = getWebviewHtml();

		const update = async () => {
			const config = vscode.workspace.getConfiguration('pklviewer');
			const condaPythonPath = String(config.get('condaPythonPath', '')).trim();
			const pythonPath = String(config.get('pythonPath', 'python')).trim();
			const resolvedPythonPath = condaPythonPath || pythonPath;
			const maxOutputBytes = Number(config.get('maxOutputBytes', 5242880));
			const maxDepth = Number(config.get('maxDepth', 8));

			const result = await loadPklFile(
				document.uri.fsPath,
				resolvedPythonPath,
				maxOutputBytes,
				maxDepth
			);
			if (result.ok) {
				webviewPanel.webview.postMessage({
					type: 'data',
					payload: result.value,
					fileName: document.uri.fsPath,
				});
			} else {
				webviewPanel.webview.postMessage({
					type: 'error',
					error: result.error,
					fileName: document.uri.fsPath,
				});
			}
		};

		webviewPanel.webview.onDidReceiveMessage((message) => {
			if (message?.type === 'refresh') {
				void update();
			}
		});

		await update();
	}
}

function loadPklFile(
	filePath: string,
	pythonPath: string,
	maxOutputBytes: number,
	maxDepth: number
): Promise<PklResult> {
	if (!pythonPath) {
		return Promise.resolve({
			ok: false,
			error: 'Python path is empty. Set pklviewer.condaPythonPath or pklviewer.pythonPath in settings.',
		});
	}

	const safeMaxBytes = Number.isFinite(maxOutputBytes) && maxOutputBytes > 0
		? Math.floor(maxOutputBytes)
		: 5242880;

	const safeMaxDepth = Number.isFinite(maxDepth) && maxDepth > 0
		? Math.floor(maxDepth)
		: 8;

	const pythonScript = [
		"import json",
		"import math",
		"import os",
		"import pickle",
		"import sys",
		"",
		"path = sys.argv[1]",
		"ext = os.path.splitext(path)[1].lower()",
		"max_depth = int(sys.argv[2])",
		"max_items = 200",
		"max_raw = 20000",
		"max_table_rows = 10",
		"",
		"def summarize_pandas(obj):",
		"    try:",
		"        import pandas as pd",
		"    except Exception:",
		"        return {\"__type__\": \"pandas_missing\", \"repr\": \"pandas is required\"}",
		"    if isinstance(obj, pd.DataFrame):",
		"        return {",
		"            \"__type__\": \"DataFrame\",",
		"            \"shape\": list(obj.shape),",
		"            \"columns\": list(obj.columns)[:max_items],",
		"            \"head\": to_json(obj.head(max_table_rows).to_dict(orient=\"list\")),",
		"        }",
		"    if isinstance(obj, pd.Series):",
		"        return {",
		"            \"__type__\": \"Series\",",
		"            \"shape\": list(obj.shape),",
		"            \"name\": str(obj.name),",
		"            \"head\": to_json(obj.head(max_table_rows).to_list()),",
		"        }",
		"    return {\"__type__\": type(obj).__name__, \"repr\": repr(obj)}",
		"",
		"def load_data(path):",
		"    if ext in (\".h5\", \".hdf5\", \".hdf\"):",
		"        try:",
		"            import pandas as pd",
		"        except Exception:",
		"            raise RuntimeError(\"pandas is required to open HDF5 files. Install pandas in the selected python environment.\")",
		"        with pd.HDFStore(path, mode=\"r\") as store:",
		"            keys = list(store.keys())",
		"            out = {\"__type__\": \"hdf5\", \"keys\": keys[:max_items], \"items\": {}}",
		"            for key in keys[:max_items]:",
		"                try:",
		"                    out[\"items\"][key] = summarize_pandas(store.get(key))",
		"                except Exception as inner:",
		"                    out[\"items\"][key] = {\"__type__\": \"error\", \"repr\": str(inner)}",
		"            remaining = len(keys) - len(out[\"keys\"])",
		"            if remaining > 0:",
		"                out[\"__truncated__\"] = remaining",
		"            return out",
		"    with open(path, \"rb\") as handle:",
		"        return pickle.load(handle)",
		"",
		"def to_json(obj, depth=0, seen=None):",
		"    if seen is None:",
		"        seen = set()",
		"    if id(obj) in seen:",
		"        return {\"__type__\": \"ref\", \"repr\": repr(obj)}",
		"    if depth > max_depth:",
		"        return {\"__type__\": \"max_depth\", \"repr\": repr(obj)}",
		"    if obj is None or isinstance(obj, (bool, int, str)):",
		"        return obj",
		"    if isinstance(obj, float):",
		"        if math.isnan(obj):",
		"            return \"NaN\"",
		"        if math.isinf(obj):",
		"            return \"Infinity\" if obj > 0 else \"-Infinity\"",
		"        return obj",
		"    if isinstance(obj, bytes):",
		"        preview = obj[:64].hex()",
		"        return {\"__type__\": \"bytes\", \"len\": len(obj), \"preview_hex\": preview}",
		"    if isinstance(obj, (list, tuple, set)):",
		"        seen.add(id(obj))",
		"        items = []",
		"        for i, item in enumerate(list(obj)[:max_items]):",
		"            items.append(to_json(item, depth + 1, seen))",
		"        remaining = len(obj) - len(items)",
		"        out = {\"__type__\": type(obj).__name__, \"items\": items}",
		"        if remaining > 0:",
		"            out[\"__truncated__\"] = remaining",
		"        return out",
		"    if isinstance(obj, dict):",
		"        seen.add(id(obj))",
		"        items = []",
		"        for i, (k, v) in enumerate(list(obj.items())[:max_items]):",
		"            items.append([to_json(k, depth + 1, seen), to_json(v, depth + 1, seen)])",
		"        remaining = len(obj) - len(items)",
		"        out = {\"__type__\": \"dict\", \"items\": items}",
		"        if remaining > 0:",
		"            out[\"__truncated__\"] = remaining",
		"        return out",
		"    try:",
		"        result = {\"__type__\": type(obj).__name__}",
		"        if hasattr(obj, \"__dict__\"):",
		"            seen.add(id(obj))",
		"            result[\"__dict__\"] = to_json(obj.__dict__, depth + 1, seen)",
		"        slots = getattr(obj, \"__slots__\", None)",
		"        if slots:",
		"            slot_items = {}",
		"            for slot in slots if isinstance(slots, (list, tuple)) else [slots]:",
		"                if hasattr(obj, slot):",
		"                    slot_items[str(slot)] = to_json(getattr(obj, slot), depth + 1, seen)",
		"            if slot_items:",
		"                result[\"__slots__\"] = slot_items",
		"        getstate = getattr(obj, \"__getstate__\", None)",
		"        if callable(getstate):",
		"            try:",
		"                state = getstate()",
		"                result[\"__state__\"] = to_json(state, depth + 1, seen)",
		"            except Exception:",
		"                result[\"__state__\"] = {\"__type__\": \"state_error\"}",
		"        result[\"repr\"] = repr(obj)",
		"        return result",
		"    except Exception:",
		"        return {\"__type__\": type(obj).__name__, \"repr\": \"<unrepresentable>\"}",
		"",
		"data = load_data(path)",
		"",
		"raw = repr(data)",
		"if len(raw) > max_raw:",
		"    raw = raw[:max_raw] + \" ...<truncated>\"",
		"",
		"payload = {\"data\": to_json(data), \"raw\": raw}",
		"print(json.dumps(payload, allow_nan=False))",
	].join("\n");

	return new Promise((resolve) => {
		execFile(
			pythonPath,
			['-c', pythonScript, filePath, String(safeMaxDepth)],
			{ maxBuffer: safeMaxBytes },
			(error, stdout, stderr) => {
				if (error) {
					const message = stderr || error.message || 'Unknown error while running Python.';
					resolve({ ok: false, error: message.trim() });
					return;
				}

				try {
					const parsed = JSON.parse(stdout) as PklJson;
					resolve({ ok: true, value: parsed });
				} catch (parseError) {
					resolve({
						ok: false,
						error: `Failed to parse Python output: ${String(parseError)}`,
					});
				}
			}
		);
	});
}

function getWebviewHtml(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>PyData Viewer</title>
	<style>
		:root {
			color-scheme: light dark;
			--border: rgba(127, 127, 127, 0.3);
			--badge: rgba(0, 122, 204, 0.15);
		}
		body {
			font-family: Verdana, Geneva, sans-serif;
			margin: 0;
			padding: 16px;
		}
		header {
			display: flex;
			align-items: center;
			gap: 12px;
			margin-bottom: 16px;
		}
		button {
			border: 1px solid var(--border);
			background: transparent;
			color: inherit;
			padding: 6px 10px;
			border-radius: 6px;
			cursor: pointer;
		}
		button:hover {
			background: var(--badge);
		}
		.tabs {
			display: flex;
			gap: 8px;
			margin-bottom: 12px;
		}
		.tab {
			border: 1px solid var(--border);
			padding: 6px 10px;
			border-radius: 20px;
			cursor: pointer;
		}
		.tab.active {
			background: var(--badge);
			font-weight: bold;
		}
		.view {
			display: none;
		}
		.view.active {
			display: block;
		}
		#status {
			padding: 8px 12px;
			border: 1px solid var(--border);
			border-radius: 8px;
			margin-bottom: 12px;
		}
		.node {
			margin-left: 12px;
			border-left: 1px dashed var(--border);
			padding-left: 12px;
		}
		.node-header {
			font-weight: 600;
			margin: 4px 0;
		}
		.badge {
			background: var(--badge);
			padding: 2px 6px;
			border-radius: 10px;
			margin-left: 6px;
			font-size: 12px;
		}
		.raw {
			white-space: pre-wrap;
			border: 1px solid var(--border);
			padding: 12px;
			border-radius: 8px;
		}
	</style>
</head>
<body>
	<header>
		<h2>PyData Viewer</h2>
		<button id="refresh">Refresh</button>
	</header>
	<div id="status">Loading...</div>
	<div class="tabs">
		<div class="tab active" data-view="tree">Tree</div>
		<div class="tab" data-view="raw">Raw</div>
	</div>
	<section id="tree" class="view active"></section>
	<section id="raw" class="view">
		<div class="raw" id="rawText"></div>
	</section>
	<script>
		const vscode = acquireVsCodeApi();
		const statusEl = document.getElementById('status');
		const treeEl = document.getElementById('tree');
		const rawEl = document.getElementById('rawText');
		const refreshBtn = document.getElementById('refresh');
		const tabs = document.querySelectorAll('.tab');

		refreshBtn.addEventListener('click', () => {
			vscode.postMessage({ type: 'refresh' });
			statusEl.textContent = 'Refreshing...';
		});

		tabs.forEach((tab) => {
			tab.addEventListener('click', () => {
				tabs.forEach((t) => t.classList.remove('active'));
				tab.classList.add('active');
				const view = tab.getAttribute('data-view');
				document.querySelectorAll('.view').forEach((section) => {
					section.classList.toggle('active', section.id === view);
				});
			});
		});

		window.addEventListener('message', (event) => {
			const message = event.data;
			if (message.type === 'error') {
				statusEl.textContent = 'Error: ' + message.error;
				return;
			}
			if (message.type === 'data') {
				statusEl.textContent = message.fileName || 'Loaded';
				rawEl.textContent = message.payload.raw || '';
				treeEl.innerHTML = '';
				treeEl.appendChild(renderNode('root', message.payload.data, 0));
			}
		});

		function renderNode(label, value, depth) {
			const container = document.createElement('div');
			container.className = 'node';
			const header = document.createElement('div');
			header.className = 'node-header';

			if (value === null || value === undefined || typeof value !== 'object') {
				header.textContent = label + ': ' + formatValue(value);
				container.appendChild(header);
				return container;
			}

			if (value.__type__ === 'bytes') {
				header.textContent = label + ': <bytes>';
				const badge = document.createElement('span');
				badge.className = 'badge';
				badge.textContent = value.len + ' bytes';
				header.appendChild(badge);
				container.appendChild(header);
				const preview = document.createElement('div');
				preview.textContent = 'hex preview: ' + value.preview_hex;
				container.appendChild(preview);
				return container;
			}

			if (value.__type__ && value.items) {
				header.textContent = label + ': ' + value.__type__;
				container.appendChild(header);
				const childWrap = document.createElement('div');
				childWrap.className = 'children';
				if (value.__type__ === 'dict') {
					value.items.forEach((pair, index) => {
						const keyNode = renderNode('key ' + index, pair[0], depth + 1);
						const valueNode = renderNode('value ' + index, pair[1], depth + 1);
						childWrap.appendChild(keyNode);
						childWrap.appendChild(valueNode);
					});
				} else {
					value.items.forEach((item, index) => {
						childWrap.appendChild(renderNode('[' + index + ']', item, depth + 1));
					});
				}
				if (value.__truncated__) {
					const truncated = document.createElement('div');
					truncated.textContent = '... ' + value.__truncated__ + ' more item(s)';
					childWrap.appendChild(truncated);
				}
				container.appendChild(childWrap);
				return container;
			}

			if (value.__type__ && value.repr) {
				header.textContent = label + ': ' + value.__type__;
				const badge = document.createElement('span');
				badge.className = 'badge';
				badge.textContent = value.repr;
				header.appendChild(badge);
				container.appendChild(header);

				const childWrap = document.createElement('div');
				childWrap.className = 'children';
				let hasChildren = false;
				if (value.__dict__) {
					childWrap.appendChild(renderNode('__dict__', value.__dict__, depth + 1));
					hasChildren = true;
				}
				if (value.__slots__) {
					childWrap.appendChild(renderNode('__slots__', value.__slots__, depth + 1));
					hasChildren = true;
				}
				if (value.__state__) {
					childWrap.appendChild(renderNode('__state__', value.__state__, depth + 1));
					hasChildren = true;
				}
				if (hasChildren) {
					container.appendChild(childWrap);
				}
				return container;
			}

			header.textContent = label + ': ' + formatValue(value);
			container.appendChild(header);
			return container;
		}

		function formatValue(value) {
			if (typeof value === 'string') {
				return '"' + value + '"';
			}
			return String(value);
		}
	</script>
</body>
</html>`;
}
