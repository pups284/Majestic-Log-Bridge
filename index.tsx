/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { addMessageAccessory, removeMessageAccessory } from "@api/MessageAccessories";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { LogIcon } from "@components/Icons";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { Menu, showToast } from "@webpack/common";

const Native = VencordNative.pluginHelpers.MajesticLogBridge as PluginNative<typeof import("./native")>;

const logger = new Logger("MajesticLogBridge");
const ACCESSORY_ID = "MajesticLogBridge";

interface LogAttachment {
    url: string;
    filename: string;
}

const settings = definePluginSettings({
    autoOpen: {
        type: OptionType.BOOLEAN,
        description: "Open the first received log in the viewer",
        default: true,
    },
    showInlineButton: {
        type: OptionType.BOOLEAN,
        description: "Show an inline button under messages with log attachments",
        default: true,
    },
    appPath: {
        type: OptionType.STRING,
        description: "Custom path to MajesticLogAnalyzer.exe (leave empty for auto-detect)",
        default: "",
    },
});

function isLogAttachment(name: string | undefined): boolean {
    return !!name && /\.(?:log|txt)$/i.test(name);
}

function findLogAttachments(message: Message): LogAttachment[] {
    const seen = new Set<string>();
    const result: LogAttachment[] = [];

    const add = (attachments?: LogAttachment[]) => {
        for (const attachment of attachments ?? []) {
            if (!attachment?.url || !isLogAttachment(attachment.filename)) continue;
            if (seen.has(attachment.url)) continue;
            seen.add(attachment.url);
            result.push(attachment);
        }
    };

    add(message.attachments as LogAttachment[]);

    const plain = message as Message & {
        referenced_message?: { attachments?: LogAttachment[]; };
        messageSnapshots?: Array<{ message?: { attachments?: LogAttachment[]; }; }>;
    };
    add(plain.referenced_message?.attachments);
    for (const snapshot of plain.messageSnapshots ?? []) {
        add(snapshot?.message?.attachments);
    }

    return result;
}

async function openLogs(attachments: LogAttachment[]) {
    try {
        showToast({ text: `Загружаю логи (${attachments.length})…`, icon: LogIcon });
        await Native.openLogs(
            attachments.map(({ url, filename }) => ({ url, filename })),
            settings.store.autoOpen,
            settings.store.appPath.trim(),
        );
        showToast({ text: "Логи открыты в Majestic Log Analyzer", variant: "success" });
    } catch (error) {
        logger.error("Failed to open logs", error);
        showToast({
            text: `Не удалось открыть логи: ${error instanceof Error ? error.message : String(error)}`,
            variant: "critical",
        });
    }
}

const patchMessageContextMenu: NavContextMenuPatchCallback = (children, props) => {
    const message = props?.message as Message | undefined;
    if (!message) return;

    const attachments = findLogAttachments(message);
    if (!attachments.length) return;

    const group = findGroupChildrenByChildId("copy-text", children) ?? children;
    group.push(
        <Menu.MenuGroup key="majestic-log-bridge-group">
            <Menu.MenuItem
                id="majestic-log-bridge-open"
                label={`Открыть логи в Majestic Log Analyzer (${attachments.length})`}
                leadingAccessory={{ type: "icon", icon: LogIcon }}
                action={() => void openLogs(attachments)}
            />
        </Menu.MenuGroup>,
    );
};

function LogAccessory({ message }: { message: Message }) {
    if (!settings.store.showInlineButton) return null;

    const attachments = findLogAttachments(message);
    if (!attachments.length) return null;

    return (
        <div style={{ marginTop: 4 }}>
            <Button
                size="small"
                variant="secondary"
                onClick={() => void openLogs(attachments)}
            >
                Открыть логи в Majestic Log Analyzer
            </Button>
        </div>
    );
}

export default definePlugin({
    name: "MajesticLogBridge",
    description: "Open log attachments from Discord directly in Majestic Log Analyzer",
    authors: [{ name: "pups284", id: 0n }],
    tags: ["Utility"],
    enabledByDefault: true,
    dependencies: ["MessageAccessoriesAPI"],
    settings,
    contextMenus: {
        message: patchMessageContextMenu,
    },

    start() {
        addMessageAccessory(ACCESSORY_ID, props => <LogAccessory message={props.message as Message} />);
    },

    stop() {
        removeMessageAccessory(ACCESSORY_ID);
    },
});
