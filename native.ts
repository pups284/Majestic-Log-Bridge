/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { IpcMainInvokeEvent } from "electron";

const LOG_ANALYZER_PIPE = String.raw`\\.\pipe\MajesticLogAnalyzer_SingleInstance`;
const TEMP_DIR = join(tmpdir(), "majestic-log-analyzer");

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 32;
const MAX_TEMP_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const ALLOWED_URL = /^https:\/\/(?:[a-z0-9-]+\.)*(?:discordapp\.com|discordapp\.net|discord\.com)\//i;
const LOG_NAME = /\.(?:log|txt)$/i;

interface Attachment {
    url: string;
    filename: string;
}

interface LoadedLog {
    name: string;
    path: string;
}

function safeName(name: string): string {
    const clean = basename(name || "discord.log").replace(/[^\w\-. ()]+/g, "_").slice(0, 180);
    if (!clean) return "discord.log";
    return LOG_NAME.test(clean) ? clean : `${clean}.log`;
}

function appCandidates(customPath: string): string[] {
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env.LOCALAPPDATA || "";

    return [
        customPath,
        process.env.MAJESTIC_LOG_ANALYZER_PATH || "",
        localAppData && join(localAppData, "Programs", "Majestic Log Analyzer", "MajesticLogAnalyzer.exe"),
        join(programFiles, "Majestic Log Analyzer", "MajesticLogAnalyzer.exe"),
        join(programFilesX86, "Majestic Log Analyzer", "MajesticLogAnalyzer.exe"),
    ].filter((path): path is string => !!path && existsSync(path));
}

function launchApp(customPath: string): void {
    const candidates = appCandidates(customPath);
    if (!candidates.length) {
        throw new Error("Majestic Log Analyzer is not installed (set the app path in the plugin settings)");
    }

    const newest = !customPath && !process.env.MAJESTIC_LOG_ANALYZER_PATH;
    const executable = newest
        ? candidates.reduce((best, candidate) => {
            try {
                return statSync(candidate).mtimeMs > statSync(best).mtimeMs ? candidate : best;
            } catch {
                return best;
            }
        }, candidates[0])
        : candidates[0];

    spawn(executable, [], { detached: true, stdio: "ignore" }).unref();
}

function sendToPipe(payload: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const socket = connect(LOG_ANALYZER_PIPE);
        let settled = false;

        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            error ? reject(error) : resolve();
        };

        socket.setTimeout(3000, () => finish(new Error("Timed out while contacting Majestic Log Analyzer")));
        socket.once("error", finish);
        socket.once("connect", () => {
            socket.write(payload, "utf8", error => finish(error ?? undefined));
        });
    });
}

async function deliver(payload: string, customPath: string): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            await sendToPipe(payload);
            return;
        } catch {
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }

    launchApp(customPath);

    const deadline = Date.now() + 20000;
    let lastError: unknown;

    while (Date.now() < deadline) {
        try {
            await sendToPipe(payload);
            return;
        } catch (error) {
            lastError = error;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }

    throw lastError instanceof Error ? lastError : new Error("Could not reach Majestic Log Analyzer");
}

async function cleanupOldTempFiles(): Promise<void> {
    try {
        const entries = await readdir(TEMP_DIR, { withFileTypes: true });
        const cutoff = Date.now() - MAX_TEMP_AGE_MS;
        await Promise.all(entries
            .filter(entry => entry.name.startsWith("discord_"))
            .map(async entry => {
                const path = join(TEMP_DIR, entry.name);
                try {
                    const { mtimeMs } = await stat(path);
                    if (mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
                } catch { }
            }));
    } catch { }
}

export async function openLogs(
    _event: IpcMainInvokeEvent,
    attachments: Attachment[],
    autoOpen = true,
    customAppPath = "",
): Promise<string[]> {
    if (!Array.isArray(attachments) || attachments.length === 0) {
        throw new Error("No attachments selected");
    }
    if (attachments.length > MAX_FILES) {
        throw new Error("Too many attachments selected");
    }
    if (process.platform !== "win32") {
        throw new Error("Majestic Log Analyzer is only available on Windows");
    }

    await mkdir(TEMP_DIR, { recursive: true });
    await cleanupOldTempFiles();

    const files: LoadedLog[] = [];
    const errors: string[] = [];
    let totalBytes = 0;

    for (const attachment of attachments) {
        const name = safeName(attachment?.filename || "");
        if (!LOG_NAME.test(name)) continue;

        try {
            if (typeof attachment?.url !== "string" || !ALLOWED_URL.test(attachment.url)) {
                throw new Error("untrusted URL");
            }

            const response = await fetch(attachment.url, { redirect: "follow" });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const declaredSize = Number(response.headers.get("content-length") || 0);
            if (declaredSize > MAX_FILE_BYTES) {
                throw new Error("file is too large");
            }

            const data = Buffer.from(await response.arrayBuffer());
            if (data.length > MAX_FILE_BYTES) {
                throw new Error("file is too large");
            }
            if (totalBytes + data.length > MAX_TOTAL_BYTES) {
                throw new Error("total size is too large");
            }

            const dir = join(
                TEMP_DIR,
                `discord_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            );
            await mkdir(dir, { recursive: true });
            const path = join(dir, name);
            await writeFile(path, data);
            totalBytes += data.length;
            files.push({ name, path });
        } catch (error) {
            errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    if (files.length === 0) {
        throw new Error(errors[0] ? `Could not download logs (${errors[0]})` : "No log attachments found");
    }

    const payload = JSON.stringify({
        version: 1,
        type: "open_logs",
        source: "discord",
        auto_open: Boolean(autoOpen),
        files,
    }) + "\n";

    await deliver(payload, customAppPath);
    return files.map(file => file.name);
}
