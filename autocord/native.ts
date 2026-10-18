/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile, spawn } from "child_process";
import { randomUUID } from "crypto";
import type { IpcMainInvokeEvent } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
    buildOrchestratorPrompt,
    DEFAULT_KATIE_PERSONA,
    DEFAULT_MODEL_BY_PROVIDER,
    ITSJSKT_VOICE_BANK,
     parseOrchestratorDecision,
    PROVIDER_MODEL_SUGGESTIONS,
    SYSTEM_INSTRUCTION_JSON_ONLY,
} from "./prompt";
import type {
    EffortLevel,
    GenerateDecisionArgs,
    GenerateDecisionResult,
    PersonaProfile,
    ProviderHealthResult,
    ProviderKind,
    ProviderStatusItem,
} from "./types";

// Strict Antigravity project isolation: all automated orchestrator cascades MUST live in the "discord" project
// (5f396b27-5d07-5e60-9343-41bbd9061036) so they never spam the active "autocord" IDE workspace.
const DISCORD_ANTIGRAVITY_PROJECT_ID = "5f396b27-5d07-5e60-9343-41bbd9061036";
const ANTIGRAVITY_SESSION_POLICY_VERSION = "discord-natural-chat-v24-multiserver-occams-razor";
const ANTIGRAVITY_MAX_SESSION_STEPS = 60;
const ANTIGRAVITY_MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_CLI_SESSION_TURNS = 24;

const DEFAULT_NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

interface ChannelSessionRecord {
    provider: ProviderKind;
    channelId: string;
    sessionId: string;
    model: string;
    lastStepIndex?: number;
    turnCount: number;
    createdAt: number;
    updatedAt: number;
}

interface LsDiscoveryCache {
    lsAddress: string;
    csrfToken: string;
    pid?: number;
    discoveredAt: number;
}

const sessionStore = new Map<string, ChannelSessionRecord>();
let sessionsLoadedFromDisk = false;
let lsCache: LsDiscoveryCache | null = null;

function getUserHome(): string {
    return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function getAntigravityHome(): string {
    return process.env.ANTIGRAVITY_HOME || path.join(getUserHome(), ".gemini", "antigravity");
}

function getAutocordRepoDir(): string {
    return path.join(getUserHome(), "Documents", "antigravity", "autocord");
}

function getDiscordWorkspaceDir(): string {
    const dir = path.join(getUserHome(), "Documents", "antigravity", "discord");
    try {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return dir;
    } catch {
        return os.tmpdir();
    }
}

function getSessionStorePath(): string {
    return path.join(getAntigravityHome(), "autocord_equicord_sessions.json");
}

function sessionKey(provider: ProviderKind, channelId: string): string {
    return `${provider}:${String(channelId || "global").trim()}`;
}

function ensureSessionsLoaded(): void {
    if (sessionsLoadedFromDisk) return;
    sessionsLoadedFromDisk = true;
    try {
        const filePath = getSessionStorePath();
        if (!fs.existsSync(filePath)) return;
        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw) as Record<string, ChannelSessionRecord>;
        if (parsed && typeof parsed === "object") {
            for (const [k, v] of Object.entries(parsed)) {
                if (v && typeof v.sessionId === "string" && v.sessionId.trim()) {
                    sessionStore.set(k, v);
                }
            }
        }
    } catch {
        // Ignore corrupt or missing session cache
    }
}

function persistSessionsToDisk(): void {
    try {
        const filePath = getSessionStorePath();
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const obj: Record<string, ChannelSessionRecord> = {};
        for (const [k, v] of sessionStore.entries()) {
            obj[k] = v;
        }
        fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
    } catch {
        // Best-effort persistence
    }
}

function getChannelSession(provider: ProviderKind, channelId: string): ChannelSessionRecord | undefined {
    ensureSessionsLoaded();
    return sessionStore.get(sessionKey(provider, channelId));
}

function setChannelSession(record: ChannelSessionRecord): void {
    ensureSessionsLoaded();
    sessionStore.set(sessionKey(record.provider, record.channelId), record);
    persistSessionsToDisk();
}

function deleteChannelSession(provider: ProviderKind, channelId: string): boolean {
    ensureSessionsLoaded();
    const deleted = sessionStore.delete(sessionKey(provider, channelId));
    if (deleted) persistSessionsToDisk();
    return deleted;
}

function normalizeEffort(effort?: string): EffortLevel {
    const clean = String(effort || "low").trim().toLowerCase();
    if (clean === "low" || clean === "medium" || clean === "high" || clean === "xhigh") {
        return clean;
    }
    return "low";
}

function normalizeProvider(provider?: string): ProviderKind {
    const clean = String(provider || "antigravity").trim().toLowerCase();
    if (
        clean === "antigravity" ||
        clean === "nvidia" ||
        clean === "openai" ||
        clean === "codex" ||
        clean === "claude" ||
        clean === "grok"
    ) {
        return clean;
    }
    return "antigravity";
}

// ============================================================================
// Binary Discovery Helpers (Windows-safe, zero console flashes)
// ============================================================================

function findExecutableInPath(names: string[]): string | null {
    const pathEnv = process.env.PATH || process.env.Path || "";
    if (!pathEnv) return null;
    const dirs = pathEnv.split(path.delimiter).map(d => d.trim()).filter(Boolean);
    for (const dir of dirs) {
        for (const name of names) {
            const candidate = path.join(dir, name);
            try {
                if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                    return candidate;
                }
            } catch {
                // continue
            }
        }
    }
    return null;
}

function findAntigravityExecutable(overridePath?: string): string | null {
    const home = getUserHome();
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const candidates = [
        overridePath,
        process.env.ANTIGRAVITY_CLI_PATH,
        path.join(localAppData, "Programs", "antigravity", "resources", "bin", "language_server.exe"),
        path.join(getAntigravityHome(), "bin", "agentapi.bat"),
        path.join(home, ".gemini", "antigravity", "bin", "agentapi.bat"),
    ].filter((c): c is string => Boolean(c && c.trim()));

    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                return candidate;
            }
        } catch {
            // continue
        }
    }
    return findExecutableInPath(["language_server.exe", "agentapi.bat"]);
}

function findCodexExecutable(overridePath?: string): string | null {
    const directCandidates = [overridePath, process.env.CODEX_CLI_PATH].filter(
        (c): c is string => Boolean(c && c.trim())
    );
    for (const c of directCandidates) {
        try {
            if (fs.existsSync(c) && fs.statSync(c).isFile()) {
                return c;
            }
        } catch {
            // continue
        }
    }

    const home = getUserHome();
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const codexBinRoot = path.join(localAppData, "OpenAI", "Codex", "bin");

    try {
        if (fs.existsSync(codexBinRoot)) {
            const entries = fs.readdirSync(codexBinRoot, { withFileTypes: true });
            const foundBins: Array<{ fullPath: string; mtimeMs: number; }> = [];
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const exePath = path.join(codexBinRoot, entry.name, "codex.exe");
                    if (fs.existsSync(exePath)) {
                        const stat = fs.statSync(exePath);
                        foundBins.push({ fullPath: exePath, mtimeMs: stat.mtimeMs });
                    }
                } else if (entry.isFile() && entry.name.toLowerCase() === "codex.exe") {
                    const exePath = path.join(codexBinRoot, entry.name);
                    const stat = fs.statSync(exePath);
                    foundBins.push({ fullPath: exePath, mtimeMs: stat.mtimeMs });
                }
            }
            if (foundBins.length > 0) {
                foundBins.sort((a, b) => b.mtimeMs - a.mtimeMs);
                return foundBins[0].fullPath;
            }
        }
    } catch {
        // continue
    }

    // Check ~/.codex/config.toml for CODEX_CLI_PATH
    try {
        const configTomlPath = path.join(home, ".codex", "config.toml");
        if (fs.existsSync(configTomlPath)) {
            const text = fs.readFileSync(configTomlPath, "utf8");
            const match = text.match(/CODEX_CLI_PATH\s*=\s*['"]([^'"]+codex\.exe)['"]/i);
            if (match && match[1] && fs.existsSync(match[1])) {
                return match[1];
            }
        }
    } catch {
        // continue
    }

    return findExecutableInPath(["codex.exe", "codex.cmd", "codex"]);
}

function findClaudeExecutable(overridePath?: string): string | null {
    const directCandidates = [overridePath, process.env.CLAUDE_CLI_PATH].filter(
        (c): c is string => Boolean(c && c.trim())
    );
    for (const c of directCandidates) {
        try {
            if (fs.existsSync(c) && fs.statSync(c).isFile()) {
                return c;
            }
        } catch {
            // continue
        }
    }

    const home = getUserHome();
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");

    const candidates = [
        path.join(home, ".local", "bin", "claude.exe"),
        path.join(home, ".claude", "local", "claude.exe"),
        path.join(localAppData, "Programs", "claude", "claude.exe"),
        path.join(localAppData, "AnthropicClaude", "claude.exe"),
        path.join(appData, "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
        path.join(appData, "npm", "claude.cmd"),
    ];
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                return candidate;
            }
        } catch {
            // continue
        }
    }
    return findExecutableInPath(["claude.exe", "claude.cmd", "claude"]);
}

function findGrokExecutable(overridePath?: string): string | null {
    const directCandidates = [overridePath, process.env.GROK_CLI_PATH].filter(
        (c): c is string => Boolean(c && c.trim())
    );
    for (const c of directCandidates) {
        try {
            if (fs.existsSync(c) && fs.statSync(c).isFile()) {
                return c;
            }
        } catch {
            // continue
        }
    }

    const home = getUserHome();
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const candidates = [
        path.join(home, ".grok", "bin", "grok.exe"),
        path.join(localAppData, "Programs", "grok", "grok.exe"),
        path.join(home, ".local", "bin", "grok.exe"),
    ];
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                return candidate;
            }
        } catch {
            // continue
        }
    }
    return findExecutableInPath(["grok.exe", "grok.cmd", "grok"]);
}

function findPwshExecutable(): string {
    const home = getUserHome();
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const candidates = [
        path.join(localAppData, "Programs", "PowerShell", "7", "pwsh.exe"),
        "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    ];
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch {
            // continue
        }
    }
    return "pwsh.exe";
}

interface SubprocessResult {
    code: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

function buildIsolatedSubprocessEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...overrides,
    };
    // Prevent parent Antigravity / Claude session metadata from polluting automated Discord cascades
    delete env.ANTIGRAVITY_SOURCE_METADATA;
    delete env.ANTIGRAVITY_CONVERSATION_ID;
    delete env.ANTIGRAVITY_TRAJECTORY_ID;
    delete env.CLAUDECODE;
    env.ANTIGRAVITY_PROJECT_ID = DISCORD_ANTIGRAVITY_PROJECT_ID;
    return env;
}

function runHiddenSubprocess(options: {
    executable: string;
    args: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdinText?: string;
    timeoutMs?: number;
}): Promise<SubprocessResult> {
    const timeoutMs = Math.max(1000, options.timeoutMs ?? 30_000);
    return new Promise(resolve => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timedOut = false;

        let execCmd = options.executable;
        let execArgs = [...options.args];
        const env = buildIsolatedSubprocessEnv(options.env);

        const lowerExe = execCmd.toLowerCase();
        if (lowerExe.endsWith(".js")) {
            execArgs = [execCmd, ...execArgs];
            execCmd = process.execPath;
            env.ELECTRON_RUN_AS_NODE = "1";
        } else if (process.platform === "win32" && (lowerExe.endsWith(".cmd") || lowerExe.endsWith(".bat"))) {
            const comspec = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
            execArgs = ["/d", "/s", "/c", execCmd, ...execArgs];
            execCmd = comspec;
        }

        let child;
        try {
            child = spawn(execCmd, execArgs, {
                cwd: options.cwd || getDiscordWorkspaceDir(),
                env,
                windowsHide: true,
                stdio: [options.stdinText !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
            });
        } catch (err) {
            resolve({
                code: 1,
                stdout: "",
                stderr: err instanceof Error ? err.message : String(err),
                timedOut: false,
            });
            return;
        }

        const finish = (code: number) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code, stdout, stderr, timedOut });
        };

        const timer = setTimeout(() => {
            timedOut = true;
            try {
                if (process.platform === "win32" && child.pid) {
                    execFile(
                        "taskkill",
                        ["/F", "/T", "/PID", String(child.pid)],
                        { windowsHide: true },
                        () => { /* ignore */ },
                    );
                }
                child.kill("SIGKILL");
            } catch {
                // ignore
            }
            finish(124);
        }, timeoutMs);

        if (child.stdout) {
            child.stdout.on("data", (chunk: Buffer) => {
                if (stdout.length < 2 * 1024 * 1024) {
                    stdout += chunk.toString("utf8");
                }
            });
        }
        if (child.stderr) {
            child.stderr.on("data", (chunk: Buffer) => {
                if (stderr.length < 1024 * 1024) {
                    stderr += chunk.toString("utf8");
                }
            });
        }

        child.on("error", err => {
            stderr += `\n${err.message}`;
            finish(1);
        });

        child.on("close", code => {
            finish(code ?? 0);
        });

        if (options.stdinText !== undefined && child.stdin) {
            try {
                child.stdin.write(options.stdinText, "utf8");
                child.stdin.end();
            } catch {
                try {
                    child.stdin.end();
                } catch {
                    // ignore
                }
            }
        }
    });
}

function isValidDecisionOutput(rawText: string): boolean {
    const trimmed = String(rawText || "").trim();
    if (!trimmed) return false;
    const parsed = parseOrchestratorDecision(trimmed);
    return parsed.diagnostic === null;
}

// ============================================================================
// Provider 1 & 2: NVIDIA Build NIM & OpenAI-Compatible Chat Completions
// ============================================================================

function normalizeChatCompletionsUrl(baseUrl: string): string {
    const trimmed = baseUrl.trim().replace(/\/+$/, "");
    if (trimmed.endsWith("/chat/completions")) {
        return trimmed;
    }
    if (trimmed.endsWith("/v1")) {
        return `${trimmed}/chat/completions`;
    }
    return `${trimmed}/v1/chat/completions`;
}

function normalizeModelsEndpointUrl(baseUrl: string): string {
    const trimmed = baseUrl
        .trim()
        .replace(/\/+$/, "")
        .replace(/\/chat\/completions$/i, "");
    if (trimmed.endsWith("/models")) {
        return trimmed;
    }
    if (trimmed.endsWith("/v1")) {
        return `${trimmed}/models`;
    }
    return `${trimmed}/v1/models`;
}

function buildEffortInstruction(effort: EffortLevel): string {
    switch (effort) {
        case "low":
            return "Thinking level: low. Minimal reasoning effort. Do not over-think; output the raw JSON decision immediately.";
        case "medium":
            return "Thinking level: medium. Briefly weigh social context, then output the raw JSON decision.";
        case "high":
            return "Thinking level: high. Carefully evaluate room pace, social tone, and constraints before outputting the raw JSON decision.";
        case "xhigh":
            return "Thinking level: xhigh. Deeply analyze social frame, conversational subtext, and persona voice fidelity before outputting the raw JSON decision.";
    }
}

async function callOpenAiCompatibleProvider(
    provider: "nvidia" | "openai" | "grok",
    args: GenerateDecisionArgs,
    promptText: string,
    model: string,
    effort: EffortLevel,
    timeoutMs: number,
): Promise<{ ok: boolean; rawText?: string; error?: string; }> {
    let apiKey = "";
    let baseUrl = "";

    if (provider === "nvidia") {
        apiKey = (
            args.nvidiaApiKey ||
            args.apiKey ||
            process.env.NVIDIA_API_KEY ||
            process.env.NGC_API_KEY ||
            ""
        ).trim();
        baseUrl = (args.nvidiaBaseUrl || args.baseUrl || DEFAULT_NVIDIA_BASE_URL).trim();
        if (!apiKey) {
            return {
                ok: false,
                error: "Missing NVIDIA Build API key (nvapi-...). Paste your key in Autocord settings or set NVIDIA_API_KEY.",
            };
        }
    } else if (provider === "grok") {
        apiKey = (
            args.xaiApiKey ||
            args.grokApiKey ||
            args.apiKey ||
            process.env.XAI_API_KEY ||
            process.env.GROK_API_KEY ||
            ""
        ).trim();
        baseUrl = (args.grokBaseUrl || args.baseUrl || DEFAULT_XAI_BASE_URL).trim();
        if (!apiKey) {
            return {
                ok: false,
                error: "Grok CLI failed and no xAI API key (XAI_API_KEY) is configured for fallback.",
            };
        }
    } else {
        apiKey = (
            args.openaiApiKey ||
            args.apiKey ||
            process.env.OPENAI_API_KEY ||
            ""
        ).trim();
        baseUrl = (args.openaiBaseUrl || args.baseUrl || process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL).trim();
        const isLocalEndpoint = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(baseUrl);
        if (!apiKey && !isLocalEndpoint) {
            return {
                ok: false,
                error: "Missing OpenAI-compatible API key. Paste your key in Autocord settings or set OPENAI_API_KEY.",
            };
        }
    }

    const endpoint = normalizeChatCompletionsUrl(baseUrl);
    const systemText = `${SYSTEM_INSTRUCTION_JSON_ONLY}\n${buildEffortInstruction(effort)}`;

    const messages = [
        { role: "system", content: systemText },
        { role: "user", content: promptText },
    ];

    const mappedEffort = effort === "xhigh" ? "high" : effort;
    const isReasoningModel = /(deepseek|qwen3|qwq|nemotron|o1|o3|o4|gpt-5|gpt-6|grok-4|grok-3-mini|kimi|glm-5|step-3|minimax)/i.test(model);

    const primaryPayload: Record<string, unknown> = {
        model,
        messages,
        temperature: 0.65,
        max_tokens: effort === "low" ? 512 : 1200,
    };

    if (provider === "nvidia") {
        if (isReasoningModel) {
            primaryPayload.reasoning_effort = mappedEffort;
            primaryPayload.chat_template_kwargs = {
                thinking: effort !== "low",
                enable_thinking: effort !== "low",
            };
        }
    } else {
        primaryPayload.response_format = { type: "json_object" };
        if (isReasoningModel) {
            primaryPayload.reasoning_effort = mappedEffort;
        }
    }

    const fallbackPayload: Record<string, unknown> = {
        model,
        messages,
        temperature: 0.65,
        max_tokens: 800,
    };

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
    };
    if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
    }

    for (let attempt = 0; attempt < 2; attempt++) {
        const payloadToUse = attempt === 0 ? primaryPayload : fallbackPayload;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify(payloadToUse),
                signal: controller.signal,
            });
            if (!response.ok) {
                const errBody = await response.text().catch(() => "");
                if (attempt === 0 && (response.status === 400 || response.status === 422)) {
                    continue;
                }
                return {
                    ok: false,
                    error: `${provider.toUpperCase()} HTTP ${response.status}: ${errBody.slice(0, 260) || response.statusText}`,
                };
            }

            const data = (await response.json()) as {
                choices?: Array<{
                    message?: {
                        content?: string | null;
                        reasoning_content?: string | null;
                    };
                }>;
            };
            const firstMsg = data?.choices?.[0]?.message;
            const content = String(firstMsg?.content || "").trim();
            const reasoningContent = String(firstMsg?.reasoning_content || "").trim();
            if (!content && !reasoningContent) {
                return { ok: false, error: `${provider.toUpperCase()} returned an empty message choice.` };
            }
            const combined = reasoningContent && content
                ? `<think>${reasoningContent}</think>\n${content}`
                : content || reasoningContent;
            return { ok: true, rawText: combined };
        } catch (err) {
            const isAbort = err instanceof Error && err.name === "AbortError";
            if (isAbort) {
                return { ok: false, error: `${provider.toUpperCase()} request timed out after ${Math.round(timeoutMs / 1000)}s.` };
            }
            return {
                ok: false,
                error: `${provider.toUpperCase()} request failed: ${err instanceof Error ? err.message : String(err)}`,
            };
        } finally {
            clearTimeout(timer);
        }
    }

    return { ok: false, error: `${provider.toUpperCase()} request failed after retry.` };
}

// ============================================================================
// Provider 3: Local Antigravity Language Server (Connect-RPC HTTP JSON)
// ============================================================================

function resolveDiscordProjectId(): string {
    try {
        const projectsDir = path.join(path.dirname(getAntigravityHome()), "config", "projects");
        if (fs.existsSync(projectsDir)) {
            const files = fs.readdirSync(projectsDir).filter(f => f.endsWith(".json"));
            for (const file of files) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(projectsDir, file), "utf8")) as {
                        id?: string;
                        name?: string;
                    };
                    if (String(data.name || "").trim().toLowerCase() === "discord" && data.id) {
                        return String(data.id);
                    }
                } catch {
                    // continue
                }
            }
        }
    } catch {
        // continue
    }
    return DISCORD_ANTIGRAVITY_PROJECT_ID;
}

async function discoverAntigravityLs(forceRefresh = false): Promise<LsDiscoveryCache | null> {
    if (!forceRefresh && lsCache && Date.now() - lsCache.discoveredAt < 120_000) {
        return lsCache;
    }

    const envAddr = (process.env.ANTIGRAVITY_LS_ADDRESS || "").trim();
    const envCsrf = (process.env.ANTIGRAVITY_CSRF_TOKEN || "").trim();
    if (!forceRefresh && envAddr && envCsrf) {
        const normalizedAddr = envAddr.toLowerCase().startsWith("localhost:")
            ? `127.0.0.1:${envAddr.split(":")[1]}`
            : envAddr;
        lsCache = {
            lsAddress: normalizedAddr,
            csrfToken: envCsrf,
            discoveredAt: Date.now(),
        };
        return lsCache;
    }

    if (process.platform !== "win32") {
        return null;
    }

    const pwsh = findPwshExecutable();
    const script = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "$procs = Get-CimInstance Win32_Process -Filter \"Name = 'language_server.exe'\"",
        "foreach ($p in $procs) {",
        "  $m = [regex]::Match($p.CommandLine, '--csrf_token\\s+([a-fA-F0-9\\-]+)')",
        "  if ($m.Success) {",
        "    $ports = Get-NetTCPConnection -OwningProcess $p.ProcessId -State Listen | Where-Object { $_.LocalAddress -eq '127.0.0.1' } | Select-Object -ExpandProperty LocalPort",
        "    $maxPort = ($ports | Measure-Object -Maximum).Maximum",
        "    if ($maxPort) {",
        "      Write-Output (\"{\"\"pid\"\":\" + $p.ProcessId + \",\"\"port\"\":\" + $maxPort + \",\"\"csrf\"\":\"\"\" + $m.Groups[1].Value + \"\"\"}\")",
        "      break",
        "    }",
        "  }",
        "}",
    ].join("; ");

    const res = await runHiddenSubprocess({
        executable: pwsh,
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        timeoutMs: 6000,
    });

    const line = res.stdout
        .split(/\r?\n/)
        .map(l => l.trim())
        .find(l => l.startsWith("{") && l.endsWith("}"));
    if (!line) {
        return null;
    }

    try {
        const parsed = JSON.parse(line) as { pid?: number; port?: number; csrf?: string; };
        if (parsed.port && parsed.csrf) {
            lsCache = {
                lsAddress: `127.0.0.1:${parsed.port}`,
                csrfToken: parsed.csrf,
                pid: parsed.pid,
                discoveredAt: Date.now(),
            };
            return lsCache;
        }
    } catch {
        // ignore
    }
    return null;
}

async function postAntigravityConnectRpc(
    lsAddress: string,
    csrfToken: string,
    method: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
): Promise<Record<string, unknown>> {
    const url = `http://${lsAddress}/exa.language_server_pb.LanguageServerService/${method}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Connect-Protocol-Version": "1",
                "x-codeium-csrf-token": csrfToken,
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`Connect-RPC ${method} HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        const raw = await res.text();
        return raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } finally {
        clearTimeout(timer);
    }
}

function mapAntigravityModelEnum(model?: string): { normalizedModel: string; modelEnum: string; } {
    const raw = String(model || "pro").trim().toLowerCase();
    if (
        raw === "flash" ||
        raw === "flash-low" ||
        raw === "flash_low" ||
        raw === "flash_lite" ||
        raw === "3.8-flash-low" ||
        raw === "gemini-3.8-flash" ||
        raw === "gemini-3.8-flash-low" ||
        raw === "model_placeholder_m320"
    ) {
        return { normalizedModel: "flash", modelEnum: "MODEL_PLACEHOLDER_M320" };
    }
    return { normalizedModel: "pro", modelEnum: "MODEL_PLACEHOLDER_M419" };
}

function getTranscriptFileForCascade(cascadeId: string): string | null {
    const logsDir = path.join(getAntigravityHome(), "brain", cascadeId, ".system_generated", "logs");
    const fullPath = path.join(logsDir, "transcript_full.jsonl");
    const shortPath = path.join(logsDir, "transcript.jsonl");
    if (fs.existsSync(fullPath)) return fullPath;
    if (fs.existsSync(shortPath)) return shortPath;
    return null;
}

function getLatestAntigravityStepIndex(cascadeId: string): { latestStep: number; lineCount: number; } {
    const file = getTranscriptFileForCascade(cascadeId);
    if (!file) return { latestStep: -1, lineCount: 0 };
    try {
        const stat = fs.statSync(file);
        if (stat.size > ANTIGRAVITY_MAX_TRANSCRIPT_BYTES) {
            return { latestStep: -1, lineCount: ANTIGRAVITY_MAX_SESSION_STEPS + 1 };
        }
        const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(l => l.trim().length > 0);
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const parsed = JSON.parse(lines[i]) as { step_index?: number; };
                if (typeof parsed.step_index === "number") {
                    return { latestStep: parsed.step_index, lineCount: lines.length };
                }
            } catch {
                // continue
            }
        }
        return { latestStep: -1, lineCount: lines.length };
    } catch {
        return { latestStep: -1, lineCount: 0 };
    }
}

async function pollAntigravityStep(
    cascadeId: string,
    afterStep: number,
    timeoutMs: number,
): Promise<{ stepIndex: number; content: string; } | null> {
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    while (Date.now() < deadline) {
        const file = getTranscriptFileForCascade(cascadeId);
        if (file) {
            try {
                const stat = fs.statSync(file);
                if (stat.size <= ANTIGRAVITY_MAX_TRANSCRIPT_BYTES) {
                    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
                    for (let i = lines.length - 1; i >= 0; i--) {
                        const line = lines[i].trim();
                        if (!line) continue;
                        const step = JSON.parse(line) as {
                            step_index?: number;
                            source?: string;
                            type?: string;
                            status?: string;
                            content?: string;
                        };
                        const stepIdx = typeof step.step_index === "number" ? step.step_index : 0;
                        if (
                            stepIdx > afterStep &&
                            step.source === "MODEL" &&
                            step.type === "PLANNER_RESPONSE" &&
                            step.status === "DONE" &&
                            typeof step.content === "string" &&
                            step.content.trim()
                        ) {
                            return { stepIndex: stepIdx, content: step.content.trim() };
                        }
                    }
                }
            } catch {
                // continue polling
            }
        }
        await new Promise(r => setTimeout(r, 100));
    }
    return null;
}

async function callAntigravityCliFallback(
    agyBin: string,
    args: GenerateDecisionArgs,
    promptText: string,
    normalizedModel: string,
    effort: EffortLevel,
    projectId: string,
    timeoutMs: number,
): Promise<{ ok: boolean; rawText?: string; sessionId?: string; error?: string; }> {
    const channelId = String(args.channelId || "global");
    const reuseSession = args.reuseLocalSession !== false;
    const isAgentApiBat = agyBin.toLowerCase().endsWith("agentapi.bat");
    const baseSubcmd = isAgentApiBat ? [] : ["agentapi"];
    const envOverrides: NodeJS.ProcessEnv = {
        ANTIGRAVITY_PROJECT_ID: projectId,
        ANTIGRAVITY_HOME: getAntigravityHome(),
    };

    let existing = reuseSession ? getChannelSession("antigravity", channelId) : undefined;
    if (
        existing &&
        ((existing.turnCount ?? 0) >= MAX_CLI_SESSION_TURNS ||
            (existing.model && existing.model !== normalizedModel))
    ) {
        deleteChannelSession("antigravity", channelId);
        existing = undefined;
    }
    let activeCascadeId = existing?.sessionId ? existing.sessionId : "";

    if (!activeCascadeId) {
        const seedPrompt = [
            `Policy version: ${ANTIGRAVITY_SESSION_POLICY_VERSION}.`,
            "CRITICAL INSTRUCTION: DO NOT CALL ANY TOOLS (NO send_message, NO read/write tools, NO code execution).",
            buildEffortInstruction(effort),
            "Acknowledge initialization by outputting ONLY this raw JSON: {\"action\": \"silence\", \"persona_id\": null, \"content\": null, \"reply_to\": null}",
        ].join("\n");

        const newConvRes = await runHiddenSubprocess({
            executable: agyBin,
            args: [...baseSubcmd, "new-conversation", "--model", normalizedModel, seedPrompt],
            cwd: getDiscordWorkspaceDir(),
            env: envOverrides,
            timeoutMs: Math.min(20_000, timeoutMs),
        });

        const uuidMatch = (newConvRes.stdout + "\n" + newConvRes.stderr).match(
            /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i
        );
        if (!uuidMatch || !uuidMatch[1]) {
            return {
                ok: false,
                error: `Antigravity agentapi new-conversation failed (code ${newConvRes.code}): ${(newConvRes.stderr || newConvRes.stdout).slice(0, 240)}`,
            };
        }
        activeCascadeId = uuidMatch[1];
    }

    const priorStep = getLatestAntigravityStepIndex(activeCascadeId).latestStep;
    const turnMessage = [
        "CRITICAL INSTRUCTION: DO NOT CALL ANY TOOLS (NO send_message, NO read/write tools).",
        buildEffortInstruction(effort),
        "Output your decision immediately as a single raw valid JSON object.",
        "",
        promptText,
    ].join("\n");

    const sendRes = await runHiddenSubprocess({
        executable: agyBin,
        args: [...baseSubcmd, "send-message", activeCascadeId, turnMessage],
        cwd: getDiscordWorkspaceDir(),
        env: envOverrides,
        timeoutMs: Math.min(20_000, timeoutMs),
    });

    if (sendRes.code !== 0 && !sendRes.stdout.trim()) {
        deleteChannelSession("antigravity", channelId);
        return {
            ok: false,
            error: `Antigravity agentapi send-message failed (code ${sendRes.code}): ${(sendRes.stderr || sendRes.stdout).slice(0, 240)}`,
        };
    }

    const stepResult = await pollAntigravityStep(activeCascadeId, priorStep, Math.max(5000, timeoutMs - 2000));
    const rawOutput = stepResult?.content || sendRes.stdout.trim();
    if (!rawOutput) {
        return {
            ok: false,
            error: "Antigravity agentapi fallback timed out waiting for response step.",
        };
    }

    if (reuseSession) {
        setChannelSession({
            provider: "antigravity",
            channelId,
            sessionId: activeCascadeId,
            model: normalizedModel,
            lastStepIndex: stepResult?.stepIndex ?? priorStep,
            turnCount: (existing?.turnCount ?? 0) + 1,
            createdAt: existing?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
        });
    }

    return {
        ok: true,
        rawText: rawOutput,
        sessionId: activeCascadeId,
    };
}

async function callAntigravityProvider(
    args: GenerateDecisionArgs,
    promptText: string,
    model: string,
    effort: EffortLevel,
    timeoutMs: number,
): Promise<{ ok: boolean; rawText?: string; sessionId?: string; error?: string; }> {
    const channelId = String(args.channelId || "global");
    const reuseSession = args.reuseLocalSession !== false;
    const { normalizedModel, modelEnum } = mapAntigravityModelEnum(model);
    const projectId = resolveDiscordProjectId();

    let ls = await discoverAntigravityLs(false);
    if (!ls) {
        ls = await discoverAntigravityLs(true);
    }
    if (!ls) {
        const agyBin = findAntigravityExecutable(args.antigravityPath);
        if (agyBin) {
            return callAntigravityCliFallback(agyBin, args, promptText, normalizedModel, effort, projectId, timeoutMs);
        }
        return {
            ok: false,
            error: "Antigravity language_server.exe is not running or could not be discovered. Make sure Antigravity IDE is open.",
        };
    }

    const deadline = Date.now() + timeoutMs;

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            let activeCascadeId: string | null = null;
            let priorStep = -1;

            const savedRecord = reuseSession ? getChannelSession("antigravity", channelId) : undefined;
            if (
                savedRecord?.sessionId &&
                /^[A-Za-z0-9_-]{1,128}$/.test(savedRecord.sessionId) &&
                (!savedRecord.model || savedRecord.model === normalizedModel)
            ) {
                try {
                    const meta = await postAntigravityConnectRpc(
                        ls.lsAddress,
                        ls.csrfToken,
                        "GetConversationMetadata",
                        { conversationId: savedRecord.sessionId },
                        5000,
                    );
                    const metadataObj = (meta?.metadata as Record<string, unknown> | undefined) ?? {};
                    const sessionProjId = String(metadataObj.projectId || "");
                    const { latestStep, lineCount } = getLatestAntigravityStepIndex(savedRecord.sessionId);

                    if (
                        (!sessionProjId || sessionProjId === projectId) &&
                        lineCount < ANTIGRAVITY_MAX_SESSION_STEPS
                    ) {
                        activeCascadeId = savedRecord.sessionId;
                        priorStep = Math.max(savedRecord.lastStepIndex ?? -1, latestStep);
                    } else {
                        deleteChannelSession("antigravity", channelId);
                    }
                } catch {
                    deleteChannelSession("antigravity", channelId);
                }
            } else if (savedRecord?.sessionId && savedRecord.model && savedRecord.model !== normalizedModel) {
                deleteChannelSession("antigravity", channelId);
            }

            if (!activeCascadeId) {
                const customPrompt = String(args.customPrompt || args.customSystemPrompt || args.systemPrompt || "").trim();
                const isOverrideMode = args.promptMode === "override" && customPrompt.length > 0;
                const seedPrompt = (
                    isOverrideMode
                        ? [
                            `Policy version: ${ANTIGRAVITY_SESSION_POLICY_VERSION}.`,
                            "CRITICAL INSTRUCTION: DO NOT CALL ANY TOOLS (NO send_message, NO read/write tools, NO code execution).",
                            buildEffortInstruction(effort),
                            "Follow the user's custom system prompt override and output ONLY valid JSON matching the schema.",
                            `CUSTOM_SYSTEM_PROMPT_OVERRIDE:\n${customPrompt}`,
                            "Schema: {\"action\":\"silence|reply\",\"persona_id\":string|null,\"content\":string|null,\"reply_to\":string|null,\"delay_seconds\":number|null,\"reasoning\":string|null}",
                            "",
                            "Acknowledge initialization by outputting ONLY this raw JSON: {\"action\": \"silence\", \"persona_id\": null, \"content\": null, \"reply_to\": null}",
                        ]
                        : [
                            `Policy version: ${ANTIGRAVITY_SESSION_POLICY_VERSION}.`,
                            "CRITICAL INSTRUCTION: DO NOT CALL ANY TOOLS (NO send_message, NO read/write tools, NO code execution).",
                            buildEffortInstruction(effort),
                            "You are a text-only decision generator for a Discord conversation across active hangout & gaming communities (ChillZone, Socialize, VALORANT). Follow the per-turn instructions, ACTIVE SERVER RULES, and JSON schema.",
                            "CORE GUIDELINES:",
                            "- Keep replies natural, warm, sweet, and concise (typically 5 to 9 words on a single line) in casual lowercase text.",
                            "- Never argue for no reason, never pick pointless fights, and never trash-talk or backtalk moderators or staff. Stay silent when staff are handling a situation or on bot commands ('$afk', '$warn', '$purge', ',a', '/emergency').",
                            "- Strictly follow the ACTIVE SERVER RULES for the current channel.",
                            "Schema: {\"action\":\"silence|reply\",\"persona_id\":string|null,\"content\":string|null,\"reply_to\":string|null,\"delay_seconds\":number|null,\"reasoning\":string|null}",
                            "",
                            "Acknowledge initialization by outputting ONLY this raw JSON: {\"action\": \"silence\", \"persona_id\": null, \"content\": null, \"reply_to\": null}",
                        ]
                ).join("\n");

                const startResp = await postAntigravityConnectRpc(
                    ls.lsAddress,
                    ls.csrfToken,
                    "StartCascade",
                    {
                        source: "CORTEX_TRAJECTORY_SOURCE_CLI",
                        trajectoryType: "CORTEX_TRAJECTORY_TYPE_CASCADE",
                        requestedModel: modelEnum,
                        projectEnvConfig: {
                            projectId,
                            defaultProjectEnvironment: {},
                        },
                    },
                    10_000,
                );

                const cascadeId = String(startResp.cascadeId || "").trim();
                if (!cascadeId) {
                    throw new Error("StartCascade returned no cascadeId");
                }

                await postAntigravityConnectRpc(
                    ls.lsAddress,
                    ls.csrfToken,
                    "SendUserCascadeMessage",
                    {
                        cascadeId,
                        items: [{ text: seedPrompt }],
                        cascadeConfig: {
                            plannerConfig: {
                                planModel: modelEnum,
                            },
                        },
                    },
                    10_000,
                );

                const warmupStep = await pollAntigravityStep(cascadeId, -1, 15_000);
                priorStep = warmupStep ? warmupStep.stepIndex : getLatestAntigravityStepIndex(cascadeId).latestStep;
                activeCascadeId = cascadeId;

                if (reuseSession) {
                    setChannelSession({
                        provider: "antigravity",
                        channelId,
                        sessionId: cascadeId,
                        model: normalizedModel,
                        lastStepIndex: priorStep,
                        turnCount: 0,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                    });
                }
            }

            const { latestStep } = getLatestAntigravityStepIndex(activeCascadeId);
            priorStep = Math.max(priorStep, latestStep);

            let turnMessage = [
                "CRITICAL INSTRUCTION: DO NOT CALL ANY TOOLS (NO send_message, NO read/write tools).",
                buildEffortInstruction(effort),
                "Output your decision immediately as a single raw valid JSON object.",
                "",
                promptText,
            ].join("\n");

            if (turnMessage.length > 20_000) {
                turnMessage = `${turnMessage.slice(0, 20_000)}\n... [truncated] ...\nOutput JSON decision now.`;
            }

            await postAntigravityConnectRpc(
                ls.lsAddress,
                ls.csrfToken,
                "SendAgentMessage",
                {
                    content: turnMessage,
                    recipient: activeCascadeId,
                },
                12_000,
            );

            const remainingMs = Math.max(5000, deadline - Date.now());
            const stepResult = await pollAntigravityStep(activeCascadeId, priorStep, remainingMs);
            if (!stepResult) {
                throw new Error("Timed out waiting for Antigravity cascade response step.");
            }

            if (reuseSession) {
                const existing = getChannelSession("antigravity", channelId);
                setChannelSession({
                    provider: "antigravity",
                    channelId,
                    sessionId: activeCascadeId,
                    model: normalizedModel,
                    lastStepIndex: stepResult.stepIndex,
                    turnCount: (existing?.turnCount ?? 0) + 1,
                    createdAt: existing?.createdAt ?? Date.now(),
                    updatedAt: Date.now(),
                });
            }

            return {
                ok: true,
                rawText: stepResult.content,
                sessionId: activeCascadeId,
            };
        } catch (err) {
            deleteChannelSession("antigravity", channelId);
            if (attempt === 0) {
                const refreshed = await discoverAntigravityLs(true);
                if (refreshed) {
                    ls = refreshed;
                    continue;
                }
            }
            return {
                ok: false,
                error: `Antigravity provider failed: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }

    return { ok: false, error: "Antigravity provider failed after retry." };
}

// ============================================================================
// Provider 4: Local OpenAI Codex CLI (codex.exe exec / exec resume)
// ============================================================================

async function callCodexProvider(
    args: GenerateDecisionArgs,
    promptText: string,
    model: string,
    effort: EffortLevel,
    timeoutMs: number,
): Promise<{ ok: boolean; rawText?: string; sessionId?: string; error?: string; }> {
    const codexBin = findCodexExecutable(args.codexPath || args.codexCliPath);
    if (!codexBin) {
        return {
            ok: false,
            error: "Local Codex CLI (codex.exe) was not found under %LOCALAPPDATA%\\OpenAI\\Codex\\bin.",
        };
    }

    const channelId = String(args.channelId || "global");
    const reuseSession = args.reuseLocalSession !== false;
    const fullTurnPrompt = [
        SYSTEM_INSTRUCTION_JSON_ONLY,
        buildEffortInstruction(effort),
        "CRITICAL INSTRUCTION: Do NOT run shell commands, do NOT read/write files, and do NOT call any tools or MCP servers. Respond immediately with ONLY the raw JSON object.",
        "",
        promptText,
    ].join("\n");

    let activeModel = model;
    for (let attempt = 0; attempt < 2; attempt++) {
        let existing = reuseSession ? getChannelSession("codex", channelId) : undefined;
        if (
            existing &&
            ((existing.turnCount ?? 0) >= MAX_CLI_SESSION_TURNS ||
                (existing.model && existing.model !== activeModel))
        ) {
            deleteChannelSession("codex", channelId);
            existing = undefined;
        }
        const savedSession = existing;
        const outFile = path.join(os.tmpdir(), `autocord_codex_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);

        const cliArgs: string[] = ["exec"];
        if (savedSession?.sessionId) {
            cliArgs.push(
                "-s",
                "read-only",
                "resume",
                savedSession.sessionId,
                "-",
                "--skip-git-repo-check",
                "--ignore-user-config",
                "--ignore-rules",
                "-m",
                activeModel,
                "-c",
                `model_reasoning_effort="${effort}"`,
                "--json",
                "-o",
                outFile,
            );
        } else {
            cliArgs.push(
                "--skip-git-repo-check",
                "--ignore-user-config",
                "--ignore-rules",
                "-s",
                "read-only",
                "-m",
                activeModel,
                "-c",
                `model_reasoning_effort="${effort}"`,
                "--json",
                "-o",
                outFile,
                "-",
            );
        }

        try {
            const res = await runHiddenSubprocess({
                executable: codexBin,
                args: cliArgs,
                cwd: getDiscordWorkspaceDir(),
                stdinText: fullTurnPrompt,
                timeoutMs,
            });

            let discoveredThreadId: string | undefined = savedSession?.sessionId;
            let lastAgentMessageFromJsonl = "";

            for (const rawLine of res.stdout.split(/\r?\n/)) {
                const line = rawLine.trim();
                if (!line.startsWith("{")) continue;
                try {
                    const evt = JSON.parse(line) as Record<string, unknown>;
                    const threadIdCandidate = evt.thread_id || evt.session_id || evt.conversation_id;
                    if (typeof threadIdCandidate === "string" && threadIdCandidate.trim()) {
                        discoveredThreadId = threadIdCandidate.trim();
                    }
                    const item = evt.item as Record<string, unknown> | undefined;
                    if (item && typeof item.text === "string" && item.text.trim()) {
                        lastAgentMessageFromJsonl = item.text.trim();
                    } else if (typeof evt.message === "string" && evt.message.trim()) {
                        lastAgentMessageFromJsonl = evt.message.trim();
                    }
                } catch {
                    // ignore non-JSON line
                }
            }

            let fileOutput = "";
            try {
                if (fs.existsSync(outFile)) {
                    fileOutput = fs.readFileSync(outFile, "utf8").trim();
                    fs.unlinkSync(outFile);
                }
            } catch {
                // ignore
            }

            const finalOutput = fileOutput || lastAgentMessageFromJsonl || res.stdout.trim();
            const hasValidDecision = isValidDecisionOutput(finalOutput);
            if ((res.code !== 0 && !hasValidDecision) || !finalOutput) {
                const combinedErr = `${res.stdout}\n${res.stderr}`;
                const isModelUnsupported =
                    /Model metadata for .* not found|is not supported when using Codex/i.test(combinedErr) &&
                    activeModel !== DEFAULT_MODEL_BY_PROVIDER.codex;
                if (attempt === 0 && (savedSession?.sessionId || isModelUnsupported)) {
                    if (savedSession?.sessionId) {
                        deleteChannelSession("codex", channelId);
                    }
                    if (isModelUnsupported) {
                        activeModel = DEFAULT_MODEL_BY_PROVIDER.codex;
                    }
                    continue;
                }
                return {
                    ok: false,
                    error: `Codex CLI exited with code ${res.code}: ${(res.stderr || res.stdout || "empty output").slice(0, 260)}`,
                };
            }

            if (reuseSession && discoveredThreadId) {
                const existing = getChannelSession("codex", channelId);
                setChannelSession({
                    provider: "codex",
                    channelId,
                    sessionId: discoveredThreadId,
                    model: activeModel,
                    turnCount: (existing?.turnCount ?? 0) + 1,
                    createdAt: existing?.createdAt ?? Date.now(),
                    updatedAt: Date.now(),
                });
            }

            return {
                ok: true,
                rawText: finalOutput,
                sessionId: discoveredThreadId,
            };
        } finally {
            try {
                if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
            } catch {
                // ignore
            }
        }
    }

    return { ok: false, error: "Codex CLI failed after session reset retry." };
}

// ============================================================================
// Provider 5: Local Claude Code CLI + Anthropic Messages API Fallback
// ============================================================================

async function callAnthropicMessagesApi(
    apiKey: string,
    promptText: string,
    model: string,
    effort: EffortLevel,
    timeoutMs: number,
): Promise<{ ok: boolean; rawText?: string; error?: string; }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const body: Record<string, unknown> = {
            model,
            max_tokens: 1024,
            system: `${SYSTEM_INSTRUCTION_JSON_ONLY}\n${buildEffortInstruction(effort)}`,
            messages: [{ role: "user", content: promptText }],
        };
        const res = await fetch(DEFAULT_ANTHROPIC_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => "");
            return {
                ok: false,
                error: `Anthropic API HTTP ${res.status}: ${errText.slice(0, 240) || res.statusText}`,
            };
        }
        const data = (await res.json()) as {
            content?: Array<{ type?: string; text?: string; thinking?: string; }>;
        };
        const blocks = data.content || [];
        const textParts = blocks
            .filter(b => b.type === "text" && typeof b.text === "string")
            .map(b => b.text!.trim());
        const rawText = textParts.join("\n").trim();
        if (!rawText) {
            return { ok: false, error: "Anthropic API returned no text content blocks." };
        }
        return { ok: true, rawText };
    } catch (err) {
        const isAbort = err instanceof Error && err.name === "AbortError";
        return {
            ok: false,
            error: isAbort
                ? "Anthropic API request timed out."
                : `Anthropic API failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    } finally {
        clearTimeout(timer);
    }
}

async function callClaudeProvider(
    args: GenerateDecisionArgs,
    promptText: string,
    model: string,
    effort: EffortLevel,
    timeoutMs: number,
): Promise<{ ok: boolean; rawText?: string; sessionId?: string; error?: string; }> {
    const claudeBin = findClaudeExecutable(args.claudePath || args.claudeCliPath);
    const anthropicKey = (
        args.anthropicApiKey ||
        args.apiKey ||
        process.env.ANTHROPIC_API_KEY ||
        ""
    ).trim();

    if (!claudeBin) {
        if (anthropicKey) {
            return callAnthropicMessagesApi(anthropicKey, promptText, model, effort, timeoutMs);
        }
        return {
            ok: false,
            error: "Local Claude Code CLI (claude) was not found and no Anthropic API key is configured.",
        };
    }

    const channelId = String(args.channelId || "global");
    const reuseSession = args.reuseLocalSession !== false;
    const fullTurnPrompt = [
        SYSTEM_INSTRUCTION_JSON_ONLY,
        buildEffortInstruction(effort),
        "CRITICAL INSTRUCTION: Do NOT run tools, bash commands, or file operations. Output ONLY the raw JSON decision object.",
        "",
        promptText,
    ].join("\n");

    for (let attempt = 0; attempt < 2; attempt++) {
        let existing = reuseSession ? getChannelSession("claude", channelId) : undefined;
        if (
            existing &&
            ((existing.turnCount ?? 0) >= MAX_CLI_SESSION_TURNS ||
                (existing.model && existing.model !== model))
        ) {
            deleteChannelSession("claude", channelId);
            existing = undefined;
        }
        const isResume = Boolean(existing?.sessionId);
        const sessionId = existing?.sessionId || randomUUID();

        const cliArgs: string[] = [
            "-p",
            "--output-format",
            "json",
            "--model",
            model,
            "--effort",
            effort === "xhigh" ? "high" : effort,
        ];
        if (isResume) {
            cliArgs.push("--resume", sessionId);
        } else if (reuseSession) {
            cliArgs.push("--session-id", sessionId);
        }

        const res = await runHiddenSubprocess({
            executable: claudeBin,
            args: cliArgs,
            cwd: getDiscordWorkspaceDir(),
            stdinText: fullTurnPrompt,
            timeoutMs,
        });

        let extractedText = res.stdout.trim();
        let resolvedSessionId = sessionId;
        let cliReportedError = false;
        try {
            const parsed = JSON.parse(extractedText) as {
                is_error?: boolean;
                result?: string;
                content?: string;
                session_id?: string;
            };
            if (parsed.is_error === true) {
                cliReportedError = true;
            }
            if (typeof parsed.result === "string" && parsed.result.trim()) {
                extractedText = parsed.result.trim();
            } else if (typeof parsed.content === "string" && parsed.content.trim()) {
                extractedText = parsed.content.trim();
            }
            if (typeof parsed.session_id === "string" && parsed.session_id.trim()) {
                resolvedSessionId = parsed.session_id.trim();
            }
        } catch {
            // Keep raw stdout
        }

        const hasValidDecision = !cliReportedError && isValidDecisionOutput(extractedText);
        if (cliReportedError || (res.code !== 0 && !hasValidDecision) || !extractedText) {
            if (isResume && attempt === 0) {
                deleteChannelSession("claude", channelId);
                continue;
            }
            if (anthropicKey) {
                return callAnthropicMessagesApi(anthropicKey, promptText, model, effort, timeoutMs);
            }
            return {
                ok: false,
                error: `Claude CLI exited with code ${res.code}: ${(res.stderr || extractedText || res.stdout).slice(0, 240)}`,
            };
        }

        if (reuseSession) {
            setChannelSession({
                provider: "claude",
                channelId,
                sessionId: resolvedSessionId,
                model,
                turnCount: (existing?.turnCount ?? 0) + 1,
                createdAt: existing?.createdAt ?? Date.now(),
                updatedAt: Date.now(),
            });
        }

        return {
            ok: true,
            rawText: extractedText,
            sessionId: resolvedSessionId,
        };
    }

    return { ok: false, error: "Claude CLI failed after retry." };
}

// ============================================================================
// Provider 6: Local Grok CLI (C:\Users\user\.grok\bin\grok.exe) + xAI Fallback
// ============================================================================

const GROK_DECISION_JSON_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        action: { type: "string", enum: ["silence", "reply"] },
        persona_id: { type: ["string", "null"] },
        content: { type: ["string", "null"] },
        reply_to: { type: ["string", "null"] },
        delay_seconds: { type: ["number", "null"] },
        reasoning: { type: ["string", "null"] },
    },
    required: ["action"],
});

async function callGrokProvider(
    args: GenerateDecisionArgs,
    promptText: string,
    model: string,
    effort: EffortLevel,
    timeoutMs: number,
): Promise<{ ok: boolean; rawText?: string; sessionId?: string; error?: string; }> {
    const grokBin = findGrokExecutable(args.grokPath || args.grokCliPath);
    const xaiKey = (
        args.xaiApiKey ||
        args.grokApiKey ||
        args.apiKey ||
        process.env.XAI_API_KEY ||
        process.env.GROK_API_KEY ||
        ""
    ).trim();

    if (!grokBin) {
        if (xaiKey) {
            return callOpenAiCompatibleProvider("grok", args, promptText, model, effort, timeoutMs);
        }
        return {
            ok: false,
            error: "Local Grok CLI (~/.grok/bin/grok.exe) was not found and no xAI API key is configured.",
        };
    }

    const channelId = String(args.channelId || "global");
    const reuseSession = args.reuseLocalSession !== false;
    const fullTurnPrompt = [
        SYSTEM_INSTRUCTION_JSON_ONLY,
        buildEffortInstruction(effort),
        "CRITICAL INSTRUCTION: Do NOT call any tools, do NOT read files, and do NOT run commands. All persona profiles and Discord messages are already provided below. Output ONLY the raw JSON object immediately.",
        "",
        promptText,
    ].join("\n");

    for (let attempt = 0; attempt < 2; attempt++) {
        let existing = reuseSession ? getChannelSession("grok", channelId) : undefined;
        if (
            existing &&
            ((existing.turnCount ?? 0) >= MAX_CLI_SESSION_TURNS ||
                (existing.model && existing.model !== model))
        ) {
            deleteChannelSession("grok", channelId);
            existing = undefined;
        }
        const isResume = Boolean(existing?.sessionId);
        const sessionId = existing?.sessionId || randomUUID();
        const usePromptFile = fullTurnPrompt.length > 7000;
        const promptFile = path.join(os.tmpdir(), `autocord_grok_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);

        try {
            const cliArgs: string[] = [];
            if (usePromptFile) {
                fs.writeFileSync(promptFile, fullTurnPrompt, "utf8");
                cliArgs.push("--prompt-file", promptFile);
            } else {
                cliArgs.push("-p", fullTurnPrompt);
            }

            cliArgs.push(
                "-m",
                model,
                "--reasoning-effort",
                effort,
                "--json-schema",
                GROK_DECISION_JSON_SCHEMA,
                "--no-subagents",
                "--disable-web-search",
                "--no-plan",
                "--max-turns",
                "1",
                "--tools",
                "",
                "--permission-mode",
                "dontAsk",
            );

            if (isResume) {
                cliArgs.push("--resume", sessionId);
            } else if (reuseSession) {
                cliArgs.push("--session-id", sessionId);
            }

            const res = await runHiddenSubprocess({
                executable: grokBin,
                args: cliArgs,
                cwd: getDiscordWorkspaceDir(),
                timeoutMs,
            });

            const output = res.stdout.trim();
            const hasValidDecision = isValidDecisionOutput(output);
            if ((res.code !== 0 && !hasValidDecision) || !output) {
                if (isResume && attempt === 0) {
                    deleteChannelSession("grok", channelId);
                    continue;
                }
                if (xaiKey) {
                    return callOpenAiCompatibleProvider("grok", args, promptText, model, effort, timeoutMs);
                }
                return {
                    ok: false,
                    error: `Grok CLI exited with code ${res.code}: ${(res.stderr || res.stdout || "empty output").slice(0, 260)}`,
                };
            }

            if (reuseSession) {
                setChannelSession({
                    provider: "grok",
                    channelId,
                    sessionId,
                    model,
                    turnCount: (existing?.turnCount ?? 0) + 1,
                    createdAt: existing?.createdAt ?? Date.now(),
                    updatedAt: Date.now(),
                });
            }

            return {
                ok: true,
                rawText: output,
                sessionId,
            };
        } finally {
            try {
                if (fs.existsSync(promptFile)) fs.unlinkSync(promptFile);
            } catch {
                // ignore
            }
        }
    }

    return { ok: false, error: "Grok CLI failed after retry." };
}

// ============================================================================
// Exported IPC Handlers for Equicord Renderer
// ============================================================================

export async function loadPersonas(
    _event: IpcMainInvokeEvent,
    args?: { personasPath?: string; } | string,
): Promise<{
    ok: boolean;
    personas: PersonaProfile[];
    activePersona: PersonaProfile;
    path?: string;
    error?: string;
}> {
    const customPath = typeof args === "string" ? args.trim() : String(args?.personasPath || "").trim();
    const candidates = [
        customPath,
        path.join(getAutocordRepoDir(), "personas.json"),
        path.join(getAutocordRepoDir(), "personas.example.json"),
    ].filter(Boolean);

    for (const candidate of candidates) {
        try {
            if (!fs.existsSync(candidate)) continue;
            const raw = fs.readFileSync(candidate, "utf8");
            const data = JSON.parse(raw) as { personas?: PersonaProfile[]; };
            if (Array.isArray(data?.personas) && data.personas.length > 0) {
                const personas: PersonaProfile[] = data.personas.map(p => ({
                    id: String(p.id || "itsjskt"),
                    display_name: String(p.display_name || p.displayName || p.id || "katie"),
                    displayName: String(p.display_name || p.displayName || p.id || "katie"),
                    style: String(p.style || ""),
                    constraints: Array.isArray(p.constraints) ? p.constraints.map(String) : [],
                    read_only: Boolean(p.read_only),
                    corpus: p.corpus,
                    examples:
                        String(p.id || "").toLowerCase() === "itsjskt"
                            ? ITSJSKT_VOICE_BANK
                            : p.examples,
                }));
                const katie = personas.find(p => p.id.toLowerCase() === "itsjskt") || personas[0];
                return {
                    ok: true,
                    personas,
                    activePersona: katie,
                    path: candidate,
                };
            }
        } catch {
            // Try next candidate
        }
    }

    return {
        ok: true,
        personas: [DEFAULT_KATIE_PERSONA],
        activePersona: DEFAULT_KATIE_PERSONA,
    };
}

export async function generateDecision(
    _event: IpcMainInvokeEvent,
    args: GenerateDecisionArgs,
): Promise<GenerateDecisionResult> {
    const startedAt = Date.now();
    const provider = normalizeProvider(args?.provider);
    const effort = normalizeEffort(args?.effort);
    const model = String(args?.model || DEFAULT_MODEL_BY_PROVIDER[provider]).trim() || DEFAULT_MODEL_BY_PROVIDER[provider];
    const timeoutMs = Math.max(5000, Math.min(90_000, Number(args?.timeoutMs) || 35_000));

    let personas = args?.personas;
    if ((!personas || personas.length === 0) && !args?.persona) {
        const loaded = await loadPersonas(_event, { personasPath: args?.personasPath });
        personas = loaded.personas;
    }

    const promptText = args?.prompt && args.prompt.trim()
        ? args.prompt.trim()
        : buildOrchestratorPrompt({
            ...args,
            personas,
        });

    let callResult: { ok: boolean; rawText?: string; sessionId?: string; error?: string; };

    switch (provider) {
        case "antigravity":
            callResult = await callAntigravityProvider(args, promptText, model, effort, timeoutMs);
            break;
        case "nvidia":
            callResult = await callOpenAiCompatibleProvider("nvidia", args, promptText, model, effort, timeoutMs);
            break;
        case "openai":
            callResult = await callOpenAiCompatibleProvider("openai", args, promptText, model, effort, timeoutMs);
            break;
        case "codex":
            callResult = await callCodexProvider(args, promptText, model, effort, timeoutMs);
            break;
        case "claude":
            callResult = await callClaudeProvider(args, promptText, model, effort, timeoutMs);
            break;
        case "grok":
            callResult = await callGrokProvider(args, promptText, model, effort, timeoutMs);
            break;
    }

    const durationMs = Date.now() - startedAt;

    if (!callResult.ok) {
        return {
            ok: false,
            provider,
            model,
            effort,
            sessionId: callResult.sessionId ?? null,
            durationMs,
            promptUsed: promptText,
            error: callResult.error || `${provider} inference failed.`,
        };
    }

    const messages = args?.messages || [];
    const selfUserId = args?.selfUserId ? String(args.selfUserId) : "";
    const ownMessageIds = messages
        .filter(m => m.isOwnPersona || m.is_own_persona || m.isSelf || (selfUserId && (m.authorId === selfUserId || m.author_id === selfUserId)))
        .map(m => String(m.id))
        .filter(Boolean);
    const ineligibleMessageIds = messages
        .filter(m => {
            const isOwn = Boolean(m.isOwnPersona || m.is_own_persona || m.isSelf || (selfUserId && (m.authorId === selfUserId || m.author_id === selfUserId)));
            const isBot = Boolean((m.isBot || m.is_bot) && !isOwn);
            const isWebhook = Boolean(m.isWebhook || m.is_webhook);
            const isSystem = Boolean(m.isSystem || m.is_system);
            return isBot || isWebhook || isSystem;
        })
        .map(m => String(m.id))
        .filter(Boolean);
    const ineligibleSet = new Set(ineligibleMessageIds);
    const knownMessageIds = messages
        .map(m => String(m.id))
        .filter(id => Boolean(id) && !ineligibleSet.has(id));

    const decision = parseOrchestratorDecision(callResult.rawText || "", {
        personaId: args?.activePersonaId || args?.persona?.id || "itsjskt",
        personas: personas || (args?.persona ? [args.persona] : [DEFAULT_KATIE_PERSONA]),
        knownMessageIds,
        ownMessageIds,
        ineligibleMessageIds,
        messages,
        provider,
        model,
        effort,
        sessionId: callResult.sessionId ?? null,
        durationMs,
    });

    return {
        ok: true,
        decision,
        provider,
        model,
        effort,
        sessionId: callResult.sessionId ?? null,
        durationMs,
        rawText: callResult.rawText,
        promptUsed: promptText,
    };
}

export async function resetSession(
    _event: IpcMainInvokeEvent,
    args?: { channelId?: string; provider?: ProviderKind; all?: boolean; } | string,
): Promise<{ ok: boolean; clearedCount: number; }> {
    ensureSessionsLoaded();
    let clearedCount = 0;

    if (typeof args === "string") {
        const cid = args.trim();
        for (const [k, v] of Array.from(sessionStore.entries())) {
            if (!cid || v.channelId === cid) {
                sessionStore.delete(k);
                clearedCount += 1;
            }
        }
    } else if (!args || args.all || (!args.channelId && !args.provider)) {
        clearedCount = sessionStore.size;
        sessionStore.clear();
    } else {
        for (const [k, v] of Array.from(sessionStore.entries())) {
            const matchChannel = !args.channelId || v.channelId === args.channelId;
            const matchProvider = !args.provider || v.provider === args.provider;
            if (matchChannel && matchProvider) {
                sessionStore.delete(k);
                clearedCount += 1;
            }
        }
    }

    persistSessionsToDisk();
    return { ok: true, clearedCount };
}

export async function checkProvidersHealth(
    _event: IpcMainInvokeEvent,
    args: Partial<GenerateDecisionArgs> = {},
): Promise<ProviderHealthResult> {
    ensureSessionsLoaded();

    const countSessions = (p: ProviderKind) =>
        Array.from(sessionStore.values()).filter(s => s.provider === p).length;

    const ls = await discoverAntigravityLs(false);
    const agyExe = findAntigravityExecutable(args.antigravityPath);
    const codexExe = findCodexExecutable(args.codexPath || args.codexCliPath);
    const claudeExe = findClaudeExecutable(args.claudePath || args.claudeCliPath);
    const grokExe = findGrokExecutable(args.grokPath || args.grokCliPath);

    const nvidiaKey = Boolean((args.nvidiaApiKey || args.apiKey || process.env.NVIDIA_API_KEY || process.env.NGC_API_KEY || "").trim());
    const openaiKey = Boolean((args.openaiApiKey || args.apiKey || process.env.OPENAI_API_KEY || "").trim());
    const openaiBase = (args.openaiBaseUrl || args.baseUrl || process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL).trim();
    const isLocalOpenAi = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(openaiBase);
    const anthropicKey = Boolean((args.anthropicApiKey || args.apiKey || process.env.ANTHROPIC_API_KEY || "").trim());
    const xaiKey = Boolean((args.xaiApiKey || args.grokApiKey || args.apiKey || process.env.XAI_API_KEY || process.env.GROK_API_KEY || "").trim());

    const providers: Record<ProviderKind, ProviderStatusItem> = {
        antigravity: {
            provider: "antigravity",
            available: Boolean(ls || agyExe),
            healthy: Boolean(ls),
            mode: ls ? "local_rpc" : agyExe ? "local_cli" : "unavailable",
            detail: ls
                ? `Connected to language_server.exe at ${ls.lsAddress} (discord project isolated)`
                : agyExe
                    ? "language_server.exe binary found (start Antigravity IDE for Connect-RPC)"
                    : "Antigravity language_server.exe not found",
            binaryPath: agyExe,
            defaultModel: DEFAULT_MODEL_BY_PROVIDER.antigravity,
            models: PROVIDER_MODEL_SUGGESTIONS.antigravity,
            sessionCount: countSessions("antigravity"),
        },
        nvidia: {
            provider: "nvidia",
            available: nvidiaKey,
            healthy: nvidiaKey,
            mode: nvidiaKey ? "remote_api" : "unavailable",
            detail: nvidiaKey
                ? "NVIDIA Build NIM token configured"
                : "Set NVIDIA Build API key (nvapi-...) in plugin settings",
            binaryPath: null,
            defaultModel: DEFAULT_MODEL_BY_PROVIDER.nvidia,
            models: PROVIDER_MODEL_SUGGESTIONS.nvidia,
            sessionCount: countSessions("nvidia"),
        },
        openai: {
            provider: "openai",
            available: openaiKey || isLocalOpenAi,
            healthy: openaiKey || isLocalOpenAi,
            mode: openaiKey || isLocalOpenAi ? "remote_api" : "unavailable",
            detail: openaiKey
                ? `OpenAI-compatible API ready (${openaiBase})`
                : isLocalOpenAi
                    ? `Local OpenAI-compatible endpoint (${openaiBase})`
                    : "Set OpenAI API key or local base URL in plugin settings",
            binaryPath: null,
            defaultModel: DEFAULT_MODEL_BY_PROVIDER.openai,
            models: PROVIDER_MODEL_SUGGESTIONS.openai,
            sessionCount: countSessions("openai"),
        },
        codex: {
            provider: "codex",
            available: Boolean(codexExe),
            healthy: Boolean(codexExe),
            mode: codexExe ? "local_cli" : "unavailable",
            detail: codexExe
                ? `Local Codex CLI ready (${path.basename(path.dirname(codexExe))}/codex.exe)`
                : "Codex CLI not found in %LOCALAPPDATA%\\OpenAI\\Codex\\bin",
            binaryPath: codexExe,
            defaultModel: DEFAULT_MODEL_BY_PROVIDER.codex,
            models: PROVIDER_MODEL_SUGGESTIONS.codex,
            sessionCount: countSessions("codex"),
        },
        claude: {
            provider: "claude",
            available: Boolean(claudeExe || anthropicKey),
            healthy: Boolean(claudeExe || anthropicKey),
            mode: claudeExe ? "local_cli" : anthropicKey ? "remote_api" : "unavailable",
            detail: claudeExe
                ? `Local Claude Code CLI ready (${claudeExe})`
                : anthropicKey
                    ? "Anthropic Messages API key configured (CLI fallback)"
                    : "Install Claude Code CLI or set Anthropic API key",
            binaryPath: claudeExe,
            defaultModel: DEFAULT_MODEL_BY_PROVIDER.claude,
            models: PROVIDER_MODEL_SUGGESTIONS.claude,
            sessionCount: countSessions("claude"),
        },
        grok: {
            provider: "grok",
            available: Boolean(grokExe || xaiKey),
            healthy: Boolean(grokExe || xaiKey),
            mode: grokExe ? "local_cli" : xaiKey ? "remote_api" : "unavailable",
            detail: grokExe
                ? `Local Grok Build CLI ready (${grokExe})`
                : xaiKey
                    ? "xAI API key configured (CLI fallback)"
                    : "Install Grok CLI (~/.grok/bin/grok.exe) or set xAI API key",
            binaryPath: grokExe,
            defaultModel: DEFAULT_MODEL_BY_PROVIDER.grok,
            models: PROVIDER_MODEL_SUGGESTIONS.grok,
            sessionCount: countSessions("grok"),
        },
    };

    return {
        ok: true,
        checkedAt: Date.now(),
        providers,
    };
}

export async function listProviderModels(
    _event: IpcMainInvokeEvent,
    args: { provider: ProviderKind; apiKey?: string; baseUrl?: string; },
): Promise<{
    ok: boolean;
    provider: ProviderKind;
    models: string[];
    defaultModel: string;
    error?: string;
}> {
    const provider = normalizeProvider(args?.provider);
    const defaultModel = DEFAULT_MODEL_BY_PROVIDER[provider];
    const suggestions = [...(PROVIDER_MODEL_SUGGESTIONS[provider] || [defaultModel])];

    if (provider === "nvidia" || provider === "openai" || provider === "grok") {
        const apiKey = (
            args?.apiKey ||
            (provider === "nvidia"
                ? process.env.NVIDIA_API_KEY || process.env.NGC_API_KEY
                : provider === "grok"
                    ? process.env.XAI_API_KEY || process.env.GROK_API_KEY
                    : process.env.OPENAI_API_KEY) ||
            ""
        ).trim();
        const baseUrl = (
            args?.baseUrl ||
            (provider === "nvidia"
                ? DEFAULT_NVIDIA_BASE_URL
                : provider === "grok"
                    ? DEFAULT_XAI_BASE_URL
                    : process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL)
        ).trim();
        const isLocalEndpoint = provider === "openai" && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(baseUrl);

        if (provider === "grok" && !apiKey) {
            const grokExe = findGrokExecutable();
            if (grokExe) {
                try {
                    const res = await runHiddenSubprocess({
                        executable: grokExe,
                        args: ["models"],
                        timeoutMs: 5000,
                    });
                    const cliModels: string[] = [];
                    for (const line of res.stdout.split(/\r?\n/)) {
                        const m = line.match(/^\s{2,4}(grok-[a-z0-9._-]+)\b/i);
                        if (m && m[1]) cliModels.push(m[1]);
                    }
                    if (cliModels.length > 0) {
                        const merged = Array.from(new Set([...cliModels, ...suggestions]));
                        return { ok: true, provider, models: merged, defaultModel };
                    }
                } catch {
                    // Fall back to curated suggestions
                }
            }
        }

        if (apiKey || isLocalEndpoint) {
            const modelsUrl = normalizeModelsEndpointUrl(baseUrl);
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 6000);
            try {
                const headers: Record<string, string> = {
                    Accept: "application/json",
                };
                if (apiKey) {
                    headers.Authorization = `Bearer ${apiKey}`;
                }
                const res = await fetch(modelsUrl, {
                    method: "GET",
                    headers,
                    signal: controller.signal,
                });
                if (res.ok) {
                    const data = (await res.json()) as { data?: Array<{ id?: string; }>; };
                    const remoteIds = (data.data || [])
                        .map(item => String(item?.id || "").trim())
                        .filter(Boolean);
                    if (remoteIds.length > 0) {
                        const merged = Array.from(new Set([...suggestions, ...remoteIds.slice(0, 60)]));
                        return { ok: true, provider, models: merged, defaultModel };
                    }
                }
            } catch {
                // Fall back to curated suggestions
            } finally {
                clearTimeout(timer);
            }
        }
    }

    return {
        ok: true,
        provider,
        models: suggestions,
        defaultModel,
    };
}

export async function getSessionInfo(
    _event: IpcMainInvokeEvent,
    args?: { channelId?: string; },
): Promise<{
    ok: boolean;
    sessions: ChannelSessionRecord[];
}> {
    ensureSessionsLoaded();
    const filterChannel = args?.channelId ? String(args.channelId).trim() : "";
    const sessions = Array.from(sessionStore.values()).filter(
        s => !filterChannel || s.channelId === filterChannel
    );
    return { ok: true, sessions };
}
